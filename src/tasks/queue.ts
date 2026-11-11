import {
  isOutstanding,
  matchesOperationResult,
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

  private async verify(
    operation: TaskOperation,
    provider: TaskProvider,
    snapshot: TaskSnapshot,
    active: () => boolean,
  ) {
    const taskId = operationTaskId(operation);
    let task;
    if (provider.get) task = await provider.get(taskId);
    else {
      const fresh = await provider.read();
      if (
        fresh.provider !== snapshot.provider ||
        fresh.account.id !== snapshot.account.id
      )
        throw new TaskReadError(
          "The connected task account changed. Reconnect before verifying saved changes.",
          undefined,
          true,
        );
      task = fresh.tasks.find((item) => item.id === taskId) ?? null;
    }
    if (!active()) return;
    const verified = matchesOperationResult(
      operation,
      task,
      snapshot.account.timezone,
    );
    await this.update(operation.id, {
      status: verified ? "verified" : "conflict",
      readback: verified && task ? task : undefined,
      error: verified
        ? undefined
        : "The provider acknowledged this change but returned different field values. Review the saved change and current task.",
      retryAt: undefined,
    });
  }

  async run(
    provider: TaskProvider,
    snapshot: TaskSnapshot,
    active: () => boolean,
  ): Promise<TaskSnapshot> {
    if (!provider.apply) return snapshot;
    const owned = this.registry
      .snapshot()
      .operations.filter(
        (operation) =>
          operation.provider === snapshot.provider &&
          operation.accountId === snapshot.account.id,
      );
    const operations = owned.filter((operation) =>
      ["pending", "sent", "acknowledged"].includes(operation.status),
    );
    const blocked = new Set(
      owned
        .filter((operation) =>
          ["conflict", "failed"].includes(operation.status),
        )
        .map(operationTaskId),
    );
    for (const operation of operations) {
      const taskId = operationTaskId(operation);
      let sent = operation.status === "sent";
      if (!active()) return snapshot;
      if ((operation.retryAt ?? 0) > Date.now()) blocked.add(taskId);
      if (blocked.has(taskId)) continue;
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
              status: "verified",
              remoteId: taskId,
              readback: remote ?? undefined,
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
        if (operation.status !== "acknowledged") {
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
        }
        const saved = this.registry
          .snapshot()
          .operations.find((item) => item.id === operation.id)!;
        await this.verify(saved, provider, snapshot, active);
        if (
          this.registry
            .snapshot()
            .operations.find((item) => item.id === operation.id)?.status ===
          "conflict"
        )
          blocked.add(taskId);
      } catch (error) {
        if (!active()) return snapshot;
        const permanent = error instanceof TaskWriteError && error.permanent;
        const acknowledged =
          this.registry
            .snapshot()
            .operations.find((item) => item.id === operation.id)?.status ===
          "acknowledged";
        const retryAt =
          error instanceof TaskReadError && error.retryAt
            ? error.retryAt
            : Date.now() +
              Math.min(60_000, 1000 * 2 ** Math.min(operation.attempts, 6));
        await this.update(operation.id, {
          status: acknowledged
            ? "acknowledged"
            : permanent
              ? "failed"
              : sent
                ? "sent"
                : "pending",
          error:
            error instanceof TaskReadError
              ? error.message
              : "Could not apply this task change. It is saved for retry.",
          retryAt: permanent ? undefined : retryAt,
        });
        blocked.add(taskId);
        if (acknowledged) throw error;
        if (!permanent) break;
      }
    }
    if (!active()) return snapshot;
    const verified = this.registry
      .snapshot()
      .operations.filter(
        (operation) =>
          operation.provider === snapshot.provider &&
          operation.accountId === snapshot.account.id &&
          operation.status === "verified",
      );
    if (!verified.length) return snapshot;
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
    for (const operation of verified) {
      await this.registry.change((state) => {
        state.operations.find((item) => item.id === operation.id)!.status =
          "complete";
        if (operation.sourceUid && state.links[operation.sourceUid])
          state.links[operation.sourceUid]!.base = operation.readback ?? null;
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
