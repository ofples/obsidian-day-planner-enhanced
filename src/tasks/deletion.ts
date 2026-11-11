import { get, writable } from "svelte/store";

import type { TaskCapture } from "./capture";
import {
  pendingTaskDeletion,
  deletionTaskTree,
  taskDeletionSchema,
  type TaskDeletionRecord,
} from "./deletion-types";
import { isOutstanding, operationAffectsTasks } from "./operations";
import type { TaskReconciler } from "./reconcile";
import type { TaskScheduler } from "./schedule";
import { scheduleBlocksTask } from "./schedule-types";
import type { TaskService } from "./service";
import { TaskReadError } from "./types";

export interface TaskDeletionReview {
  record: TaskDeletionRecord;
  fingerprint: string;
  cached: boolean;
  replaces?: string;
}

export class TaskDeletionController {
  readonly state = writable<{ records: TaskDeletionRecord[]; error: string }>({
    records: [],
    error: "",
  });
  private pending?: Promise<void>;
  private stopped = false;

  constructor(
    private readonly service: TaskService,
    private readonly capture: TaskCapture,
    private readonly scheduler: TaskScheduler,
    private readonly reconciler: TaskReconciler,
  ) {
    this.publish();
  }

  publish() {
    const snapshot = get(this.service.state).snapshot;
    this.state.update((previous) => ({
      ...previous,
      records: Object.values(this.service.registry.snapshot().deletions).filter(
        (record) =>
          record.provider === snapshot?.provider &&
          record.accountId === snapshot.account.id,
      ),
    }));
  }

  private current(record: TaskDeletionRecord) {
    const state = get(this.service.state);
    return (
      !this.stopped &&
      state.writable &&
      state.snapshot?.provider === record.provider &&
      state.snapshot.account.id === record.accountId
    );
  }

  async review(taskId: string, replaces?: string): Promise<TaskDeletionReview> {
    await this.service.refresh();
    await this.capture.scan();
    const browser = get(this.service.state),
      snapshot = browser.snapshot;
    if (
      this.stopped ||
      !browser.writable ||
      !snapshot?.account.capabilities?.delete
    )
      throw new TaskReadError(
        "Reconnect a task provider that supports verified deletion.",
      );
    const root = snapshot.tasks.find((task) => task.id === taskId);
    if (!root)
      throw new TaskReadError(
        "This task is unavailable. Open its saved deletion record to review recovery.",
      );
    const state = this.service.registry.snapshot();
    const completed = [
      ...browser.completed,
      ...Object.values(state.links)
        .filter(
          (link) =>
            link.provider === snapshot.provider &&
            link.accountId === snapshot.account.id &&
            link.base?.completed,
        )
        .map((link) => link.base!),
    ];
    const tasks = deletionTaskTree(snapshot, root, completed);
    const ids = new Set(tasks.map((task) => task.id));
    const old = replaces ? state.deletions[replaces] : undefined;
    const operation = replaces
      ? state.operations.find((item) => item.id === replaces)
      : undefined;
    if (
      replaces &&
      (!old ||
        !this.current(old) ||
        ["sent", "acknowledged", "verified", "complete"].includes(
          operation?.status ?? "pending",
        ))
    )
      throw new TaskReadError(
        "Finish verifying the existing deletion before confirming another one.",
      );
    if (
      tasks.some((task) =>
        pendingTaskDeletion(
          state,
          { provider: snapshot.provider, accountId: snapshot.account.id },
          task.id,
          replaces,
        ),
      ) ||
      state.operations.some(
        (item) =>
          item.id !== replaces &&
          item.provider === snapshot.provider &&
          item.accountId === snapshot.account.id &&
          operationAffectsTasks(item, ids) &&
          isOutstanding(item),
      ) ||
      state.schedules.some(
        (item) =>
          item.provider === snapshot.provider &&
          item.accountId === snapshot.account.id &&
          ids.has(item.task.id) &&
          scheduleBlocksTask(item),
      )
    )
      throw new TaskReadError(
        "Finish this task tree's saved changes before confirming deletion.",
      );
    const links = Object.fromEntries(
      [
        ...Object.entries(state.detached)
          .filter(([, item]) => item.reason === "missing" && !item.restoredAt)
          .map(([uid, item]) => [uid, item.link] as const),
        ...Object.entries(state.links),
      ].filter(
        ([, link]) =>
          link.provider === snapshot.provider &&
          link.accountId === snapshot.account.id &&
          link.taskId &&
          ids.has(link.taskId),
      ),
    );
    const projections = Object.fromEntries(
      Object.keys(links).flatMap((uid) => {
        const projection =
          state.projections[uid] ?? state.detached[uid]?.projection;
        return projection ? [[uid, projection]] : [];
      }),
    );
    const record = taskDeletionSchema.parse({
      id: crypto.randomUUID(),
      provider: snapshot.provider,
      accountId: snapshot.account.id,
      taskId,
      tasks,
      links,
      projections,
      phase: "pending",
      createdAt: new Date().toISOString(),
    });
    return {
      record,
      fingerprint: JSON.stringify({
        provider: record.provider,
        accountId: record.accountId,
        tasks,
        links,
        projections,
      }),
      cached: !!browser.error,
      replaces,
    };
  }

