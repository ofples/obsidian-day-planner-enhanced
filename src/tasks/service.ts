import { get, writable } from "svelte/store";

import {
  isOutstanding,
  operationTaskId,
  taskMutationSchema,
  type TaskMutation,
  type TaskOperation,
} from "./operations";
import { pendingSnapshot, TaskQueue } from "./queue";
import { TaskRegistry, type TaskSource } from "./registry";
import {
  TaskReadError,
  taskCacheSchema,
  type TaskCache,
  type TaskProvider,
  type TaskSnapshot,
  type TaskStorage,
} from "./types";

export interface TaskBrowserState {
  snapshot: TaskSnapshot | null;
  connected: boolean;
  loading: boolean;
  error: string;
  retryAt?: number;
  needsReconnect?: boolean;
  operations: TaskOperation[];
  completed: import("./types").ProviderTask[];
  writable: boolean;
  aliases: Record<string, string>;
}

export class TaskService {
  readonly state = writable<TaskBrowserState>({
    snapshot: null,
    connected: false,
    loading: false,
    error: "",
    operations: [],
    completed: [],
    writable: false,
    aliases: {},
  });
  private cache!: TaskCache;
  private lastSaved: string | null = null;
  private generation = 0;
  private pending?: Promise<void>;
  private closed = false;
  private canWrite = false;
  private refreshAgain = false;
  registry!: TaskRegistry;
  private queue!: TaskQueue;

  constructor(
    private readonly storage: TaskStorage,
    private readonly provider: (token: string) => TaskProvider,
  ) {}

  private secretKey() {
    return `day-planner-tasks-${this.cache.namespace}-todoist`;
  }

  private isCurrent(generation: number) {
    return !this.closed && generation === this.generation;
  }

  async initialize() {
    this.lastSaved = await this.storage.read();
    this.cache =
      this.lastSaved === null
        ? {
            version: 1,
            namespace: crypto.randomUUID().replace(/-/g, ""),
            snapshot: null,
          }
        : taskCacheSchema.parse(JSON.parse(this.lastSaved));
    if (this.lastSaved === null) await this.save(this.cache);
    this.registry = new TaskRegistry(this.storage, this.cache.namespace);
    await this.registry.initialize();
    this.queue = new TaskQueue(this.registry, () => this.publish());
    const token = this.storage.getSecret(this.secretKey());
    this.canWrite = Boolean(token && this.provider(token).apply);
    this.publish({
      connected: Boolean(token),
      loading: false,
      error: "",
    });
  }

  private publish(patch: Partial<TaskBrowserState> = {}) {
    const snapshot = this.cache.snapshot;
    const owned = this.registry
      .snapshot()
      .operations.filter(
        (operation) =>
          operation.provider === snapshot?.provider &&
          operation.accountId === snapshot.account.id,
      );
    const operations = owned.filter(isOutstanding);
    const effective = pendingSnapshot(snapshot, operations);
    const latest = new Map(
      owned
        .filter((operation) => operation.status === "complete")
        .map((operation) => [operationTaskId(operation), operation]),
    );
    const completed = [...latest.values()]
      .filter(
        (operation) =>
          operation.status === "complete" &&
          operation.mutation.kind === "complete" &&
          operation.base &&
          !operation.base.due?.recurring &&
          !effective?.tasks.some(
            (task) => task.id === operationTaskId(operation) && !task.completed,
          ),
      )
      .map((operation) => ({
        ...operation.base!,
        id: operationTaskId(operation),
        completed: true,
      }));
    this.state.update((previous) => {
      const current = { ...previous, ...patch };
      return {
        ...current,
        snapshot: effective,
        operations,
        completed,
        writable: this.canWrite && current.connected,
        aliases: Object.fromEntries(
          owned
            .filter(
              (operation) =>
                operation.mutation.kind === "create" && operation.remoteId,
            )
            .map((operation) => [`local-${operation.id}`, operation.remoteId!]),
        ),
      };
    });
  }

