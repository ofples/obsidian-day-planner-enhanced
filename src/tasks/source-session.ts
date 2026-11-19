import { get, writable } from "svelte/store";

import { SourceActionRejectedError } from "./source-errors";
import type { SourceCoverage } from "./source-pages";
import { resolveSourceTask } from "./source-references";
import type { TaskSourceReference } from "./source-types";
import { TaskReadError, type ProviderTask, type TaskSnapshot } from "./types";

export interface SourceReadResult {
  snapshot: TaskSnapshot;
  coverage: SourceCoverage;
}

export interface TaskSourceBackend {
  readonly refreshAfterCompletion?: boolean;
  connected(): boolean;
  accountId?(): string | undefined;
  connect(): Promise<SourceReadResult>;
  read(previous?: SourceReadResult): Promise<SourceReadResult>;
  disconnect(): void;
  cancel(): void;
  retry?(): void;
  complete?(task: ProviderTask): Promise<ProviderTask>;
  get?(task: ProviderTask): Promise<ProviderTask | null>;
}

export interface TaskSourceSessionState {
  snapshot: TaskSnapshot | null;
  coverage: SourceCoverage | null;
  connected: boolean;
  loading: boolean;
  error: string;
  retryAt?: number;
  needsReconnect?: boolean;
  verificationRequired: string[];
}

export interface TaskSourceCacheStorage {
  read(): Promise<{
    snapshot: TaskSnapshot;
    coverage: SourceCoverage;
    verificationRequired: string[];
  } | null>;
  write(
    value: {
      snapshot: TaskSnapshot;
      coverage: SourceCoverage;
      verificationRequired: string[];
    } | null,
  ): Promise<void>;
}

/** Read cache plus explicit commands; no source ownership or background mutation queue. */
export class TaskSourceSession {
  readonly state = writable<TaskSourceSessionState>({
    snapshot: null,
    coverage: null,
    connected: false,
    loading: false,
    error: "",
    verificationRequired: [],
  });
  private generation = 0;
  private closed = false;
  private pending?: Promise<void>;
  private mutation?: Promise<void>;
  private saveTail: Promise<void> = Promise.resolve();

  constructor(
    readonly provider: string,
    private readonly backend: TaskSourceBackend,
    private readonly storage: TaskSourceCacheStorage,
  ) {}

  private isCurrent(generation: number) {
    return !this.closed && generation === this.generation;
  }

  async initialize() {
    const generation = this.generation;
    try {
      const cached = await this.storage.read();
      if (!this.isCurrent(generation)) return;
      const connected = this.backend.connected();
      const accountId = this.backend.accountId?.();
      this.state.update((value) => ({
        ...value,
        ...(connected &&
        cached?.snapshot.provider === this.provider &&
        (!this.backend.accountId || accountId === cached.snapshot.account.id)
          ? cached
          : {}),
        connected,
      }));
    } catch (error) {
      if (this.isCurrent(generation)) {
        this.state.update((value) => ({
          ...value,
          connected: this.isConnected(),
        }));
        this.fail(error);
      }
    }
  }

  connect() {
    return this.runRead(true);
  }

  isConnected() {
    try {
      return this.backend.connected();
    } catch {
      return false;
    }
  }

  accountId() {
    try {
      return this.backend.accountId?.();
    } catch {
      return undefined;
    }
  }

  refresh(manual = false, more = false) {
    if (!this.backend.connected()) return Promise.resolve();
    if (manual && !this.pending) this.backend.retry?.();
    const current = get(this.state);
    if (
      !manual &&
      current.snapshot &&
      current.coverage &&
      Date.now() - Date.parse(current.snapshot.fetchedAt) < 300_000
    )
      return Promise.resolve();
    return this.runRead(false, more);
  }