  async confirm(
    review: TaskDeletionReview,
  ): Promise<
    | { kind: "changed"; review: TaskDeletionReview }
    | { kind: "saved"; id: string }
  > {
    const fresh = await this.review(review.record.taskId, review.replaces);
    if (fresh.fingerprint !== review.fingerprint)
      return { kind: "changed", review: fresh };
    await this.service.registry.change((state) => {
      if (
        !this.current(fresh.record) ||
        fresh.record.tasks.some((task) =>
          pendingTaskDeletion(state, fresh.record, task.id, review.replaces),
        ) ||
        state.operations.some(
          (item) =>
            item.id !== review.replaces &&
            item.provider === fresh.record.provider &&
            item.accountId === fresh.record.accountId &&
            operationAffectsTasks(
              item,
              new Set(fresh.record.tasks.map((task) => task.id)),
            ) &&
            isOutstanding(item),
        ) ||
        state.schedules.some(
          (item) =>
            item.provider === fresh.record.provider &&
            item.accountId === fresh.record.accountId &&
            fresh.record.tasks.some((task) => task.id === item.task.id) &&
            scheduleBlocksTask(item),
        )
      )
        throw new TaskReadError(
          "The deletion state changed. Review the latest task tree.",
        );
      if (review.replaces) {
        const old = state.deletions[review.replaces],
          op = state.operations.find((item) => item.id === review.replaces);
        if (
          !old ||
          ["sent", "acknowledged", "verified", "complete"].includes(
            op?.status ?? "pending",
          )
        )
          throw new TaskReadError(
            "The deletion has already started. Review its saved recovery record.",
          );
        old.phase = "cancelled";
        if (op) op.status = "cancelled";
      }
      state.deletions[fresh.record.id] = fresh.record;
    });
    this.publish();
    void this.resume();
    return { kind: "saved", id: fresh.record.id };
  }

  async cancel(id: string) {
    await this.service.registry.change((state) => {
      const record = state.deletions[id],
        op = state.operations.find((item) => item.id === id);
      if (
        !record ||
        !this.current(record) ||
        ["complete", "cancelled", "unlinking"].includes(record.phase) ||
        ["sent", "acknowledged", "verified", "complete"].includes(
          op?.status ?? "pending",
        )
      )
        throw new TaskReadError(
          "This deletion has started. Finish its saved verification and note recovery.",
        );
      record.phase = "cancelled";
      record.error = undefined;
      if (op) op.status = "cancelled";
    });
    this.publish();
  }

  async retry(id: string) {
    const record = this.service.registry.snapshot().deletions[id];
    if (!record || !this.current(record))
      throw new TaskReadError(
        "Reconnect the original account before retrying deletion.",
      );
    const op = this.service.registry
      .snapshot()
      .operations.find((item) => item.id === id);
    if (op && ["failed", "pending", "sent", "acknowledged"].includes(op.status))
      await this.service.retryOperation(id);
    await this.resume();
  }

