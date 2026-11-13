import { get, writable } from "svelte/store";

import type { GoogleCalendarSync } from "../google-calendar/service";
import { getTimeRangeMatch } from "../parser/parser";
import { locateSource } from "../service/source-identity";

import { taskSubtree } from "./browser";
import { parseCaptureCandidates } from "./capture-parser";
import {
  taskAccountSettings,
  type TaskCaptureSettings,
} from "./capture-settings";
import { pendingTaskDeletion } from "./deletion-types";
import { TaskDrag } from "./drag";
import { pendingIdentityDecision } from "./identity-types";
import {
  matchingOccurrenceUndo,
  occurrenceCompletionVerified,
  pendingTaskOccurrence,
} from "./occurrence-types";
import {
  mutationFields,
  sameTaskField,
  isOutstanding,
  operationTaskId,
  resolvedTaskOperation,
  type TaskMutation,
} from "./operations";
import { rewriteTaskNote } from "./reconcile-markdown";
import type { TaskLink, TaskRegistryState } from "./registry";
import {
  indentTaskSubtree,
  newTaskMarkdown,
  scheduleNoteTitle,
  subtaskInsertTarget,
} from "./schedule-markdown";
import {
  scheduleIntervalSchema,
  intervalForTaskDate,
  taskOccurrenceKey,
  scheduleOperationSchema,
  scheduleBlocksTask,
  type ScheduleInterval,
  type ScheduleOperation,
  type TaskProjection,
} from "./schedule-types";
import type { TaskService } from "./service";
import type { TaskSource } from "./source";
import { TaskReadError, type ProviderTask } from "./types";

export class TaskProjectionConflict extends TaskReadError {}

export class TaskScheduler {
  readonly drag: TaskDrag;
  readonly state = writable<{
    operations: ScheduleOperation[];
    projections: TaskProjection[];
    error: string;
  }>({ operations: [], projections: [], error: "" });
  private pending?: Promise<void>;
  private again = false;
  private stopped = false;

  constructor(
    private readonly service: TaskService,
    private readonly calendar: Pick<
      GoogleCalendarSync,
      "editNotes" | "syncProjection" | "recoverProjection" | "removeProjection"
    > &
      Partial<Pick<GoogleCalendarSync, "assertTaskExportAllowed">>,
    private readonly host: {
      read(path: string): Promise<string | null>;
      flush(paths: string[]): Promise<void>;
      settings(): TaskCaptureSettings;
      reveal?(source: TaskSource): Promise<void>;
    },
  ) {
    this.drag = new TaskDrag(service);
    this.publish();
  }

  async reveal(taskId: string) {
    const projection = this.projection(taskId);
    if (!projection)
      throw new TaskReadError("This task has no linked note yet.");
    const source =
      this.service.registry.snapshot().links[projection.linkUid]?.source ??
      projection.source;
    await this.host.reveal?.(source);
  }

  duration(task: ProviderTask, fallback: number) {
    const projection = this.projection(task.id);
    return projection?.interval
      ? (Date.parse(projection.interval.end) -
          Date.parse(projection.interval.start)) /
          60_000
      : task.duration
        ? task.duration.amount * (task.duration.unit === "day" ? 1440 : 1)
        : fallback;
  }

  previewTask(source: { provider: string; accountId: string; taskId: string }) {
    const browser = get(this.service.state);
    const snapshot = browser.snapshot;
    const task = snapshot?.tasks.find(
      (item) => item.id === source.taskId && !item.completed,
    );
    if (
      this.stopped ||
      !browser.writable ||
      !snapshot ||
      !task ||
      snapshot.provider !== source.provider ||
      snapshot.account.id !== source.accountId
    )
      throw new TaskReadError(
        "Refresh this task's account before editing its calendar preview.",
      );
    return task;
  }

  publish() {
    const snapshot = get(this.service.state).snapshot;
    const state = this.service.registry.snapshot();
    const owns = (value: { provider: string; accountId: string }) =>
      value.provider === snapshot?.provider &&
      value.accountId === snapshot.account.id;
    this.state.update((previous) => ({
      ...previous,
      operations: state.schedules.filter(
        (operation) =>
          owns(operation) &&
          !["complete", "cancelled"].includes(operation.phase),
      ),
      projections: Object.values(state.projections).filter(owns),
    }));
  }

  projection(taskId: string) {
    const projections = get(this.state).projections.filter(
      (projection) => projection.taskId === taskId,
    );
    return (
      projections.find((projection) => projection.interval) ?? projections[0]
    );
  }

  schedule(
    taskId: string,
    interval: ScheduleInterval,
    id: string = crypto.randomUUID(),
  ) {
    return this.enqueue(
      taskId,
      { kind: "schedule", interval: scheduleIntervalSchema.parse(interval) },
      id,
    );
  }

  insert(
    taskId: string,
    target: { path: string; offset: number; before: string },
    id: string = crypto.randomUUID(),
  ) {
    return this.enqueue(taskId, { kind: "insert", ...target }, id);
  }

  async nest(
    taskId: string,
    parent: { path: string; line: number; text: string },
    id: string = crypto.randomUUID(),
  ) {
    await this.host.flush([parent.path]);
    const before = await this.host.read(parent.path);
    const repeated = this.service.registry
      .snapshot()
      .schedules.find((operation) => operation.id === id);
    if (repeated) {
      if (
        repeated.task.id !== taskId ||
        repeated.target.kind !== "insert" ||
        repeated.target.parent?.path !== parent.path ||
        repeated.target.before.slice(0, repeated.target.parent.from).split("\n")
          .length !==
          parent.line + 1 ||
        repeated.target.parent.title !== parent.text.split(/\r?\n/)[0]?.trim()
      )
        throw new TaskReadError(
          "This saved drop belongs to another task block.",
        );
      return this.enqueue(taskId, repeated.target, id);
    }
    if (before === null)
      throw new TaskReadError("The destination note is missing.");
    return this.enqueue(
      taskId,
      { kind: "insert", ...subtaskInsertTarget(before, parent) },
      id,
    );
  }

  unschedule(taskId: string) {
    return this.enqueue(taskId, { kind: "unschedule" }, crypto.randomUUID());
  }

  scanNotes() {
    return this.calendar.editNotes(async (_notes, blocks) => blocks);
  }