  private runRead(connect: boolean, more = false) {
    if (this.pending) return this.pending;
    if (this.closed) return Promise.resolve();
    const generation = this.generation;
    const old = get(this.state);
    this.state.update((value) => ({ ...value, loading: true, error: "" }));
    const pending = (async () => {
      try {
        await this.mutation;
        if (!this.isCurrent(generation)) return;
        const current = get(this.state);
        const previous =
          more && current.snapshot && current.coverage
            ? { snapshot: current.snapshot, coverage: current.coverage }
            : undefined;
        const result = connect
          ? await this.backend.connect()
          : await this.backend.read(previous);
        if (!this.isCurrent(generation)) return;
        if (result.snapshot.provider !== this.provider)
          throw new TaskReadError("The source returned a different provider.");
        if (
          !connect &&
          old.snapshot &&
          old.snapshot.account.id !== result.snapshot.account.id
        ) {
          this.state.update((value) => ({
            ...value,
            snapshot: null,
            coverage: null,
            verificationRequired: [],
          }));
          throw new TaskReadError(
            "This source account changed. Sign in again.",
            undefined,
            true,
          );
        }
        if (
          !connect &&
          current.snapshot?.account.id === result.snapshot.account.id
        ) {
          const incomplete = new Set(
            result.coverage.streams
              .filter((stream) => !stream.complete)
              .map((stream) => stream.containerId),
          );
          const tasks = new Map(
            result.snapshot.tasks.map((task) => [task.id, task]),
          );
          const projects = new Map(
            result.snapshot.projects.map((project) => [project.id, project]),
          );
          for (const task of current.snapshot.tasks)
            if (
              !(
                task.source?.private &&
                result.snapshot.account.capabilities?.privateAccess === false
              ) &&
              (incomplete.has(task.projectId) ||
                task.source?.memberships?.some((member) =>
                  incomplete.has(member.containerId),
                )) &&
              !tasks.has(task.id)
            )
              tasks.set(task.id, task);
          const usedProjects = new Set(
            [...tasks.values()].map((task) => task.projectId),
          );
          for (const project of current.snapshot.projects)
            if (
              (incomplete.has(project.id) || usedProjects.has(project.id)) &&
              !projects.has(project.id)
            )
              projects.set(project.id, project);
          result.snapshot = {
            ...result.snapshot,
            tasks: [...tasks.values()],
            projects: [...projects.values()],
          };
        }
        this.state.update((value) => ({
          ...value,
          ...result,
          connected: true,
          loading: false,
          needsReconnect: false,
          retryAt: undefined,
          verificationRequired:
            connect && old.snapshot?.account.id !== result.snapshot.account.id
              ? []
              : value.verificationRequired,
        }));
        await this.save();
      } catch (error) {
        if (this.isCurrent(generation)) this.fail(error);
      } finally {
        if (generation === this.generation)
          this.state.update((value) => ({ ...value, loading: false }));
      }
    })().finally(() => {
      if (this.pending === pending) this.pending = undefined;
    });
    this.pending = pending;
    return pending;
  }

  private fail(error: unknown) {
    this.state.update((value) => ({
      ...value,
      error:
        error instanceof Error ? error.message : "This source request failed.",
      ...(error instanceof TaskReadError
        ? { retryAt: error.retryAt, needsReconnect: error.needsReconnect }
        : {}),
    }));
  }

  private save() {
    const { snapshot, coverage, verificationRequired } = get(this.state);
    const value =
      snapshot && coverage
        ? structuredClone({ snapshot, coverage, verificationRequired })
        : null;
    const pending = this.saveTail.then(() => this.storage.write(value));
    this.saveTail = pending.catch(() => {});
    return pending;
  }

