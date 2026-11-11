import { get } from "svelte/store";

import { getTimeRangeMatch } from "../parser/parser";

import type { TaskCapture } from "./capture";
import {
  taskAccountSettings,
  type TaskCaptureSettings,
} from "./capture-settings";
import { matchingOccurrenceUndo } from "./occurrence-types";
import {
  buildOccurrenceUndoReview,
  type TaskOccurrenceUndoReview,
} from "./occurrence-undo-plan";
import { matchesOperationResult } from "./operations";
import { rewriteTaskNote, withoutTaskCaptureTag } from "./reconcile-markdown";
import type { TaskScheduler } from "./schedule";
import type { TaskService } from "./service";
import { TaskReadError } from "./types";

export class TaskOccurrenceUndoController {
  private pending?: Promise<void>;

  constructor(
    private readonly service: TaskService,
    private readonly capture: TaskCapture,
    private readonly scheduler: TaskScheduler,
    private readonly settings: () => TaskCaptureSettings,
    private readonly active: () => boolean,
  ) {}

  private current(id: string) {
    const browser = get(this.service.state),
      record = this.service.registry.snapshot().occurrences[id];
    return (
      this.active() &&
      browser.writable &&
      record?.provider === browser.snapshot?.provider &&
      record?.accountId === browser.snapshot?.account.id
    );
  }

  async review(id: string): Promise<TaskOccurrenceUndoReview> {
    await this.service.refresh();
    await this.capture.scan();
    if (!this.current(id))
      throw new TaskReadError(
        "Reconnect the original task account before reviewing undo.",
      );
    if (!this.service.supportsRecurringUndo())
      throw new TaskReadError(
        "This provider does not support exact recurring undo.",
      );
    const browser = get(this.service.state),
      snapshot = browser.snapshot!;
    const record = this.service.registry.snapshot().occurrences[id]!;
    const current = browser.error
      ? undefined
      : await this.service.readTask(record.before.task.id);
    if (!this.current(id))
      throw new TaskReadError("The task account changed during undo review.");
    if (!browser.error && !current)
      throw new TaskReadError(
        "The provider task is unavailable. Open its saved occurrence and current Todoist task to review recovery.",
      );
    const plan = buildOccurrenceUndoReview(
      this.service.registry.snapshot(),
      snapshot,
      browser.completed,
      id,
      current ?? undefined,
    );
    const inspection = await this.capture.inspectCurrentIdentities();
    for (const uid of Object.keys({
      ...plan.historical.links,
      ...plan.following.links,
    })) {
      const source = inspection.candidates.find(
        (candidate) => candidate.uid === uid,
      );
      if (!source || !(await this.capture.sourceIsCurrent(source)))
        throw new TaskReadError(
          "Finish editing or repair this occurrence's note identities before confirming undo.",
        );
    }
    if (!this.current(id))
      throw new TaskReadError("The task account changed during undo review.");
    return { ...plan, cached: Boolean(browser.error) };
  }

  async confirm(
    review: TaskOccurrenceUndoReview,
  ): Promise<
    { kind: "changed"; review: TaskOccurrenceUndoReview } | { kind: "saved" }
  > {
    const fresh = await this.review(review.occurrenceId);
    if (fresh.fingerprint !== review.fingerprint)
      return { kind: "changed", review: fresh };
    await this.service.requestOccurrenceUndo(
      fresh.occurrenceId,
      fresh.current,
      fresh.fingerprint,
    );
    await this.service.refresh();
    await this.resume();
    return { kind: "saved" };
  }

  async retry(id: string) {
    if (!this.current(id))
      throw new TaskReadError(
        "Reconnect the original account before retrying this undo.",
      );
    const state = this.service.registry.snapshot(),
      undo = state.occurrences[id]?.undo;
    const command = state.operations.find(
      (operation) => operation.id === undo?.id,
    );
    if (!undo || !command)
      throw new TaskReadError(
        "Restore this undo's saved receipt and command before retrying.",
      );
    if (["failed", "pending", "sent", "acknowledged"].includes(command.status))
      await this.service.retryOperation(command.id);
    for (const step of state.schedules.filter(
      (operation) =>
        operation.occurrenceUndoId === id &&
        !["complete", "cancelled"].includes(operation.phase),
    ))
      await this.scheduler.retry(step.id);
    await this.service.refresh();
    await this.resume();
  }

  async cancel(id: string) {
    await this.service.cancelOccurrenceUndo(id);
  }