  async mutate(
    input: TaskMutation,
    source?: { uid: string; value: TaskSource },
  ): Promise<TaskOperation> {
    const snapshot = this.cache.snapshot;
    if (this.closed || !snapshot || !get(this.state).writable)
      throw new TaskReadError(
        "Connect a task account with editing access first.",
        undefined,
        true,
      );
    const mutation = taskMutationSchema.parse(input);
    const duration =
      mutation.kind === "create"
        ? mutation.task.duration
        : mutation.kind === "update"
          ? mutation.changes.duration
          : undefined;
    if (duration && snapshot.account.capabilities?.duration === false)
      throw new TaskReadError(
        "This task account requires a paid plan for provider durations. Keep the planned duration in Day Planner.",
      );
    if (mutation.kind !== "create" && mutation.taskId.startsWith("local-"))
      throw new TaskReadError(
        "Wait for this task to finish creating before editing it.",
      );
    const current = get(this.state);
    const base =
      mutation.kind === "create"
        ? null
        : (current.snapshot?.tasks.find(
            (task) => task.id === mutation.taskId,
          ) ??
          current.completed.find((task) => task.id === mutation.taskId) ??
          null);
    if (mutation.kind !== "create" && !base)
      throw new TaskReadError("Refresh this task before editing it.");
    const operation = await this.registry.change((state) => {
      if (source) {
        const sameSourceUid = Object.entries(state.links).find(
          ([, link]) =>
            link.source.path === source.value.path &&
            link.source.from === source.value.from &&
            link.source.raw === source.value.raw,
        )?.[0];
        const sourceUid = sameSourceUid ?? source.uid;
        const existing = state.operations.find(
          (item) =>
            item.sourceUid === sourceUid &&
            item.mutation.kind === "create" &&
            item.status !== "cancelled",
        );
        if (existing) return existing;
        if (state.links[sourceUid]?.taskId)
          throw new TaskReadError("This note task is already linked.");
        state.links[source.uid] = {
          provider: snapshot.provider,
          accountId: snapshot.account.id,
          taskId: null,
          source: source.value,
          base: null,
        };
      }
      const saved: TaskOperation = {
        id: crypto.randomUUID(),
        tempId: crypto.randomUUID(),
        provider: snapshot.provider,
        accountId: snapshot.account.id,
        mutation,
        base,
        status: "pending",
        attempts: 0,
        createdAt: new Date().toISOString(),
        sourceUid: source?.uid,
      };
      state.operations.push(saved);
      return saved;
    });
    this.publish();
    this.requestRefresh();
    return operation;
  }

  async retryOperation(id: string) {
    const snapshot = this.cache.snapshot;
    const operation = this.registry
      .snapshot()
      .operations.find((item) => item.id === id);
    if (
      !operation ||
      operation.provider !== snapshot?.provider ||
      operation.accountId !== snapshot.account.id ||
      !isOutstanding(operation)
    )
      return;
    if (operation.status === "conflict")
      throw new TaskReadError(
        "Review the conflicting task fields before applying this change.",
      );
    await this.registry.updateOperation(id, {
      retryAt: undefined,
      error: undefined,
      status: operation.status === "failed" ? "pending" : operation.status,
    });
    this.publish();
    this.requestRefresh();
  }

  private requestRefresh() {
    if (this.pending) this.refreshAgain = true;
    else void this.refresh();
  }

  private async save(cache: TaskCache) {
    if ((await this.storage.read()) !== this.lastSaved)
      throw new Error(
        "Task state changed in another session. Reopen this vault before refreshing.",
      );
    const serialized = JSON.stringify(cache);
    await this.storage.write(serialized);
    this.lastSaved = serialized;
  }

