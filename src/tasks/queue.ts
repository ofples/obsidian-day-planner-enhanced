import {
  isOutstanding,
  operationTaskId,
  preflightOperation,
  type TaskOperation,
} from "./operations";
import type { TaskRegistry } from "./registry";
import {
  TaskReadError,
  TaskWriteError,
  type TaskProvider,
  type TaskSnapshot,
} from "./types";

/** A sent command always reuses its saved payload and UUID, even after a lost response. */
export class TaskQueue {
  constructor(
    private readonly registry: TaskRegistry,
    private readonly changed: () => void,
  ) {}

  private async update(id: string, patch: Partial<TaskOperation>) {
    await this.registry.updateOperation(id, patch);
    this.changed();
  }

  async run(
    provider: TaskProvider,
    snapshot: TaskSnapshot,
    active: () => boolean,
  ): Promise<TaskSnapshot> {
    if (!provider.apply) return snapshot;
    const operations = this.registry
      .snapshot()
      .operations.filter(
        (operation) =>
          operation.provider === snapshot.provider &&
          operation.accountId === snapshot.account.id &&
          ["pending", "sent"].includes(operation.status),
      );
    const blocked = new Set<string>();
    for (const operation of operations) {
      const taskId = operationTaskId(operation);
      let sent = operation.status === "sent";
      if (!active()) return snapshot;
      if (blocked.has(taskId) || (operation.retryAt ?? 0) > Date.now())
        continue;
      try {
        await this.update(operation.id, { attempts: operation.attempts + 1 });
        if (operation.status === "pending") {
          const remote =
            operation.mutation.kind === "create"
              ? null
              : provider.get
                ? await provider.get(taskId)
                : (snapshot.tasks.find((task) => task.id === taskId) ?? null);
          if (!active()) return snapshot;
          const decision = preflightOperation(operation, remote);
          if (decision === "conflict") {
            await this.update(operation.id, {
              status: "conflict",
              error:
                "This task changed in Todoist. Review the saved change before applying it.",
            });
            blocked.add(taskId);
            continue;
          }
          if (decision === "already-applied") {
            await this.update(operation.id, {
              status: "acknowledged",
              remoteId: taskId,
              error: undefined,
            });
            continue;
          }
          await this.update(operation.id, {
            status: "sent",
            error: undefined,
            retryAt: undefined,
          });
          sent = true;
        }
        if (!active()) return snapshot;
        const result = await provider.apply(operation);
        await this.registry.change((state) => {
          const saved = state.operations.find(
            (item) => item.id === operation.id,
          )!;
          saved.status = "acknowledged";
          saved.remoteId = result.taskId;
          saved.error = undefined;
          saved.retryAt = undefined;
          if (operation.sourceUid && state.links[operation.sourceUid])
            state.links[operation.sourceUid]!.taskId = result.taskId;
        });
        this.changed();
      } catch (error) {
        if (!active()) return snapshot;
        const permanent = error instanceof TaskWriteError && error.permanent;
        const retryAt =
          error instanceof TaskReadError && error.retryAt
            ? error.retryAt
            : Date.now() +
              Math.min(60_000, 1000 * 2 ** Math.min(operation.attempts, 6));
        await this.update(operation.id, {
          status: permanent ? "failed" : sent ? "sent" : "pending",
          error:
            error instanceof TaskReadError
              ? error.message
              : "Could not apply this task change. It is saved for retry.",
          retryAt: permanent ? undefined : retryAt,
        });
        blocked.add(taskId);
        if (!permanent) break;
      }
    }
    if (!active()) return snapshot;
    const acknowledged = this.registry
      .snapshot()
      .operations.filter(
        (operation) =>
          operation.provider === snapshot.provider &&
          operation.accountId === snapshot.account.id &&
          operation.status === "acknowledged",
      );
    if (!acknowledged.length) return snapshot;
    const fresh = await provider.read();
    if (
      fresh.account.id !== snapshot.account.id ||
      fresh.provider !== snapshot.provider
    )
      throw new TaskReadError(
        "The connected account changed. Reconnect before applying saved changes.",
        undefined,
        true,
      );
    if (!active()) return snapshot;
    for (const operation of acknowledged) {
      const taskId = operationTaskId(operation);
      const task = fresh.tasks.find((item) => item.id === taskId) ?? null;
      await this.registry.change((state) => {
        state.operations.find((item) => item.id === operation.id)!.status =
          "complete";
        if (operation.sourceUid && state.links[operation.sourceUid])
          state.links[operation.sourceUid]!.base = task;
      });
    }
    return fresh;
  }
}

/** Keep saved edits visible while the authoritative cache retains its last acknowledged values. */
export function pendingSnapshot(
  snapshot: TaskSnapshot | null,
  operations: TaskOperation[],
): TaskSnapshot | null {
  if (!snapshot) return null;
  const tasks = new Map(snapshot.tasks.map((task) => [task.id, task]));
  for (const operation of operations) {
    if (
      !isOutstanding(operation) ||
      ["failed", "conflict"].includes(operation.status)
    )
      continue;
    const mutation = operation.mutation;
    const id = operationTaskId(operation);
    if (mutation.kind === "create") {
      if (!tasks.has(id))
        tasks.set(id, {
          ...mutation.task,
          id,
          order: Number.MAX_SAFE_INTEGER,
          completed: false,
        });
      continue;
    }
    const task = tasks.get(id) ?? operation.base;
    if (!task) continue;
    if (mutation.kind === "update")
      tasks.set(id, { ...task, ...mutation.changes });
    if (mutation.kind === "moveProject")
      tasks.set(id, { ...task, projectId: mutation.projectId, parentId: null });
    if (mutation.kind === "moveParent")
      tasks.set(id, {
        ...task,
        parentId: mutation.parentId,
        projectId: tasks.get(mutation.parentId)?.projectId ?? task.projectId,
      });
    if (mutation.kind === "complete" || mutation.kind === "reopen")
      tasks.set(id, { ...task, completed: mutation.kind === "complete" });
  }
  return { ...snapshot, tasks: [...tasks.values()] };
}