  resume(): Promise<void> {
    if (this.pending) return this.pending;
    const pending = this.run();
    this.pending = pending;
    return pending.finally(() => {
      this.pending = undefined;
    });
  }

  private async error(id: string, message?: string) {
    const changed = await this.service.registry.change((state) => {
      const undo = state.occurrences[id]?.undo;
      if (
        !this.current(id) ||
        !undo ||
        ["complete", "cancelled"].includes(undo.phase) ||
        undo.error === message
      )
        return false;
      undo.error = message;
      return true;
    });
    if (changed) this.service.publish();
  }

  private async run() {
    for (const record of Object.values(
      this.service.registry.snapshot().occurrences,
    )) {
      if (
        !record.undo ||
        ["complete", "cancelled"].includes(record.undo.phase) ||
        !this.current(record.id) ||
        get(this.service.state).loading
      )
        continue;
      try {
        await this.process(record.id);
      } catch (failure) {
        if (!this.current(record.id)) return;
        await this.error(
          record.id,
          failure instanceof Error
            ? failure.message
            : "Could not restore this occurrence. Retry its saved recovery.",
        );
      }
    }
  }

  private async process(id: string) {
    let state = this.service.registry.snapshot();
    const undo = state.occurrences[id]!.undo!;
    let command = state.operations.find(
      (operation) => operation.id === undo.id,
    );
    if (!command)
      throw new TaskReadError(
        "Restore the saved undo command before recovering this occurrence.",
      );
    if (
      ["pending", "sent", "acknowledged", "verified"].includes(command.status)
    ) {
      if ((command.retryAt ?? 0) > Date.now()) return;
      await this.service.refresh();
      state = this.service.registry.snapshot();
      command = state.operations.find((operation) => operation.id === undo.id)!;
    }
    if (!this.current(id)) return;
    if (command.status !== "complete") {
      if (command.error) await this.error(id, command.error);
      return;
    }
    if (!matchingOccurrenceUndo(state, command))
      throw new TaskReadError(
        "Restore this occurrence's original undo receipt before recovering its notes.",
      );
    const browser = get(this.service.state);
    const root = await this.service.readTask(
      state.occurrences[id]!.before.task.id,
    );
    if (!this.current(id)) return;
    if (
      !matchesOperationResult(command, root, browser.snapshot!.account.timezone)
    )
      throw new TaskReadError(
        "This task changed after provider undo. Review the current Todoist occurrence before restoring its note.",
      );
    for (const uid of Object.keys(undo.following.links)) {
      if (!this.current(id)) return;
      await this.recoverSource(id, uid, "following");
    }
    await this.attachHistoricalSources(id);
    for (const uid of Object.keys(undo.historical.links)) {
      if (!this.current(id)) return;
      await this.recoverSource(id, uid, "historical");
    }
    state = this.service.registry.snapshot();
    const steps = Object.values({
      ...state.occurrences[id]!.undo!.steps.following,
      ...state.occurrences[id]!.undo!.steps.historical,
    });
    if (
      steps.some(
        (step) =>
          !state.schedules.find((operation) => operation.id === step)
            ?.taskAcknowledged,
      )
    )
      return;
    await this.service.registry.change((current) => {
      if (!this.current(id)) return;
      const record = current.occurrences[id]!;
      record.undo!.phase = "complete";
      record.undo!.error = undefined;
      record.phase = "undone";
    });
    this.service.publish();
  }

  private async attachHistoricalSources(id: string) {
    await this.capture.scan();
    const inspection = await this.capture.inspectCurrentIdentities();
    const undo = this.service.registry.snapshot().occurrences[id]!.undo!;
    for (const uid of Object.keys(undo.historical.links)) {
      if (
        this.service.registry
          .snapshot()
          .schedules.some(
            (operation) =>
              operation.id === undo.steps.historical[uid] &&
              operation.taskAcknowledged,
          )
      )
        continue;
      if (this.service.registry.snapshot().links[uid]) continue;
      const source = inspection.candidates.find(
        (candidate) => candidate.uid === uid,
      );
      if (!source || !(await this.capture.sourceIsCurrent(source)))
        throw new TaskReadError(
          "Restore the historical note identities before continuing undo.",
        );
    }
    await this.service.registry.change((state) => {
      if (!this.current(id)) return;
      for (const [uid, original] of Object.entries(undo.historical.links)) {
        if (
          state.schedules.some(
            (operation) =>
              operation.id === undo.steps.historical[uid] &&
              operation.taskAcknowledged,
          )
        )
          continue;
        if (state.links[uid]) continue;
        const source = inspection.candidates.find(
          (candidate) => candidate.uid === uid,
        )!;
        state.links[uid] = {
          ...original,
          source: {
            path: source.path,
            from: source.from,
            raw: source.raw,
            title: source.title,
          },
        };
        const projection = undo.historical.projections[uid];
        if (projection)
          state.projections[uid] = {
            ...projection,
            source: state.links[uid]!.source,
          };
      }
    });
  }

