import { get, writable } from "svelte/store";

import {
  reviewTaskConflict,
  taskConflictMutations,
  type TaskConflictChoices,
  type TaskConflictReview,
} from "./conflict";
import { pendingTaskDeletion } from "./deletion-types";
import {
  isOutstanding,
  operationTaskId,
  sameTaskField,
  taskMutationSchema,
  type TaskMutation,
  type TaskOperation,
} from "./operations";
import { pendingSnapshot, TaskQueue } from "./queue";
import { TaskRegistry, type TaskSource } from "./registry";
import {
  TaskReadError,
  taskCacheSchema,
  type ProviderTask,
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
    const deletedIds = new Set(
      owned
        .filter(
          (operation) =>
            operation.status === "complete" &&
            operation.mutation.kind === "delete",
        )
        .flatMap((operation) =>
          Object.entries(operation.deletionReadback ?? {})
            .filter(([, task]) => task === null)
            .map(([id]) => id),
        ),
    );
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
          !deletedIds.has(operationTaskId(operation)) &&
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
    intent?: {
      id: string;
      base: import("./types").ProviderTask;
      provider: string;
      accountId: string;
      reuseCompletion?: boolean;
    },
  ): Promise<TaskOperation> {
    const snapshot = this.cache.snapshot;
    if (this.closed || !snapshot || !get(this.state).writable)
      throw new TaskReadError(
        "Connect a task account with editing access first.",
        undefined,
        true,
      );
    const mutation = taskMutationSchema.parse(input);
    if (
      mutation.kind === "delete" &&
      (!snapshot.account.capabilities?.delete ||
        !this.provider(this.storage.getSecret(this.secretKey()) ?? "").get)
    )
      throw new TaskReadError(
        "Refresh a provider connection that supports verified task deletion.",
      );
    if (
      intent &&
      (intent.provider !== snapshot.provider ||
        intent.accountId !== snapshot.account.id ||
        mutation.kind === "create" ||
        intent.base.id !== mutation.taskId)
    )
      throw new TaskReadError(
        "This saved change belongs to another task account or task.",
      );
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
    if (mutation.kind !== "create" && !base && !intent?.base)
      throw new TaskReadError("Refresh this task before editing it.");
    const savedBase = intent?.base ?? base;
    if (
      mutation.kind === "complete" &&
      savedBase?.due?.recurring &&
      savedBase.completionCount === undefined
    )
      throw new TaskReadError(
        "Refresh this recurring task to load its occurrence before completing it.",
      );
    const operation = await this.registry.change((state) => {
      if (intent) {
        const saved = state.operations.find((item) => item.id === intent.id);
        if (saved) {
          if (
            JSON.stringify(saved.mutation) !== JSON.stringify(mutation) ||
            saved.provider !== intent.provider ||
            saved.accountId !== intent.accountId
          )
            throw new TaskReadError(
              "The saved operation has different task fields. Review it before retrying.",
            );
          return saved;
        }
      }
      if (mutation.kind === "complete" && savedBase?.due?.recurring) {
        const pending = state.operations.find(
          (item) =>
            item.provider === snapshot.provider &&
            item.accountId === snapshot.account.id &&
            operationTaskId(item) === mutation.taskId &&
            item.mutation.kind === "complete" &&
            isOutstanding(item),
        );
        if (pending) {
          if (
            (!intent || intent.reuseCompletion) &&
            pending.base?.completionCount === savedBase.completionCount &&
            sameTaskField(pending.base?.due, savedBase.due, "due")
          )
            return pending;
          throw new TaskReadError(
            "Finish this task's saved recurring completion before completing another occurrence.",
          );
        }
      }
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
          noteBase: source.value,
          base: null,
        };
      }
      const owner = {
        provider: snapshot.provider,
        accountId: snapshot.account.id,
      };
      const targetId =
        mutation.kind === "create" ? mutation.task.parentId : mutation.taskId;
      const parentId =
        mutation.kind === "moveParent" ? mutation.parentId : null;
      if (
        (targetId &&
          pendingTaskDeletion(
            state,
            owner,
            targetId,
            mutation.kind === "delete" ? intent?.id : undefined,
          )) ||
        (parentId && pendingTaskDeletion(state, owner, parentId))
      )
        throw new TaskReadError(
          "Finish this task tree's saved deletion before editing it.",
        );
      if (mutation.kind === "delete") {
        const record = intent && state.deletions[intent.id];
        if (
          !record ||
          record.taskId !== mutation.taskId ||
          record.provider !== snapshot.provider ||
          record.accountId !== snapshot.account.id ||
          !["pending", "queued"].includes(record.phase)
        )
          throw new TaskReadError(
            "Confirm this task's deletion and recovery record before sending it.",
          );
      }
      const saved: TaskOperation = {
        id: intent?.id ?? crypto.randomUUID(),
        tempId: crypto.randomUUID(),
        provider: snapshot.provider,
        accountId: snapshot.account.id,
        mutation,
        base: savedBase,
        recurringCompletion:
          mutation.kind === "complete" && savedBase?.due?.recurring
            ? {
                resetSubtasks:
                  snapshot.account.preferences?.resetRecurringSubtasks ?? false,
              }
            : undefined,
        status: "pending",
        attempts: 0,
        createdAt: new Date().toISOString(),
        sourceUid: source?.uid,
      };
      state.operations.push(saved);
      if (mutation.kind === "delete")
        state.deletions[saved.id]!.phase = "queued";
      return saved;
    });
    this.publish();
    this.requestRefresh();
    return operation;
  }

  async complete(task: ProviderTask) {
    const snapshot = get(this.state).snapshot;
    if (!snapshot)
      throw new TaskReadError("Refresh this task before completing it.");
    return this.mutate({ kind: "complete", taskId: task.id }, undefined, {
      id: crypto.randomUUID(),
      base: structuredClone(task),
      provider: snapshot.provider,
      accountId: snapshot.account.id,
      reuseCompletion: true,
    });
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

  async inspectConflict(id: string): Promise<TaskConflictReview> {
    await this.pending;
    const generation = this.generation;
    const operation = this.registry
      .snapshot()
      .operations.find((item) => item.id === id);
    const snapshot = this.cache.snapshot;
    if (operation?.mutation.kind === "delete")
      throw new TaskReadError(
        "Review this task's deletion recovery record before confirming another deletion.",
      );
    if (
      !operation ||
      operation.status !== "conflict" ||
      operation.provider !== snapshot?.provider ||
      operation.accountId !== snapshot.account.id ||
      !get(this.state).writable
    )
      throw new TaskReadError(
        "Reconnect the original account and refresh this saved conflict.",
      );
    const token = this.storage.getSecret(this.secretKey());
    if (!token)
      throw new TaskReadError(
        "Reconnect the task account before reviewing this change.",
      );
    const provider = this.provider(token);
    const fresh = await provider.read();
    if (
      !this.isCurrent(generation) ||
      fresh.provider !== operation.provider ||
      fresh.account.id !== operation.accountId
    )
      throw new TaskReadError(
        "The task account changed. Open this comparison again.",
      );
    const idToRead =
      operation.remoteId ??
      (operation.mutation.kind === "create" ? null : operation.mutation.taskId);
    const current = idToRead
      ? provider.get
        ? await provider.get(idToRead)
        : (fresh.tasks.find((task) => task.id === idToRead) ?? null)
      : null;
    if (!this.isCurrent(generation) || !get(this.state).writable)
      throw new TaskReadError(
        "The task account disconnected during the comparison.",
      );
    if (current && current.id !== idToRead)
      throw new TaskReadError(
        "The provider returned a different task. Refresh before resolving this change.",
      );
    return reviewTaskConflict(operation, current);
  }

  async readTask(id: string) {
    const generation = this.generation;
    const owner = this.cache.snapshot;
    const token = this.storage.getSecret(this.secretKey());
    if (!owner || !token || !get(this.state).writable)
      throw new TaskReadError(
        "Reconnect the task account before reading its linked task.",
      );
    const provider = this.provider(token);
    const fresh = await provider.read();
    if (
      !this.isCurrent(generation) ||
      fresh.provider !== owner.provider ||
      fresh.account.id !== owner.account.id
    )
      throw new TaskReadError(
        "The task account changed during reconciliation.",
      );
    const task = provider.get
      ? await provider.get(id)
      : (fresh.tasks.find((item) => item.id === id) ?? null);
    if (
      !this.isCurrent(generation) ||
      !get(this.state).writable ||
      (task && task.id !== id)
    )
      throw new TaskReadError(
        "Refresh the original task account before reconciling its note.",
      );
    return task;
  }

  async resolveConflict(
    review: TaskConflictReview,
    choices: TaskConflictChoices,
  ): Promise<
    | { kind: "changed"; review: TaskConflictReview }
    | { kind: "saved"; operationIds: string[] }
  > {
    const current = await this.inspectConflict(review.operation.id);
    if (
      JSON.stringify(current.operation) !== JSON.stringify(review.operation) ||
      JSON.stringify(current.current) !== JSON.stringify(review.current)
    )
      return { kind: "changed", review: current };
    const planned = taskConflictMutations(current, choices);
    if (
      this.cache.snapshot?.account.capabilities?.duration === false &&
      planned.some(
        (item) =>
          item.mutation.kind === "update" && item.mutation.changes.duration,
      )
    )
      throw new TaskReadError(
        "This provider account cannot save duration. Keep the current provider duration.",
      );
    const replacements: TaskOperation[] = planned.map((item) => ({
      id: crypto.randomUUID(),
      tempId: crypto.randomUUID(),
      provider: current.operation.provider,
      accountId: current.operation.accountId,
      ...item,
      status: "pending",
      attempts: 0,
      createdAt: new Date().toISOString(),
    }));
    const generation = this.generation;
    await this.registry.change((state) => {
      const index = state.operations.findIndex(
        (item) => item.id === current.operation.id,
      );
      if (
        !this.isCurrent(generation) ||
        !get(this.state).writable ||
        JSON.stringify(state.operations[index]) !==
          JSON.stringify(current.operation)
      )
        throw new TaskReadError(
          "This saved conflict changed. Open its latest comparison.",
        );
      const original = state.operations[index]!;
      original.status = "cancelled";
      original.resolutionIds = replacements.map((item) => item.id);
      original.readback = current.current ?? undefined;
      original.error = undefined;
      state.operations.splice(index + 1, 0, ...replacements);
      const link = original.sourceUid && state.links[original.sourceUid];
      if (link && current.current) {
        link.taskId = current.current.id;
        if (!link.base && original.mutation.kind === "create")
          link.base = { ...current.current, ...original.mutation.task };
      }
    });
    this.publish();
    this.requestRefresh();
    return { kind: "saved", operationIds: replacements.map((item) => item.id) };
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
    this.state.update((state) => ({
      ...state,
      writable: false,
      loading: false,
    }));
  }
}
