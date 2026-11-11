import { get, writable } from "svelte/store";

import type { GoogleCalendarSync } from "../google-calendar/service";
import { getTimeRangeMatch } from "../parser/parser";
import { locateSource } from "../service/source-identity";

import { parseCaptureCandidates } from "./capture-parser";
import {
  taskAccountSettings,
  type TaskCaptureSettings,
} from "./capture-settings";
import { TaskDrag } from "./drag";
import { resolvedTaskOperation } from "./operations";
import {
  newTaskMarkdown,
  scheduleNoteTitle,
  taskSubtree,
} from "./schedule-markdown";
import {
  scheduleIntervalSchema,
  intervalForTaskDate,
  scheduleOperationSchema,
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
      "editNotes" | "syncProjection" | "removeProjection"
    >,
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

  unschedule(taskId: string) {
    return this.enqueue(taskId, { kind: "unschedule" }, crypto.randomUUID());
  }

  private async enqueue(
    taskId: string,
    target: ScheduleOperation["target"],
    id: string,
  ) {
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
          !["complete", "cancelled"].includes(operation.phase),
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
      occurrenceKey:
        projection?.occurrenceKey ??
        (task.due?.recurring
          ? JSON.stringify([task.due.date, task.due.text, task.due.timezone])
          : "single"),
      target,
      previous,
      previousInterval: projection?.interval ?? undefined,
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
            !["complete", "cancelled"].includes(item.phase),
        )
      )
        throw new TaskReadError(
          "This task already has a saved schedule change.",
        );
      current.schedules.push(operation);
      return operation;
    });
    this.publish();
    void this.resume();
    return saved;
  }

  private current(operation: ScheduleOperation) {
    const browser = get(this.service.state);
    return (
      !this.stopped &&
      browser.writable &&
      browser.snapshot?.provider === operation.provider &&
      browser.snapshot.account.id === operation.accountId
    );
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
    if (operation.phase === "conflict")
      throw new TaskReadError(
        "Review the note or task conflict before retrying this schedule.",
      );
    await this.update(id, { error: undefined });
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
        if (operation.target.kind === "schedule") {
          const matching = operation.previous
            ? blocks.filter(
                (block) =>
                  block.path === operation.previous!.path &&
                  block.raw === operation.previous!.raw,
              )
            : [];
          const adopted =
            matching.find((block) => block.uid === operation.googleUid) ??
            matching.find((block) => block.from === operation.previous!.from) ??
            (matching.length === 1 ? matching[0] : undefined);
          googleUid = adopted?.uid ?? googleUid;
          const snapshot = {
            ...operation.target.interval,
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
            interval: operation.target.interval,
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
        if (!alreadyApplied) {
          if (plan.block)
            await notes.applyWrite({ block: plan.block, edits: plan.edits });
          else await notes.applyEdits(plan.edits);
        }
        if (!this.current(operation)) return;
        await this.service.registry.change((state) => {
          for (const link of plan.links)
            state.links[link.uid] = {
              provider: operation.provider,
              accountId: operation.accountId,
              taskId: link.task.id,
              source: link.source,
              base: link.task,
            };
          state.projections[operation.linkUid] = {
            provider: operation.provider,
            accountId: operation.accountId,
            taskId: operation.task.id,
            linkUid: operation.linkUid,
            googleUid: plan.interval ? operation.googleUid : undefined,
            occurrenceKey: operation.occurrenceKey,
            source: plan.links[0]!.source,
            interval: plan.interval,
            base: operation.task,
          };
          state.schedules.find((item) => item.id === operation.id)!.phase =
            "local-applied";
        });
        this.publish();
      });
      operation = this.saved(operation.id);
    }
    if (!this.current(operation)) return;
    if (operation.phase === "local-applied") {
      await this.update(operation.id, {
        phase: operation.syncTaskDate ? "provider-pending" : "calendar-pending",
      });
      operation = this.saved(operation.id);
    }
    if (operation.phase === "provider-pending") {
      if (operation.target.kind !== "schedule" || !this.current(operation))
        return;
      await this.service.mutate(
        {
          kind: "update",
          taskId: operation.task.id,
          changes: operation.providerChanges!,
        },
        undefined,
        {
          id: operation.providerOperationId,
          base: operation.task,
          provider: operation.provider,
          accountId: operation.accountId,
        },
      );
      await this.service.refresh();
      if (!this.current(operation)) return;
      const saved = this.service.registry
        .snapshot()
        .operations.find((item) => item.id === operation.providerOperationId)!;
      if (["conflict", "failed"].includes(saved.status))
        throw new TaskProjectionConflict(
          saved.error ?? "Review the task date change before continuing.",
        );
      if (saved.status !== "complete") {
        await this.update(operation.id, { error: saved.error });
        return;
      }
      await this.update(operation.id, {
        phase: "calendar-pending",
        error: undefined,
      });
      operation = this.saved(operation.id);
    }
    if (operation.phase === "calendar-pending" && this.current(operation)) {
      let eventId: string | undefined;
      if (operation.target.kind === "schedule")
        eventId = await this.calendar.syncProjection(
          operation.googleUid,
          operation.plan!.block!.snapshot,
        );
      else if (operation.previousInterval && operation.previous)
        await this.calendar.removeProjection(
          operation.googleUid,
          {
            ...operation.previousInterval,
            title: scheduleNoteTitle(operation.previous.raw),
          },
          operation.previous.path,
        );
      if (!this.current(operation)) return;
      await this.service.registry.change((state) => {
        const projection = state.projections[operation.linkUid]!;
        projection.googleEventId = eventId;
        const taskWrite = state.operations.find(
          (item) => item.id === operation.providerOperationId,
        );
        if (taskWrite?.readback) {
          projection.base = {
            ...projection.base,
            due: taskWrite.readback.due,
            duration: taskWrite.readback.duration,
          };
          state.links[operation.linkUid]!.base = projection.base;
        }
        const saved = state.schedules.find((item) => item.id === operation.id)!;
        saved.phase = "complete";
        saved.error = undefined;
      });
      this.publish();
    }
  }

  private planLinks(
    operation: ScheduleOperation,
    path: string,
    from: number,
    raw: string,
  ) {
    const parsed = parseCaptureCandidates(path, raw);
    const old = operation.previous
      ? parseCaptureCandidates(operation.previous.path, operation.previous.raw)
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
      if (!task && operation.previous && old[index]?.raw === candidate.raw) {
        const matched = Object.entries(state.links).find(
          ([, link]) =>
            link.provider === operation.provider &&
            link.accountId === operation.accountId &&
            link.source.path === operation.previous!.path &&
            link.source.from === operation.previous!.from + old[index]!.from &&
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
                from: from + candidate.from,
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
    if (range)
      lines[0] = (
        lines[0]!.slice(0, range.startIndex).trimEnd() +
        " " +
        lines[0]!.slice(range.endIndex).trimStart()
      ).trimEnd();
    const raw = lines.join(operation.raw.includes("\r\n") ? "\r\n" : "\n");
    const edits: NonNullable<ScheduleOperation["plan"]>["edits"] = [];
    const target = operation.target;
    const path =
      target.kind === "insert" ? target.path : operation.previous!.path;
    const before = await this.host.read(path);
    if (before === null)
      throw new TaskProjectionConflict(
        "The destination note is missing. Restore it before moving this task.",
      );
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
      const prefix = offset && after[offset - 1] !== "\n" ? "\n" : "";
      const suffix = after[offset] === "\n" ? "" : "\n";
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
      links: this.planLinks(operation, path, from, raw),
      interval: null,
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