  async reconcile(input: {
    linkUid: string;
    task: ProviderTask;
    source: TaskSource;
    raw: string;
    interval: ScheduleInterval | null;
    googleUid?: string;
    mutations: { mutation: TaskMutation; base: ProviderTask }[];
    expectedLink?: TaskLink;
    unlink?: boolean;
    repairCaptureTag?: boolean;
    missingSource?: { document: string | null };
    deletionId?: string;
    occurrenceId?: string;
    occurrenceUndoId?: string;
    id?: string;
  }) {
    await this.pending;
    const browser = get(this.service.state),
      snapshot = browser.snapshot;
    if (this.stopped || !snapshot || !browser.writable)
      throw new TaskReadError("Reconnect before reconciling this task.");
    if ((input.unlink || input.repairCaptureTag) && input.mutations.length)
      throw new TaskReadError(
        "Link recovery requires a local-only note change.",
      );
    const state = this.service.registry.snapshot(),
      link = state.links[input.linkUid];
    if (
      !link ||
      link.provider !== snapshot.provider ||
      link.accountId !== snapshot.account.id ||
      link.taskId !== input.task.id ||
      (input.expectedLink &&
        JSON.stringify(input.expectedLink) !== JSON.stringify(link))
    )
      throw new TaskReadError(
        "The note link changed. Refresh before reconciling it.",
      );
    const projection = state.projections[input.linkUid];
    const owner = {
      provider: snapshot.provider,
      accountId: snapshot.account.id,
    };
    if (pendingIdentityDecision(state, owner, input.task.id))
      throw new TaskReadError(
        "Finish this task's source decision before changing its projection.",
      );
    if (
      pendingTaskOccurrence(
        state,
        owner,
        input.task.id,
        input.occurrenceId ?? input.occurrenceUndoId,
      )
    )
      throw new TaskReadError(
        "Finish this task's saved occurrence history before changing its projection.",
      );
    if (input.occurrenceId) {
      const record = state.occurrences[input.occurrenceId];
      if (
        !record ||
        record.phase !== "freezing" ||
        !occurrenceCompletionVerified(state, record) ||
        record.provider !== owner.provider ||
        record.accountId !== owner.accountId ||
        record.before.task.id !== input.task.id ||
        !record.before.links[input.linkUid] ||
        input.task.completionCount !== record.before.task.completionCount ||
        !input.task.completed ||
        input.mutations.length
      )
        throw new TaskReadError(
          "Verify this occurrence's saved completion before freezing its note.",
        );
    }
    if (pendingTaskDeletion(state, owner, input.task.id, input.deletionId))
      throw new TaskReadError(
        "Finish this task's saved deletion before changing its projection.",
      );
    if (input.deletionId) {
      const record = state.deletions[input.deletionId],
        op = state.operations.find((item) => item.id === input.deletionId);
      if (
        !record ||
        record.phase !== "unlinking" ||
        record.provider !== owner.provider ||
        record.accountId !== owner.accountId ||
        !input.unlink ||
        op?.status !== "complete" ||
        op.deletionReadback?.[input.task.id] !== null
      )
        throw new TaskReadError(
          "Verify the saved task deletion before unlinking this note.",
        );
    }
    const providerSteps = input.mutations.map((step) => ({
      ...step,
      id: crypto.randomUUID(),
    }));
    const final = providerSteps.at(-1);
    const occurrenceId =
      input.occurrenceId ??
      (final?.mutation.kind === "complete" && final.base.due?.recurring
        ? final.id
        : undefined);
    const operation = scheduleOperationSchema.parse({
      id: input.id ?? crypto.randomUUID(),
      provider: snapshot.provider,
      accountId: snapshot.account.id,
      task: input.task,
      linkUid: input.linkUid,
      googleUid:
        projection?.googleUid ??
        input.googleUid ??
        crypto.randomUUID().replace(/-/g, ""),
      providerOperationId: crypto.randomUUID(),
      occurrenceKey: projection?.occurrenceKey ?? taskOccurrenceKey(input.task),
      target: { kind: "reconcile", interval: input.interval },
      previous: input.source,
      previousInterval: projection?.interval ?? undefined,
      calendarBase: projection?.interval
        ? {
            ...projection.interval,
            title: scheduleNoteTitle(projection.source.raw),
          }
        : undefined,
      children: [],
      raw: input.raw,
      generatedTaskIds: [input.task.id],
      syncTaskDate: false,
      unlink: input.unlink,
      unlinkNoteBase: input.unlink ? link.noteBase : undefined,
      repairCaptureTag: input.repairCaptureTag,
      missingSource: input.missingSource,
      deletionId: input.deletionId,
      occurrenceId,
      occurrenceUndoId: input.occurrenceUndoId,
      providerSteps,
      phase: input.missingSource ? "prepared" : "pending",
      plan: input.missingSource
        ? {
            edits: [],
            links: [
              { uid: input.linkUid, task: input.task, source: input.source },
            ],
            interval: input.interval,
          }
        : undefined,
      createdAt: new Date().toISOString(),
    });
    this.assertUndoProjection(state, operation);
    await this.service.registry.change((current) => {
      this.assertUndoProjection(current, operation);
      if (
        !this.current(operation) ||
        pendingIdentityDecision(current, operation, operation.task.id) ||
        pendingTaskOccurrence(
          current,
          operation,
          operation.task.id,
          input.occurrenceId ?? input.occurrenceUndoId,
        ) ||
        pendingTaskDeletion(
          current,
          operation,
          operation.task.id,
          input.deletionId,
        ) ||
        JSON.stringify(current.links[input.linkUid]) !== JSON.stringify(link) ||
        ((input.unlink || input.repairCaptureTag) &&
          current.operations.some(
            (item) =>
              item.provider === operation.provider &&
              item.accountId === operation.accountId &&
              operationTaskId(item) === input.task.id &&
              isOutstanding(item),
          )) ||
        current.schedules.some(
          (item) =>
            item.provider === operation.provider &&
            item.accountId === operation.accountId &&
            item.task.id === input.task.id &&
            scheduleBlocksTask(item),
        )
      )
        throw new TaskReadError(
          "Finish this task's saved projection change before reconciling another edit.",
        );
      this.saveIntent(current, operation);
    });
    this.publish();
    await this.resume();
    return operation;
  }