  resume(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.pending) return this.pending;
    this.state.update((state) => ({ ...state, error: "" }));
    const operation = this.run().catch(() => {
      this.state.update((state) => ({
        ...state,
        error:
          "Task deletion state could not be saved. Reopen the vault before retrying its recovery.",
      }));
    });
    this.pending = operation;
    return operation.finally(() => {
      this.pending = undefined;
      this.publish();
    });
  }

  private async run() {
    for (const record of Object.values(
      this.service.registry.snapshot().deletions,
    )) {
      if (
        !this.current(record) ||
        get(this.service.state).loading ||
        ["complete", "cancelled"].includes(record.phase)
      )
        continue;
      try {
        await this.process(record);
      } catch (error) {
        if (!this.current(record)) return;
        await this.service.registry.change((state) => {
          const saved = state.deletions[record.id];
          if (saved && !["complete", "cancelled"].includes(saved.phase))
            saved.error =
              error instanceof Error
                ? error.message
                : "Could not finish this saved deletion. Retry its recovery.";
        });
      }
    }
  }

  private async process(record: TaskDeletionRecord) {
    let op = this.service.registry
      .snapshot()
      .operations.find((item) => item.id === record.id);
    if (!op) {
      await this.service.mutate(
        { kind: "delete", taskId: record.taskId },
        undefined,
        {
          id: record.id,
          base: record.tasks[0]!,
          provider: record.provider,
          accountId: record.accountId,
        },
      );
      await this.service.refresh();
      op = this.service.registry
        .snapshot()
        .operations.find((item) => item.id === record.id);
    } else if (
      ["pending", "sent", "acknowledged", "verified"].includes(op.status)
    ) {
      await this.service.refresh();
      op = this.service.registry
        .snapshot()
        .operations.find((item) => item.id === record.id);
    }
    if (!this.current(record) || op?.status !== "complete") return;
    await this.service.registry.change((state) => {
      state.deletions[record.id]!.phase = "unlinking";
      state.deletions[record.id]!.error = undefined;
    });
    for (const [uid, original] of Object.entries(record.links)) {
      if (!this.current(record)) return;
      if (!original.taskId || op.deletionReadback?.[original.taskId] !== null)
        continue;
      const browser = get(this.service.state);
      if (
        browser.snapshot?.tasks.some((task) => task.id === original.taskId) &&
        (await this.service.readTask(original.taskId))
      )
        continue;
      const state = this.service.registry.snapshot(),
        link = state.links[uid];
      if (!link) {
        if (state.detached[uid])
          await this.service.registry.change((current) => {
            current.detached[uid]!.reason = "deleted";
            current.detached[uid]!.deletionId = record.id;
          });
        continue;
      }
      const inspection = await this.capture.inspectCurrentIdentities();
      const source = inspection.candidates.find((item) => item.uid === uid);
      if (source) await this.reconciler.unlink(uid, record.id);
      else {
        const missing = await this.capture.missingSource(uid, inspection);
        if (!missing)
          throw new TaskReadError(
            "Finish editing or repair this note's task identity, then retry the saved deletion recovery.",
          );
        await this.scheduler.reconcile({
          linkUid: uid,
          task: link.base!,
          source: link.source,
          raw: link.source.raw,
          interval: state.projections[uid]?.interval ?? null,
          mutations: [],
          expectedLink: link,
          unlink: true,
          missingSource: missing,
          deletionId: record.id,
        });
      }
    }
    await this.scheduler.resume();
    if (!this.current(record)) return;
    if (
      this.service.registry
        .snapshot()
        .schedules.some(
          (item) =>
            item.deletionId === record.id &&
            !["complete", "cancelled"].includes(item.phase),
        )
    )
      return;
    await this.service.registry.change((state) => {
      state.deletions[record.id]!.phase = "complete";
      state.deletions[record.id]!.completedAt = new Date().toISOString();
      state.deletions[record.id]!.error = undefined;
    });
  }

  stop() {
    this.stopped = true;
  }
}