  complete(ref: TaskSourceReference) {
    if (this.mutation)
      return Promise.reject(
        new TaskReadError("Finish the current source action first."),
      );
    if (this.pending)
      return Promise.reject(
        new TaskReadError(
          "Refresh is still running. Complete this task when it finishes.",
        ),
      );
    const state = get(this.state);
    const resolved = resolveSourceTask(
      state.snapshot ? [state.snapshot] : [],
      ref,
    );
    if (
      this.closed ||
      !state.connected ||
      !resolved ||
      !this.backend.complete ||
      !state.snapshot?.account.capabilities?.complete
    )
      return Promise.reject(
        new TaskReadError(
          "This source does not currently allow task completion.",
        ),
      );
    if (state.verificationRequired.includes(resolved.task.id))
      return this.verify(ref);
    const generation = this.generation;
    const task = resolved.task;
    let confirmed = false;
    const pending = (async () => {
      this.state.update((value) => ({
        ...value,
        verificationRequired: [...value.verificationRequired, task.id],
      }));
      this.replace({ ...task, completed: true });
      let prepared = false;
      let current: ProviderTask;
      try {
        // Persist uncertainty before sending. A restart may verify, never replay, this action.
        await this.save();
        if (!this.isCurrent(generation)) return;
        prepared = true;
        current = await this.backend.complete!(task);
      } catch (error) {
        if (!this.isCurrent(generation)) return;
        this.replace(task);
        if (
          !prepared ||
          error instanceof SourceActionRejectedError ||
          (error instanceof TaskReadError &&
            error.status !== undefined &&
            [400, 401, 403, 404, 410, 412, 422, 429].includes(error.status))
        )
          this.clearVerification(task.id);
        this.fail(error);
        await this.save();
        return;
      }
      if (!this.isCurrent(generation)) return;
      confirmed = true;
      this.replace(current);
      this.clearVerification(task.id);
      // A cache failure after confirmation must not undo the source's confirmed result.
      await this.save();
    })()
      .catch((error: unknown) => {
        if (this.isCurrent(generation)) this.fail(error);
      })
      .finally(() => {
        if (this.mutation === pending) this.mutation = undefined;
      });
    this.mutation = pending;
    return pending.then(() =>
      confirmed &&
      this.backend.refreshAfterCompletion &&
      this.isCurrent(generation)
        ? this.refresh(true)
        : undefined,
    );
  }

  verify(ref: TaskSourceReference) {
    if (this.mutation) return this.mutation;
    const state = get(this.state);
    const resolved = resolveSourceTask(
      state.snapshot ? [state.snapshot] : [],
      ref,
    );
    if (!resolved || !this.backend.get) return Promise.resolve();
    const generation = this.generation;
    let confirmed = false;
    const pending = (async () => {
      try {
        const current = await this.backend.get!(resolved.task);
        if (!this.isCurrent(generation)) return;
        if (current) this.replace(current);
        else this.replace({ ...resolved.task, completed: true });
        confirmed = !current || current.completed;
        this.clearVerification(resolved.task.id);
        await this.save();
      } catch (error) {
        if (this.isCurrent(generation)) this.fail(error);
      }
    })().finally(() => {
      if (this.mutation === pending) this.mutation = undefined;
    });
    this.mutation = pending;
    return pending.then(() =>
      confirmed &&
      this.backend.refreshAfterCompletion &&
      this.isCurrent(generation)
        ? this.refresh(true)
        : undefined,
    );
  }

  private replace(task: ProviderTask) {
    this.state.update((value) => ({
      ...value,
      snapshot: value.snapshot
        ? {
            ...value.snapshot,
            tasks: value.snapshot.tasks.map((item) =>
              item.id === task.id ? task : item,
            ),
          }
        : null,
    }));
  }

  private clearVerification(id: string) {
    this.state.update((value) => ({
      ...value,
      error: "",
      verificationRequired: value.verificationRequired.filter(
        (item) => item !== id,
      ),
    }));
  }

  disconnect() {
    this.generation++;
    this.pending = undefined;
    this.mutation = undefined;
    this.backend.disconnect();
    this.state.set({
      snapshot: null,
      coverage: null,
      connected: false,
      loading: false,
      error: "",
      verificationRequired: [],
    });
    return this.save().catch((error: unknown) => this.fail(error));
  }

  cancel() {
    this.generation++;
    this.pending = undefined;
    this.backend.cancel();
    this.state.update((value) => ({ ...value, loading: false, error: "" }));
  }

  stop() {
    this.closed = true;
    this.generation++;
    this.backend.cancel();
    this.state.update((value) => ({
      ...value,
      connected: false,
      loading: false,
    }));
  }
}