  private async recoverSource(
    id: string,
    uid: string,
    role: "following" | "historical",
  ) {
    let state = this.service.registry.snapshot();
    const record = state.occurrences[id]!,
      undo = record.undo!;
    let stepId = undo.steps[role][uid];
    const existing =
      stepId && state.schedules.find((operation) => operation.id === stepId);
    if (existing) {
      await this.scheduler.resume();
      const step = this.service.registry
        .snapshot()
        .schedules.find((operation) => operation.id === stepId)!;
      if (!step.taskAcknowledged)
        throw new TaskReadError(
          step.error ?? "Finish the saved undo note write before continuing.",
        );
      return;
    }
    const original = undo[role].links[uid]!;
    const inspection = await this.capture.inspectCurrentIdentities();
    const candidate = inspection.candidates.find((item) => item.uid === uid);
    if (!candidate || !(await this.capture.sourceIsCurrent(candidate)))
      throw new TaskReadError(
        "Finish editing or restore this undo's original note block, then retry recovery.",
      );
    let task =
      role === "following"
        ? original.base
        : await this.service.readTask(original.taskId!);
    if (!this.current(id)) return;
    state = this.service.registry.snapshot();
    const independentlyLinked =
      role === "historical" &&
      original.taskId !== record.before.task.id &&
      Object.entries(state.links).some(
        ([key, link]) =>
          key !== uid &&
          link.provider === record.provider &&
          link.accountId === record.accountId &&
          link.taskId === original.taskId,
      );
    const movedChild =
      role === "historical" &&
      original.taskId !== record.before.task.id &&
      task?.parentId !== original.base?.parentId;
    const unlink =
      role === "following" || !task || independentlyLinked || movedChild;
    task ??= original.base;
    if (!task)
      throw new TaskReadError(
        "Restore the saved task baseline before recovering this note.",
      );
    if (!stepId) {
      stepId = crypto.randomUUID();
      await this.service.registry.change((current) => {
        if (!this.current(id) || current.occurrences[id]?.undo?.id !== undo.id)
          throw new TaskReadError(
            "The undo recovery changed before its note step was saved.",
          );
        current.occurrences[id]!.undo!.steps[role][uid] = stepId!;
      });
    }
    const browser = get(this.service.state),
      link = this.service.registry.snapshot().links[uid];
    if (!link)
      throw new TaskReadError(
        "This undo source was detached. Review its original identity.",
      );
    const projection = this.service.registry.snapshot().projections[uid];
    const blocks = await this.scheduler.scanNotes();
    const block = blocks.find(
      (item) =>
        item.path === candidate.path &&
        item.from === candidate.from &&
        item.raw === candidate.raw,
    );
    if (
      !unlink &&
      getTimeRangeMatch(candidate.raw.split(/\r?\n/)[0] ?? "") &&
      !block
    )
      throw new TaskReadError(
        "Restore this historical calendar block before retrying undo.",
      );
    const raw = unlink
      ? withoutTaskCaptureTag(candidate.raw)
      : rewriteTaskNote(
          candidate.raw,
          task,
          taskAccountSettings(this.settings(), browser.snapshot!),
          original.taskId === record.before.task.id
            ? ["title", "completed", "projectId", "labels"]
            : ["title", "completed", "labels"],
        );
    await this.scheduler.reconcile({
      id: stepId,
      occurrenceUndoId: id,
      linkUid: uid,
      task,
      source: candidate,
      raw,
      expectedLink: link,
      unlink,
      interval: block
        ? { start: block.snapshot.start, end: block.snapshot.end }
        : unlink
          ? (projection?.interval ?? null)
          : null,
      googleUid: block?.uid,
      mutations: [],
    });
    const step = this.service.registry
      .snapshot()
      .schedules.find((operation) => operation.id === stepId)!;
    if (!step.taskAcknowledged)
      throw new TaskReadError(
        step.error ?? "Finish the saved undo projection before continuing.",
      );
  }
}
