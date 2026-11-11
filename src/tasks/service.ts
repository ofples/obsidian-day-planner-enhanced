import { get, writable } from "svelte/store";

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
}

export class TaskService {
  readonly state = writable<TaskBrowserState>({
    snapshot: null,
    connected: false,
    loading: false,
    error: "",
  });
  private cache!: TaskCache;
  private lastSaved: string | null = null;
  private generation = 0;
  private pending?: Promise<void>;
  private closed = false;

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
    this.state.set({
      snapshot: this.cache.snapshot,
      connected: Boolean(this.storage.getSecret(this.secretKey())),
      loading: false,
      error: "",
    });
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
      this.state.set({ snapshot, connected: true, loading: false, error: "" });
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
    });
  }

  private async refreshSnapshot(token: string, generation: number) {
    try {
      const snapshot = await this.provider(token).read();
      if (!this.isCurrent(generation)) return;
      if (snapshot.account.id !== this.cache.snapshot?.account.id)
        throw new Error(
          "This credential now belongs to another account. Reconnect to choose that account.",
        );
      const cache = { ...this.cache, snapshot };
      await this.save(cache);
      if (!this.isCurrent(generation)) return;
      this.cache = cache;
      this.state.set({ snapshot, connected: true, loading: false, error: "" });
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
    }));
  }

  stop() {
    this.closed = true;
    this.generation++;
  }
}