  /** An account switch is explicit. Failed validation keeps the existing connection. */
  async connect(token: string, replaceAccount = false) {
    if (this.closed)
      throw new Error("Reopen the Tasks pane before connecting.");
    if (!token.trim()) throw new Error("Enter your Todoist API token.");
    if (this.pending)
      throw new Error("Wait for the current refresh to finish.");
    const generation = ++this.generation;
    this.state.update((s) => ({
      ...s,
      loading: true,
      error: "",
      retryAt: undefined,
    }));
    const operation = this.acceptConnection(
      token.trim(),
      replaceAccount,
      generation,
    );
    this.pending = operation;
    try {
      await operation;
    } finally {
      if (this.pending === operation) this.pending = undefined;
      if (this.refreshAgain) {
        this.refreshAgain = false;
        void this.refresh();
      }
    }
  }

  private async acceptConnection(
    token: string,
    replaceAccount: boolean,
    generation: number,
  ) {
    try {
      const snapshot = await this.provider(token).read();
      if (!this.isCurrent(generation)) return;
      if (
        this.cache.snapshot &&
        this.cache.snapshot.account.id !== snapshot.account.id &&
        !replaceAccount
      )
        throw new Error(
          `This token belongs to ${snapshot.account.name}. Choose Switch account to replace the connection.`,
        );
      const cache = { ...this.cache, snapshot };
      await this.save(cache);
      if (!this.isCurrent(generation)) return;
      this.storage.setSecret(this.secretKey(), token);
      this.cache = cache;
      this.canWrite = Boolean(this.provider(token).apply);
      this.publish({ connected: true, loading: false, error: "" });
      this.refreshAgain ||= this.registry
        .snapshot()
        .operations.some(
          (operation) =>
            operation.provider === snapshot.provider &&
            operation.accountId === snapshot.account.id &&
            ["pending", "sent", "acknowledged", "verified"].includes(
              operation.status,
            ),
        );
    } catch (error) {
      if (this.isCurrent(generation)) this.fail(error);
      throw error;
    }
  }

  refresh(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.pending) return this.pending;
    const token = this.storage.getSecret(this.secretKey());
    if (!token) return Promise.resolve();
    const state = get(this.state);
    if (state.retryAt && state.retryAt > Date.now()) return Promise.resolve();
    const generation = this.generation;
    this.state.update((s) => ({
      ...s,
      loading: true,
      error: "",
      retryAt: undefined,
    }));
    const operation = this.refreshSnapshot(token, generation);
    this.pending = operation;
    return operation.finally(() => {
      if (this.pending === operation) this.pending = undefined;
      if (this.refreshAgain) {
        this.refreshAgain = false;
        void this.refresh();
      }
    });
  }

  private async refreshSnapshot(token: string, generation: number) {
    try {
      const provider = this.provider(token);
      let snapshot = await provider.read();
      if (!this.isCurrent(generation)) return;
      if (snapshot.account.id !== this.cache.snapshot?.account.id)
        throw new Error(
          "This credential now belongs to another account. Reconnect to choose that account.",
        );
      snapshot = await this.queue.run(provider, snapshot, () =>
        this.isCurrent(generation),
      );
      if (!this.isCurrent(generation)) return;
      const cache = { ...this.cache, snapshot };
      await this.save(cache);
      if (!this.isCurrent(generation)) return;
      this.cache = cache;
      this.publish({ connected: true, loading: false, error: "" });
    } catch (error) {
      if (this.isCurrent(generation)) this.fail(error);
    }
  }

  private fail(error: unknown) {
    this.state.update((s) => ({
      ...s,
      loading: false,
      error:
        error instanceof TaskReadError
          ? error.message
          : error instanceof Error &&
              /another|account|session/.test(error.message)
            ? error.message
            : "Could not refresh tasks. Check your connection and try again.",
      retryAt: error instanceof TaskReadError ? error.retryAt : undefined,
      needsReconnect: error instanceof TaskReadError && error.needsReconnect,
    }));
  }

  disconnect() {
    this.generation++;
    this.storage.setSecret(this.secretKey(), "");
    this.state.update((s) => ({
      ...s,
      connected: false,
      loading: false,
      error: "",
      retryAt: undefined,
      writable: false,
    }));
  }

  stop() {
    this.closed = true;
    this.generation++;
  }
}