  private async enqueue(
    taskId: string,
    input: ScheduleOperation["target"],
    id: string,
  ) {
    const target = scheduleOperationSchema.shape.target.parse(input);
    await this.pending;
    const browser = get(this.service.state),
      snapshot = browser.snapshot;
    if (this.stopped || !browser.writable || !snapshot)
      throw new TaskReadError(
        "Connect the task account before changing its schedule.",
      );
    const task = snapshot.tasks.find(
      (item) => item.id === taskId && !item.completed,
    );
    if (!task || taskId.startsWith("local-"))
      throw new TaskReadError("Refresh this task before scheduling it.");
    const state = this.service.registry.snapshot();
    if (
      taskSubtree(snapshot, task).some((item) =>
        pendingIdentityDecision(
          state,
          { provider: snapshot.provider, accountId: snapshot.account.id },
          item.task.id,
        ),
      )
    )
      throw new TaskReadError(
        "Finish this task tree's source decision before scheduling it.",
      );
    if (
      pendingTaskOccurrence(
        state,
        { provider: snapshot.provider, accountId: snapshot.account.id },
        taskId,
      )
    )
      throw new TaskReadError(
        "Finish this task's saved occurrence history before scheduling its next occurrence.",
      );
    if (
      pendingTaskDeletion(
        state,
        { provider: snapshot.provider, accountId: snapshot.account.id },
        taskId,
      )
    )
      throw new TaskReadError(
        "Finish this task's saved deletion before scheduling it.",
      );
    const repeated = state.schedules.find((operation) => operation.id === id);
    if (repeated) {
      if (
        repeated.provider !== snapshot.provider ||
        repeated.accountId !== snapshot.account.id ||
        repeated.task.id !== taskId ||
        JSON.stringify(repeated.target) !== JSON.stringify(target)
      )
        throw new TaskReadError(
          "This saved drop belongs to another schedule change.",
        );
      return repeated;
    }
    if (
      state.schedules.some(
        (operation) =>
          operation.provider === snapshot.provider &&
          operation.accountId === snapshot.account.id &&
          operation.task.id === taskId &&
          scheduleBlocksTask(operation),
      )
    )
      throw new TaskReadError(
        "Finish or review this task's saved schedule change first.",
      );
    const projection = this.projection(taskId);
    if (target.kind === "unschedule" && !projection?.interval)
      throw new TaskReadError("This task is already unscheduled.");
    const links = Object.entries(state.links).filter(
      ([, link]) =>
        link.provider === snapshot.provider &&
        link.accountId === snapshot.account.id &&
        link.taskId === taskId,
    );
    if (!projection && links.length > 1)
      throw new TaskReadError(
        "Choose the canonical note link before scheduling this task.",
      );
    const linked = projection ? state.links[projection.linkUid] : links[0]?.[1];
    const previous = linked?.source ?? projection?.source;
    if (
      target.kind === "insert" &&
      target.parent &&
      previous?.path === target.path
    ) {
      const from = locateSource(target.before, previous);
      if (
        from < 0 ||
        (target.parent.from >= from &&
          target.parent.from < from + previous.raw.length)
      )
        throw new TaskReadError(
          "A task cannot be added inside itself or its subtasks.",
        );
    }
    const linkUid =
      projection?.linkUid ??
      links[0]?.[0] ??
      crypto.randomUUID().replace(/-/g, "");
    const alreadyLinked = new Set(
      Object.values(state.links)
        .filter(
          (link) =>
            link.provider === snapshot.provider &&
            link.accountId === snapshot.account.id,
        )
        .map((link) => link.taskId),
    );
    const children = previous
      ? []
      : taskSubtree(snapshot, task).filter(
          (child) => !alreadyLinked.has(child.task.id),
        );
    const syncTaskDate =
      target.kind === "schedule" &&
      taskAccountSettings(this.host.settings(), snapshot)
        .syncScheduleToTaskDate !== false;
    const operation = scheduleOperationSchema.parse({
      id,
      provider: snapshot.provider,
      accountId: snapshot.account.id,
      task,
      linkUid,
      googleUid:
        projection?.interval && projection.googleUid
          ? projection.googleUid
          : crypto.randomUUID().replace(/-/g, ""),
      providerOperationId: crypto.randomUUID(),
      occurrenceKey: projection?.occurrenceKey ?? taskOccurrenceKey(task),
      target,
      previous,
      previousInterval: projection?.interval ?? undefined,
      calendarBase: projection?.interval
        ? {
            ...projection.interval,
            title: scheduleNoteTitle(projection.source.raw),
          }
        : undefined,
      children: children.map((child) => child.task),
      raw:
        previous?.raw ??
        newTaskMarkdown(task, children, snapshot, this.host.settings()),
      generatedTaskIds: previous
        ? [task.id]
        : [task.id, ...children.map((child) => child.task.id)],
      syncTaskDate,
      providerChanges:
        target.kind === "schedule" && syncTaskDate
          ? {
              due: {
                date: target.interval.start,
                recurring: task.due?.recurring ?? false,
                text: task.due?.recurring ? task.due.text : "",
                timezone: task.due?.timezone ?? snapshot.account.timezone,
              },
              ...(snapshot.account.capabilities?.duration
                ? {
                    duration: {
                      amount:
                        (Date.parse(target.interval.end) -
                          Date.parse(target.interval.start)) /
                        60_000,
                      unit: "minute",
                    },
                  }
                : {}),
            }
          : undefined,
      phase: "pending",
      createdAt: new Date().toISOString(),
    });
    const saved = await this.service.registry.change((current) => {
      if (
        pendingIdentityDecision(current, operation, operation.task.id) ||
        pendingTaskOccurrence(current, operation, operation.task.id)
      )
        throw new TaskReadError(
          "Finish this task's saved occurrence history before scheduling its next occurrence.",
        );
      if (pendingTaskDeletion(current, operation, operation.task.id))
        throw new TaskReadError(
          "Finish this task's saved deletion before scheduling it.",
        );
      const repeated = current.schedules.find((item) => item.id === id);
      if (repeated) {
        if (
          repeated.provider !== operation.provider ||
          repeated.accountId !== operation.accountId ||
          repeated.task.id !== taskId ||
          JSON.stringify(repeated.target) !== JSON.stringify(target)
        )
          throw new TaskReadError(
            "This saved drop has different schedule fields.",
          );
        return repeated;
      }
      if (
        current.schedules.some(
          (item) =>
            item.provider === operation.provider &&
            item.accountId === operation.accountId &&
            item.task.id === taskId &&
            scheduleBlocksTask(item),
        )
      )
        throw new TaskReadError(
          "This task already has a saved schedule change.",
        );
      this.saveIntent(current, operation);
      return operation;
    });
    this.publish();
    void this.resume();
    return saved;
  }

  private assertUndoProjection(
    state: TaskRegistryState,
    operation: ScheduleOperation,
  ) {
    if (!operation.occurrenceUndoId) return;
    const record = state.occurrences[operation.occurrenceUndoId],
      undo = record?.undo;
    const source =
      undo?.historical.links[operation.linkUid] ??
      undo?.following.links[operation.linkUid];
    const step =
      undo?.steps.following[operation.linkUid] ??
      undo?.steps.historical[operation.linkUid];
    const command = state.operations.find((item) => item.id === undo?.id);
    const calendarRetry =
      operation.taskAcknowledged &&
      operation.phase === "calendar-pending" &&
      undo?.phase === "complete";
    if (
      !undo ||
      record.provider !== operation.provider ||
      record.accountId !== operation.accountId ||
      (undo.phase !== "local-pending" && !calendarRetry) ||
      source?.taskId !== operation.task.id ||
      step !== operation.id ||
      command?.status !== "complete" ||
      !matchingOccurrenceUndo(state, command, calendarRetry) ||
      (undo.following.links[operation.linkUid] && !operation.unlink) ||
      (!operation.unlink &&
        operation.task.id === record.before.task.id &&
        (!undo.readback ||
          operation.task.completed ||
          operation.task.completionCount !== undo.readback.completionCount ||
          !sameTaskField(
            operation.task.due,
            undo.readback.due,
            "due",
            get(this.service.state).snapshot!.account.timezone,
          )))
    )
      throw new TaskReadError(
        "Verify this occurrence's saved undo before restoring its note links.",
      );
  }

  private current(operation: ScheduleOperation) {
    const browser = get(this.service.state);
    const saved = this.service.registry
      .snapshot()
      .schedules.find((item) => item.id === operation.id);
    return (
      !this.stopped &&
      !["complete", "cancelled"].includes(saved?.phase ?? "pending") &&
      browser.writable &&
      browser.snapshot?.provider === operation.provider &&
      browser.snapshot.account.id === operation.accountId
    );
  }

  private calendarRemovals(operation: ScheduleOperation) {
    const removals = [...(operation.calendarRemovals ?? [])];
    if (
      !operation.unlink &&
      !operation.repairCaptureTag &&
      operation.plan &&
      !operation.plan.interval &&
      operation.previousInterval &&
      operation.previous
    )
      removals.push({
        uid: operation.googleUid,
        path: operation.previous.path,
        snapshot: {
          ...operation.previousInterval,
          title: scheduleNoteTitle(operation.previous.raw),
        },
      });
    return [...new Map(removals.map((item) => [item.uid, item])).values()];
  }

  private saveIntent(state: TaskRegistryState, operation: ScheduleOperation) {
    const previous = state.schedules.filter(
      (item) =>
        item.provider === operation.provider &&
        item.accountId === operation.accountId &&
        item.task.id === operation.task.id &&
        item.occurrenceKey === operation.occurrenceKey &&
        !item.occurrenceId &&
        item.phase === "calendar-pending" &&
        item.taskAcknowledged,
    );
    operation.calendarRemovals = previous.flatMap((item) =>
      this.calendarRemovals(item),
    );
    operation.calendarPredecessors = previous.flatMap((item) => [
      ...(item.calendarPredecessors ?? []),
      ...(item.plan?.block
        ? [{ ...item.plan.block, base: item.calendarBase }]
        : []),
    ]);
    for (const saved of previous) {
      saved.phase = "cancelled";
      saved.supersededBy = operation.id;
      saved.error = undefined;
    }
    state.schedules.push(operation);
  }

  private saved(id: string) {
    return this.service.registry
      .snapshot()
      .schedules.find((item) => item.id === id)!;
  }

  private async update(id: string, patch: Partial<ScheduleOperation>) {
    await this.service.registry.change((state) => {
      Object.assign(state.schedules.find((item) => item.id === id)!, patch);
    });
    this.publish();
  }

  resume(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.pending) {
      this.again = true;
      return this.pending;
    }
    const operation = this.run().catch(() => {
      this.state.update((state) => ({
        ...state,
        error:
          "Task scheduling state needs review. Reopen the vault before retrying.",
      }));
    });
    this.pending = operation;
    return operation.finally(() => {
      this.pending = undefined;
      if (this.again && !this.stopped) {
        this.again = false;
        void this.resume();
      }
    });
  }

  async retry(id: string) {
    const operation = this.service.registry
      .snapshot()
      .schedules.find((item) => item.id === id);
    if (!operation || !this.current(operation))
      throw new TaskReadError(
        "Reconnect the original task account before retrying this schedule.",
      );
    if (
      operation.phase === "conflict" &&
      !operation.occurrenceId &&
      !operation.occurrenceUndoId
    )
      throw new TaskReadError(
        "Review the note or task conflict before retrying this schedule.",
      );
    await this.update(id, {
      error: undefined,
      ...(operation.phase === "conflict" &&
      (operation.occurrenceId || operation.occurrenceUndoId)
        ? {
            phase: operation.taskAcknowledged
              ? "calendar-pending"
              : operation.plan
                ? "prepared"
                : "pending",
          }
        : {}),
    });
    await this.resume();
  }

  private async run() {
    this.publish();
    for (const operation of get(this.state).operations) {
      if (!this.current(operation)) continue;
      try {
        if (
          ["conflict", "provider-pending"].includes(operation.phase) &&
          (await this.resumeResolution(operation))
        )
          continue;
        if (operation.phase === "conflict") continue;
        await this.process(operation);
      } catch (error) {
        if (!this.current(operation)) return;
        await this.update(operation.id, {
          phase:
            error instanceof TaskProjectionConflict
              ? "conflict"
              : this.saved(operation.id).phase,
          error:
            error instanceof Error
              ? error.message
              : "Could not finish this saved schedule change. Retry when connected.",
        });
      }
    }
  }

  private async resumeResolution(operation: ScheduleOperation) {
    const state = this.service.registry.snapshot();
    if (operation.target.kind === "reconcile") {
      if (operation.phase !== "conflict") return false;
      const steps = (operation.providerSteps ?? []).map((step) =>
        state.operations.find((item) => item.id === step.id),
      );
      if (!steps.some((step) => step?.resolutionIds)) return false;
      if (
        steps.some(
          (step) =>
            step &&
            resolvedTaskOperation(state.operations, step.id).status ===
              "conflict",
        )
      )
        return true;
      await this.update(operation.id, {
        phase: "provider-pending",
        error: undefined,
      });
      this.again = true;
      return true;
    }
    const original = state.operations.find(
      (item) => item.id === operation.providerOperationId,
    );
    if (!original?.resolutionIds) return false;
    const result = resolvedTaskOperation(state.operations, original.id);
    if (result.status !== "complete") return true;
    if (!result.task || operation.target.kind !== "schedule")
      throw new TaskProjectionConflict(
        "This task is unavailable. Review its linked note before continuing the schedule.",
      );
    const projection = state.projections[operation.linkUid];
    const source = state.links[operation.linkUid]?.source ?? projection?.source;
    if (!projection || !source)
      throw new TaskProjectionConflict(
        "Restore the saved note projection before resolving this schedule.",
      );
    const snapshot = get(this.service.state).snapshot!;
    const interval = intervalForTaskDate(
      operation.target.interval,
      result.task,
      snapshot.account.timezone,
      snapshot.account.capabilities?.duration === true,
    );
    const replacement = scheduleOperationSchema.parse({
      ...operation,
      id: crypto.randomUUID(),
      providerOperationId: crypto.randomUUID(),
      task: result.task,
      target: { kind: "schedule", interval },
      previous: source,
      previousInterval: projection.interval ?? undefined,
      raw: source.raw,
      children: [],
      generatedTaskIds: [result.task.id],
      syncTaskDate: false,
      providerChanges: undefined,
      phase: "pending",
      plan: undefined,
      error: undefined,
      createdAt: new Date().toISOString(),
    });
    await this.service.registry.change((current) => {
      const saved = current.schedules.find((item) => item.id === operation.id)!;
      if (!["conflict", "provider-pending"].includes(saved.phase)) return;
      saved.phase = "cancelled";
      saved.error = undefined;
      current.schedules.push(replacement);
    });
    this.again = true;
    this.publish();
    return true;
  }

  private async process(initial: ScheduleOperation) {
    this.assertUndoProjection(this.service.registry.snapshot(), initial);
    let operation = this.saved(initial.id);
    if (operation.phase === "pending") {
      await this.host.flush([
        ...(operation.previous ? [operation.previous.path] : []),
        ...(operation.target.kind === "insert" ? [operation.target.path] : []),
      ]);
      if (!this.current(operation)) return;
      await this.calendar.editNotes(async (notes, blocks) => {
        if (!this.current(operation)) return;
        let plan: NonNullable<ScheduleOperation["plan"]>;
        let googleUid = operation.googleUid;
        const interval =
          "interval" in operation.target ? operation.target.interval : null;
        if (interval && !operation.unlink && !operation.repairCaptureTag) {
          const matching = operation.previous
            ? blocks.filter(
                (block) =>
                  block.path === operation.previous!.path &&
                  block.raw === operation.previous!.raw,
              )
            : [];
          const removals = new Set(
            this.calendarRemovals(operation).map((item) => item.uid),
          );
          const adopted =
            matching.find(
              (block) =>
                block.uid === operation.googleUid && !removals.has(block.uid),
            ) ??
            matching.find(
              (block) =>
                block.from === operation.previous!.from &&
                !removals.has(block.uid),
            ) ??
            (matching.length === 1 && !removals.has(matching[0]!.uid)
              ? matching[0]
              : undefined);
          const known =
            this.service.registry.snapshot().projections[operation.linkUid]
              ?.googleUid;
          googleUid =
            known && !removals.has(known) ? known : (adopted?.uid ?? googleUid);
          const snapshot = {
            ...interval,
            title: scheduleNoteTitle(operation.raw),
          };
          let previous = operation.previous
            ? { ...operation.previous, uid: googleUid, snapshot }
            : undefined;
          if (previous) {
            const text = await this.host.read(previous.path);
            const from = text === null ? -1 : locateSource(text, previous);
            if (from < 0)
              throw new TaskProjectionConflict(
                "The linked source changed before scheduling. Refresh or repair its note link.",
              );
            previous = { ...previous, from: adopted?.from ?? from };
          }
          const prepared = await notes.prepareWrite(
            googleUid,
            snapshot,
            previous,
            true,
            operation.raw,
          );
          plan = {
            edits: prepared.edits,
            block: prepared.block,
            interval,
            links: this.planLinks(
              operation,
              prepared.block.path,
              prepared.block.from,
              prepared.block.raw,
            ),
          };
        } else plan = await this.prepareUntimed(operation);
        if (!this.current(operation)) return;
        await this.update(operation.id, {
          googleUid,
          plan,
          phase: "prepared",
          error: undefined,
        });
      });
      operation = this.saved(operation.id);
    }
    if (!this.current(operation)) return;
    if (operation.phase === "prepared") {
      if (operation.missingSource) {
        if (
          (await this.host.read(operation.previous!.path)) !==
          operation.missingSource.document
        ) {
          await this.update(operation.id, {
            phase: "cancelled",
            error: undefined,
          });
          return;
        }
        await this.acknowledgeLocal(operation);
      } else {
        await this.calendar.editNotes(async (notes, blocks) => {
          if (!this.current(operation)) return;
          const plan = operation.plan!;
          const current =
            plan.block && blocks.find((block) => block.uid === plan.block!.uid);
          if (
            current &&
            current.raw !== plan.block!.raw &&
            current.raw !== operation.previous?.raw
          )
            throw new TaskProjectionConflict(
              "The scheduled note changed after it was written. Review its current content before continuing.",
            );
          const alreadyApplied = await this.editsApplied(plan.edits);
          if (plan.block)
            await notes.applyWrite({ block: plan.block, edits: plan.edits });
          else if (!alreadyApplied) await notes.applyEdits(plan.edits);
          if (!this.current(operation)) return;
          await this.acknowledgeLocal(operation);
        });
      }
      operation = this.saved(operation.id);
    }
    if (!this.current(operation)) return;
    if (operation.phase === "local-applied") {
      if (operation.syncTaskDate || operation.providerSteps?.length)
        await this.update(operation.id, { phase: "provider-pending" });
      else await this.acknowledgeTask(operation);
      operation = this.saved(operation.id);
    }
    if (operation.phase === "provider-pending") {
      const steps = operation.providerSteps ?? [
        {
          id: operation.providerOperationId,
          base: operation.task,
          mutation: {
            kind: "update" as const,
            taskId: operation.task.id,
            changes: operation.providerChanges!,
          },
        },
      ];
      const changesTaskDate = steps.some(
        (step) =>
          step.mutation.kind === "update" &&
          step.mutation.changes.due !== undefined &&
          resolvedTaskOperation(
            this.service.registry.snapshot().operations,
            step.id,
          ).status !== "complete",
      );
      if (
        operation.plan?.interval &&
        changesTaskDate &&
        !operation.unlink &&
        !operation.repairCaptureTag
      ) {
        await this.calendar.assertTaskExportAllowed?.();
        if (!this.current(operation)) return;
      }
      for (const [index, step] of steps.entries()) {
        if (!this.current(operation)) return;
        let base = step.base;
        if (
          step.mutation.kind === "complete" &&
          base.due?.recurring &&
          index > 0
        ) {
          const previous = resolvedTaskOperation(
            this.service.registry.snapshot().operations,
            steps[index - 1]!.id,
          );
          if (
            previous.status === "complete" &&
            previous.task &&
            previous.task.completionCount === base.completionCount &&
            sameTaskField(
              base.due,
              previous.task.due,
              "due",
              get(this.service.state).snapshot!.account.timezone,
            )
          )
            base = previous.task;
        }
        await this.service.mutate(step.mutation, undefined, {
          id: step.id,
          base,
          provider: operation.provider,
          accountId: operation.accountId,
        });
        await this.service.refresh();
        if (!this.current(operation)) return;
        const saved = this.service.registry
          .snapshot()
          .operations.find((item) => item.id === step.id)!;
        const result = resolvedTaskOperation(
          this.service.registry.snapshot().operations,
          saved.id,
        );
        if (result.status === "conflict")
          throw new TaskProjectionConflict(
            saved.error ?? "Review the task change before continuing.",
          );
        if (result.status !== "complete") {
          await this.update(operation.id, { error: saved.error });
          return;
        }
      }
      if (
        operation.target.kind === "reconcile" &&
        steps.some(
          (step) =>
            this.service.registry
              .snapshot()
              .operations.find((item) => item.id === step.id)?.resolutionIds,
        )
      ) {
        await this.replaceResolvedProjection(operation);
        return;
      }
      await this.acknowledgeTask(operation);
      operation = this.saved(operation.id);
    }
    if (operation.phase === "calendar-pending" && this.current(operation)) {
      if (!operation.taskAcknowledged) {
        await this.acknowledgeTask(operation);
        operation = this.saved(operation.id);
      }
      for (const predecessor of operation.calendarPredecessors ?? []) {
        if (!this.current(operation)) return;
        await this.calendar.recoverProjection(
          predecessor.uid,
          predecessor.snapshot,
          predecessor.path,
          predecessor.base,
        );
      }
      for (const removal of this.calendarRemovals(operation)) {
        if (!this.current(operation)) return;
        await this.calendar.recoverProjection(
          removal.uid,
          removal.snapshot,
          removal.path,
        );
        await this.calendar.removeProjection(
          removal.uid,
          removal.snapshot,
          removal.path,
        );
      }
      if (!this.current(operation)) return;
      let eventId: string | undefined;
      if (
        operation.plan!.interval &&
        !operation.unlink &&
        !operation.repairCaptureTag
      )
        eventId = await this.calendar.syncProjection(
          operation.googleUid,
          operation.plan!.block!.snapshot,
        );
      if (!this.current(operation)) return;
      await this.service.registry.change((state) => {
        if (!operation.unlink && !operation.repairCaptureTag) {
          const projection = operation.occurrenceId
            ? state.occurrences[operation.occurrenceId]!.projections[
                operation.linkUid
              ]
            : state.projections[operation.linkUid];
          if (!projection)
            throw new TaskReadError(
              "Restore this saved calendar projection before acknowledging it.",
            );
          projection.googleEventId = eventId;
        }
        const saved = state.schedules.find((item) => item.id === operation.id)!;
        saved.phase = "complete";
        saved.error = undefined;
      });
      if (operation.occurrenceId) this.service.publish();
      this.publish();
    }
  }

  private async acknowledgeTask(operation: ScheduleOperation) {
    await this.service.registry.change((state) => {
      if (!this.current(operation)) return;
      const saved = state.schedules.find((item) => item.id === operation.id)!;
      const finalId =
        operation.providerSteps?.at(-1)?.id ?? operation.providerOperationId;
      const result = resolvedTaskOperation(state.operations, finalId);
      if (
        (operation.syncTaskDate || operation.providerSteps?.length) &&
        (result.status !== "complete" || !result.task)
      )
        throw new TaskProjectionConflict(
          "Verify the saved provider commands before acknowledging this note.",
        );
      const occurrence = operation.occurrenceId
        ? state.occurrences[operation.occurrenceId]
        : undefined;
      if (
        operation.occurrenceId &&
        (!occurrence ||
          !["freezing", "complete"].includes(occurrence.phase) ||
          occurrence.provider !== operation.provider ||
          occurrence.accountId !== operation.accountId ||
          occurrence.before.task.id !== operation.task.id ||
          !occurrenceCompletionVerified(state, occurrence))
      )
        throw new TaskProjectionConflict(
          "Verify this occurrence's completion before acknowledging its historical note.",
        );
      const task = occurrence
        ? { ...occurrence.before.task, completed: true }
        : result.status === "complete" && result.task
          ? result.task
          : operation.task;
      const link = state.links[operation.linkUid]!;
      const deletion = operation.deletionId
        ? state.deletions[operation.deletionId]
        : undefined;
      if (
        operation.missingSource ||
        operation.deletionId ||
        (operation.unlink && operation.occurrenceUndoId)
      )
        state.detached[operation.linkUid] = {
          reason: operation.occurrenceUndoId
            ? "retired"
            : operation.deletionId
              ? "deleted"
              : "missing",
          deletionId: operation.deletionId,
          occurrenceId: operation.occurrenceUndoId,
          link: {
            ...(deletion?.links[operation.linkUid] ?? link),
            source: operation.previous ?? link.source,
            noteBase: operation.unlinkNoteBase ?? link.noteBase,
          },
          projection:
            deletion?.projections[operation.linkUid] ??
            state.projections[operation.linkUid],
          operationId: operation.id,
          detachedAt: new Date().toISOString(),
        };
      const fields =
        operation.providerSteps?.flatMap((step) =>
          Object.keys(mutationFields(step.mutation)),
        ) ?? Object.keys(operation.providerChanges ?? {});
      const base =
        operation.target.kind === "reconcile" && !operation.repairCaptureTag
          ? task
          : {
              ...(link.base ?? operation.task),
              ...Object.fromEntries(
                fields.map((field) => [
                  field,
                  task[field as keyof ProviderTask],
                ]),
              ),
            };
      state.projections[operation.linkUid]!.base = base;
      link.base = base;
      if (
        operation.target.kind === "reconcile" &&
        !operation.repairCaptureTag
      ) {
        link.noteBase = operation.plan!.links[0]!.source;
        delete state.issues[operation.linkUid];
      }
      saved.taskAcknowledged = true;
      if (operation.occurrenceId) {
        const record = state.occurrences[operation.occurrenceId]!;
        for (const planned of operation.plan!.links) {
          if (!record.before.links[planned.uid]) continue;
          const archived = state.links[planned.uid]!;
          record.links[planned.uid] = archived;
          if (state.projections[planned.uid])
            record.projections[planned.uid] = state.projections[planned.uid]!;
          delete state.links[planned.uid];
          delete state.projections[planned.uid];
          delete state.issues[planned.uid];
        }
        const remaining = Object.entries(record.before.links).some(
          ([uid, previous]) =>
            previous.taskId === record.before.task.id && state.links[uid],
        );
        if (!remaining) record.phase = "complete";
        record.error = undefined;
      }
      if (operation.unlink) {
        delete state.links[operation.linkUid];
        delete state.projections[operation.linkUid];
        delete state.issues[operation.linkUid];
      }
      saved.phase = "calendar-pending";
      saved.error = undefined;
    });
    this.service.publish();
    this.publish();
  }

  private async acknowledgeLocal(operation: ScheduleOperation) {
    if (!this.current(operation)) return;
    const plan = operation.plan!;
    await this.service.registry.change((state) => {
      if (!this.current(operation)) return;
      for (const link of plan.links)
        state.links[link.uid] = {
          provider: operation.provider,
          accountId: operation.accountId,
          taskId: link.task.id,
          source: link.source,
          noteBase:
            state.links[link.uid]?.noteBase ??
            state.links[link.uid]?.source ??
            link.source,
          base: state.links[link.uid]?.base ?? link.task,
        };
      state.projections[operation.linkUid] = {
        provider: operation.provider,
        accountId: operation.accountId,
        taskId: operation.task.id,
        linkUid: operation.linkUid,
        googleUid: plan.interval ? operation.googleUid : undefined,
        googleEventId: state.projections[operation.linkUid]?.googleEventId,
        occurrenceKey: operation.occurrenceKey,
        source: plan.links[0]!.source,
        interval: plan.interval,
        base: operation.task,
      };
      state.schedules.find((item) => item.id === operation.id)!.phase =
        "local-applied";
    });
    this.publish();
  }

  private async replaceResolvedProjection(operation: ScheduleOperation) {
    const state = this.service.registry.snapshot();
    const final = operation.providerSteps!.at(-1)!;
    const result = resolvedTaskOperation(state.operations, final.id);
    if (result.status !== "complete" || !result.task)
      throw new TaskProjectionConflict(
        "Verify the resolved task before applying its note choices.",
      );
    const occurrence = result.operationId
      ? state.occurrences[result.operationId]
      : undefined;
    const task =
      occurrence?.phase === "freezing"
        ? { ...occurrence.before.task, completed: true }
        : result.task;
    const source = operation.plan!.links[0]!.source;
    const text = await this.host.read(source.path);
    const from = text === null ? -1 : locateSource(text, source);
    if (from < 0)
      throw new TaskProjectionConflict(
        "The note changed after conflict review. Review its latest content before applying the chosen values.",
      );
    const snapshot = get(this.service.state).snapshot!;
    const fields = [
      ...new Set(
        operation.providerSteps!.flatMap((step) =>
          Object.keys(mutationFields(step.mutation)),
        ),
      ),
    ];
    const raw = rewriteTaskNote(
      source.raw,
      task,
      taskAccountSettings(this.host.settings(), snapshot),
      fields,
    );
    const interval =
      operation.plan!.interval &&
      (operation.occurrenceId ||
        fields.includes("due") ||
        fields.includes("duration"))
        ? intervalForTaskDate(
            operation.plan!.interval,
            task,
            snapshot.account.timezone,
            snapshot.account.capabilities?.duration === true,
          )
        : operation.plan!.interval;
    const replacement = scheduleOperationSchema.parse({
      ...operation,
      id: crypto.randomUUID(),
      providerOperationId: crypto.randomUUID(),
      task,
      occurrenceId:
        occurrence?.phase === "freezing" ? occurrence.id : undefined,
      target: { kind: "reconcile", interval },
      previous: { ...source, from },
      previousInterval: operation.plan!.interval ?? undefined,
      raw,
      providerSteps: [],
      syncTaskDate: false,
      providerChanges: undefined,
      phase: "pending",
      plan: undefined,
      error: undefined,
      createdAt: new Date().toISOString(),
    });
    await this.service.registry.change((current) => {
      const saved = current.schedules.find((item) => item.id === operation.id)!;
      if (saved.phase !== "provider-pending")
        throw new TaskReadError(
          "The saved projection changed during conflict recovery.",
        );
      saved.phase = "cancelled";
      current.schedules.push(replacement);
    });
    this.again = true;
    this.publish();
  }

  private planLinks(
    operation: ScheduleOperation,
    path: string,
    from: number,
    raw: string,
    nesting?: {
      sourceText: string;
      destinationText: string;
      sourceIndent: string;
      indent: string;
    },
  ) {
    const previousFrom =
      operation.previous && nesting
        ? locateSource(nesting.sourceText, operation.previous)
        : 0;
    const parsed = nesting
      ? parseCaptureCandidates(path, nesting.destinationText).filter(
          (candidate) =>
            candidate.from >= from && candidate.to <= from + raw.length,
        )
      : parseCaptureCandidates(path, raw);
    const old = operation.previous
      ? parseCaptureCandidates(
          operation.previous.path,
          nesting?.sourceText ?? operation.previous.raw,
        ).filter(
          (candidate) =>
            !nesting ||
            (candidate.from >= previousFrom &&
              candidate.to <= previousFrom + operation.previous!.raw.length),
        )
      : [];
    const state = this.service.registry.snapshot();
    return parsed.flatMap((candidate, index) => {
      let uid = index === 0 ? operation.linkUid : undefined;
      let task =
        index === 0
          ? operation.task
          : operation.children.find(
              (child) => child.id === operation.generatedTaskIds[index],
            );
      if (task && !uid) uid = crypto.randomUUID().replace(/-/g, "");
      const oldRaw = old[index]?.raw;
      const comparable =
        nesting && oldRaw
          ? indentTaskSubtree(
              oldRaw,
              nesting.sourceIndent,
              nesting.indent,
              raw.includes("\r\n") ? "\r\n" : "\n",
            ).trimStart()
          : oldRaw;
      if (!task && operation.previous && comparable === candidate.raw) {
        const matched = Object.entries(state.links).find(
          ([, link]) =>
            link.provider === operation.provider &&
            link.accountId === operation.accountId &&
            link.source.path === operation.previous!.path &&
            link.source.from ===
              operation.previous!.from + old[index]!.from - previousFrom &&
            link.source.raw === old[index]!.raw,
        );
        if (matched?.[1].base) {
          uid = matched[0];
          task = matched[1].base;
        }
      }
      return uid && task
        ? [
            {
              uid,
              task,
              source: {
                path,
                from: nesting ? candidate.from : from + candidate.from,
                raw: candidate.raw,
                title: candidate.title,
              },
            },
          ]
        : [];
    });
  }

  private async prepareUntimed(
    operation: ScheduleOperation,
  ): Promise<NonNullable<ScheduleOperation["plan"]>> {
    const lines = operation.raw.split(/\r?\n/),
      range = getTimeRangeMatch(lines[0] ?? "");
    if (range && !operation.unlink && !operation.repairCaptureTag)
      lines[0] = (
        lines[0]!.slice(0, range.startIndex).trimEnd() +
        " " +
        lines[0]!.slice(range.endIndex).trimStart()
      ).trimEnd();
    let raw = lines.join(operation.raw.includes("\r\n") ? "\r\n" : "\n");
    let nesting:
      | { sourceText: string; sourceIndent: string; indent: string }
      | undefined;
    const edits: NonNullable<ScheduleOperation["plan"]>["edits"] = [];
    const target = operation.target;
    const path =
      target.kind === "insert" ? target.path : operation.previous!.path;
    const before = await this.host.read(path);
    if (before === null)
      throw new TaskProjectionConflict(
        "The destination note is missing. Restore it before moving this task.",
      );
    if (target.kind === "insert" && target.parent) {
      const parent = target.parent;
      if (
        parent.path !== path ||
        locateSource(before, parent) !== parent.from ||
        target.offset !== parent.from + parent.raw.length
      )
        throw new TaskProjectionConflict(
          "The parent block changed before adding its subtask.",
        );
      const lineStart = before.lastIndexOf("\n", parent.from - 1) + 1;
      const indent =
        before.slice(lineStart, parent.from) +
        parent.raw.match(/^(?:[-*+]|\d+[.)])[ \t]+/)![0].replace(/[^\t]/g, " ");
      const source = operation.previous
        ? operation.previous.path === path
          ? before
          : await this.host.read(operation.previous.path)
        : "";
      const sourceFrom =
        operation.previous && source !== null
          ? locateSource(source, operation.previous)
          : 0;
      if (source === null || sourceFrom < 0)
        throw new TaskProjectionConflict(
          "The linked task changed before adding it as a subtask.",
        );
      const sourceIndent = source.slice(
        source.lastIndexOf("\n", sourceFrom - 1) + 1,
        sourceFrom,
      );
      const newline = before.includes("\r\n") ? "\r\n" : "\n";
      raw = indentTaskSubtree(raw, sourceIndent, indent, newline);
      nesting = { sourceText: source, sourceIndent, indent };
    }
    let after = before,
      from = operation.previous?.from ?? 0;
    if (target.kind === "insert") {
      if (before !== target.before || target.offset > before.length)
        throw new TaskProjectionConflict(
          "The destination note changed after the drop. Review its current content before inserting this task.",
        );
      let offset = target.offset;
      if (operation.previous?.path === path) {
        const index = locateSource(before, operation.previous);
        if (
          index < 0 ||
          (offset >= index && offset < index + operation.previous.raw.length)
        )
          throw new TaskProjectionConflict(
            "Drop outside the existing task block to move it.",
          );
        after =
          before.slice(0, index) +
          before.slice(index + operation.previous.raw.length);
        if (offset > index) offset -= operation.previous.raw.length;
      }
      const newline = before.includes("\r\n") ? "\r\n" : "\n";
      const prefix = offset && after[offset - 1] !== "\n" ? newline : "";
      const suffix = /^\r?\n/.test(after.slice(offset)) ? "" : newline;
      from = offset + prefix.length;
      after =
        after.slice(0, offset) + prefix + raw + suffix + after.slice(offset);
    } else {
      const index = locateSource(before, operation.previous!);
      if (index < 0)
        throw new TaskProjectionConflict(
          "The linked task changed before removing its time. Refresh its note link and retry.",
        );
      from = index;
      after =
        before.slice(0, index) +
        raw +
        before.slice(index + operation.previous!.raw.length);
    }
    edits.push({ path, before, after });
    if (operation.previous && operation.previous.path !== path) {
      const source = await this.host.read(operation.previous.path);
      const index =
        source === null ? -1 : locateSource(source, operation.previous);
      if (source === null || index < 0)
        throw new TaskProjectionConflict(
          "The source task changed before the move. Refresh its note link and retry.",
        );
      edits.push({
        path: operation.previous.path,
        before: source,
        after:
          source.slice(0, index) +
          source.slice(index + operation.previous.raw.length),
      });
    }
    return {
      edits,
      links: this.planLinks(
        operation,
        path,
        from,
        raw,
        nesting && { ...nesting, destinationText: after },
      ),
      interval:
        operation.unlink || operation.repairCaptureTag
          ? (operation.previousInterval ?? null)
          : null,
    };
  }

  private async editsApplied(edits: { path: string; after: string }[]) {
    return (
      await Promise.all(
        edits.map(
          async (edit) => (await this.host.read(edit.path)) === edit.after,
        ),
      )
    ).every(Boolean);
  }

  stop() {
    this.stopped = true;
    this.drag.cancel();
  }
}
