import { get, writable } from "svelte/store";

import type { LocalBlock } from "../google-calendar/types";
import { getTimeRangeMatch } from "../parser/parser";

import type { TaskCapture } from "./capture";
import {
  captureTitle,
  parseCaptureCandidates,
  type CaptureCandidate,
} from "./capture-parser";
import {
  taskAccountSettings,
  type TaskCaptureSettings,
} from "./capture-settings";
import type {
  TaskConflictChoices,
  TaskConflictDisplay,
  TaskConflictField,
  TaskConflictValues,
} from "./conflict";
import { pendingTaskDeletion } from "./deletion-types";
import { TaskIdentityRepairController } from "./identity-repair";
import { pendingIdentityDecision } from "./identity-types";
import { freezeTaskOccurrences } from "./occurrence-freeze";
import { observeExternalTaskOccurrences } from "./occurrence-observe";
import { pendingTaskOccurrence } from "./occurrence-types";
import { TaskOccurrenceUndoController } from "./occurrence-undo";
import {
  isOutstanding,
  mutationFields,
  operationTaskId,
  sameTaskField,
  type TaskMutation,
  type TaskPatch,
} from "./operations";
import {
  rewriteTaskNote,
  taskCaptureTagRemoved,
  withoutTaskCaptureTag,
  withTaskCaptureTag,
} from "./reconcile-markdown";
import type { TaskLink, TaskReconcileIssue } from "./registry";
import type { TaskScheduler } from "./schedule";
import {
  intervalForTaskDate,
  scheduleIntervalSchema,
  scheduleBlocksTask,
  taskOccurrenceKey,
  type ScheduleInterval,
  type TaskProjection,
} from "./schedule-types";
import type { TaskService } from "./service";
import {
  TaskReadError,
  taskSchema,
  type ProviderTask,
  type TaskSnapshot,
} from "./types";

interface NoteFieldComparison {
  key: string;
  base: unknown;
  local: unknown;
  remote: unknown;
}
interface NotePlanInput {
  link: TaskLink;
  candidate: CaptureCandidate;
  remote: ProviderTask;
  projection?: TaskProjection;
  block?: LocalBlock;
  snapshot: TaskSnapshot;
  settings: TaskCaptureSettings;
  choices?: TaskConflictChoices;
}
export interface TaskNoteConflictReview extends TaskConflictDisplay {
  issue: TaskReconcileIssue;
  fingerprint: string;
}

function comparisonValues(key: string, value: unknown): TaskConflictValues {
  if (key === "schedule")
    return { interval: scheduleIntervalSchema.nullable().parse(value) };
  if (key.startsWith("label:"))
    return {
      labels: taskSchema.shape.completed.parse(value) ? [key.slice(6)] : [],
    };
  return taskSchema.partial().parse({ [key]: value });
}

function sameInterval(
  first: ScheduleInterval | null,
  second: ScheduleInterval | null,
) {
  return first === null || second === null
    ? first === second
    : Date.parse(first.start) === Date.parse(second.start) &&
        Date.parse(first.end) === Date.parse(second.end);
}

export function planTaskReconciliation(input: NotePlanInput) {
  const { link, candidate, remote, projection, block, snapshot, settings } =
    input;
  const base = link.base!;
  const noteBase = parseCaptureCandidates(
    "",
    (link.noteBase ?? link.source).raw,
  )[0];
  if (!noteBase)
    throw new TaskReadError(
      "Restore the acknowledged checklist text before reconciling this link.",
    );
  const account = taskAccountSettings(settings, snapshot);
  const routing = new Set([
    "todoist",
    ...Object.keys(account.projectMappings),
    ...Object.keys(account.labelMappings),
  ]);
  const title = (note: CaptureCandidate) =>
    captureTitle(
      note,
      new Set(
        note.tags
          .filter((tag) => routing.has(tag.name.toLowerCase()))
          .map((tag) => tag.name),
      ),
    );
  const conflicts: string[] = [];
  const comparisons: NoteFieldComparison[] = [];
  const merge = <T>(
    field: string,
    localBase: T,
    remoteBase: T,
    local: T,
    upstream: T,
    same: (first: T, second: T) => boolean = (first, second) =>
      JSON.stringify(first) === JSON.stringify(second),
    remoteChangedOverride = false,
  ) => {
    const localChanged = !same(localBase, local),
      remoteChanged = remoteChangedOverride || !same(remoteBase, upstream);
    const invalidTitle =
      field === "title" && typeof local === "string" && !local.trim();
    if (
      localChanged &&
      (invalidTitle || (remoteChanged && !same(local, upstream)))
    ) {
      comparisons.push({
        key: field,
        base: remoteBase,
        local,
        remote: upstream,
      });
      if (input.choices?.[field] === "remote") return upstream;
      if (input.choices?.[field] !== "local") conflicts.push(field);
    }
    return localChanged ? local : upstream;
  };
  const desiredTitle = merge(
    "title",
    link.noteBase ? title(noteBase) : base.title,
    base.title,
    title(candidate),
    remote.title,
  );
  const titleChanged =
    (link.noteBase ? title(noteBase) : base.title) !== title(candidate) ||
    base.title !== remote.title;
  if (
    !desiredTitle.trim() &&
    desiredTitle !== remote.title &&
    !conflicts.includes("title")
  )
    throw new TaskReadError(
      "Enter a title before synchronizing this linked task.",
    );
  const completed = merge(
    "completed",
    link.noteBase ? noteBase.completed : base.completed,
    base.completed,
    candidate.completed,
    remote.completed,
  );
  if (
    (base.due?.recurring &&
      ((base.completionCount === undefined
        ? !sameTaskField(base.due, remote.due, "due")
        : base.completionCount !== remote.completionCount) ||
        (candidate.completed !==
          (link.noteBase ? noteBase.completed : base.completed) &&
          (!candidate.completed ||
            remote.completed ||
            (remote.due?.recurring &&
              remote.completionCount === undefined))))) ||
    (completed !== remote.completed &&
      remote.due?.recurring &&
      remote.completionCount === undefined)
  )
    conflicts.push("recurrence");
  const projectTags = (note: CaptureCandidate) =>
    note.tags
      .map((tag) => tag.name.toLowerCase())
      .filter((tag) => account.projectMappings[tag])
      .toSorted();
  const currentProjectTags = projectTags(candidate);
  const projects = [
    ...new Set(currentProjectTags.map((tag) => account.projectMappings[tag]!)),
  ];
  if (projects.length > 1)
    throw new TaskReadError(
      "Choose one mapped project tag for this linked task.",
    );
  const localProject =
    !link.noteBase ||
    JSON.stringify(currentProjectTags) !== JSON.stringify(projectTags(noteBase))
      ? (projects[0] ?? base.projectId)
      : base.projectId;
  const projectId = merge(
    "projectId",
    base.projectId,
    base.projectId,
    localProject,
    remote.projectId,
  );
  if (!snapshot.projects.some((project) => project.id === projectId))
    throw new TaskReadError(
      "Choose an available project for this linked task.",
    );
  const labels = new Set(remote.labels);
  const tags = new Set(candidate.tags.map((tag) => tag.name.toLowerCase()));
  const originalTags = new Set(
    noteBase.tags.map((tag) => tag.name.toLowerCase()),
  );
  for (const label of new Set(Object.values(account.labelMappings))) {
    const names = Object.entries(account.labelMappings)
      .filter(([, name]) => name === label)
      .map(([tag]) => tag);
    const before = link.noteBase
        ? names.some((tag) => originalTags.has(tag))
        : base.labels.includes(label),
      local = names.some((tag) => tags.has(tag));
    const wanted = merge(
      `label:${label}`,
      before,
      base.labels.includes(label),
      local,
      remote.labels.includes(label),
    );
    if (wanted) labels.add(label);
    else labels.delete(label);
  }
  const baseline = projection?.interval ?? null;
  const localInterval = block
    ? { start: block.snapshot.start, end: block.snapshot.end }
    : null;
  const syncDate = account.syncScheduleToTaskDate !== false;
  const remoteScheduleChanged =
    syncDate &&
    (!sameTaskField(base.due, remote.due, "due") ||
      (snapshot.account.capabilities?.duration &&
        !sameTaskField(base.duration, remote.duration, "duration")));
  const remoteInterval =
    baseline && remoteScheduleChanged
      ? intervalForTaskDate(
          baseline,
          remote,
          snapshot.account.timezone,
          snapshot.account.capabilities?.duration === true,
        )
      : baseline;
  const interval = merge(
    "schedule",
    baseline,
    baseline,
    localInterval,
    remoteInterval,
    sameInterval,
    Boolean(
      remoteScheduleChanged &&
        (remote.due === null ||
          (snapshot.account.capabilities?.duration &&
            base.duration &&
            !remote.duration)),
    ),
  );
  const desired = {
    ...remote,
    title: desiredTitle,
    completed,
    projectId,
    labels: [...labels],
  };
  const fields: string[] = [];
  if (titleChanged && desiredTitle !== title(candidate)) fields.push("title");
  if (completed !== candidate.completed) fields.push("completed");
  if (projectId !== localProject) fields.push("projectId");
  const currentMappedLabels = Object.entries(account.labelMappings)
    .filter(([tag]) => tags.has(tag))
    .map(([, name]) => name);
  const labelTagsChanged =
    JSON.stringify(
      candidate.tags
        .map((tag) => tag.name.toLowerCase())
        .filter((tag) => account.labelMappings[tag])
        .toSorted(),
    ) !==
    JSON.stringify(
      noteBase.tags
        .map((tag) => tag.name.toLowerCase())
        .filter((tag) => account.labelMappings[tag])
        .toSorted(),
    );
  if (
    (labelTagsChanged ||
      !sameTaskField(base.labels, remote.labels, "labels")) &&
    !sameTaskField(
      currentMappedLabels,
      desired.labels.filter((label) =>
        Object.values(account.labelMappings).includes(label),
      ),
      "labels",
    )
  )
    fields.push("labels");
  const raw = rewriteTaskNote(candidate.raw, desired, account, fields);
  const mutations: { mutation: TaskMutation; base: ProviderTask }[] = [];
  let expected = remote;
  const add = (mutation: TaskMutation) => {
    mutations.push({ mutation, base: expected });
    expected = { ...expected, ...mutationFields(mutation) };
  };
  if (projectId !== remote.projectId)
    add({ kind: "moveProject", taskId: remote.id, projectId });
  const changes: TaskPatch = {};
  if (desiredTitle !== remote.title) changes.title = desiredTitle;
  if (!sameTaskField(desired.labels, remote.labels, "labels"))
    changes.labels = desired.labels;
  if (
    syncDate &&
    interval &&
    !sameInterval(localInterval, baseline) &&
    sameInterval(interval, localInterval)
  ) {
    changes.due = {
      date: interval.start,
      recurring: remote.due?.recurring ?? false,
      text: remote.due?.recurring ? remote.due.text : "",
      timezone: remote.due?.timezone ?? snapshot.account.timezone,
    };
    if (snapshot.account.capabilities?.duration)
      changes.duration = {
        amount:
          (Date.parse(interval.end) - Date.parse(interval.start)) / 60_000,
        unit: "minute",
      };
  }
  if (Object.keys(changes).length)
    add({ kind: "update", taskId: remote.id, changes });
  if (completed !== remote.completed)
    add({ kind: completed ? "complete" : "reopen", taskId: remote.id });
  return {
    conflicts: [...new Set(conflicts)],
    comparisons,
    raw,
    mutations,
    interval,
    source: candidate,
    googleUid: block?.uid,
    localScheduleDue: localInterval
      ? {
          date: localInterval.start,
          text: remote.due?.recurring ? remote.due.text : "",
          recurring: remote.due?.recurring ?? false,
          timezone: remote.due?.timezone ?? snapshot.account.timezone,
        }
      : remote.due,
    localScheduleDuration: localInterval
      ? {
          amount:
            (Date.parse(localInterval.end) - Date.parse(localInterval.start)) /
            60_000,
          unit: "minute" as const,
        }
      : remote.duration,
    changed:
      raw !== candidate.raw ||
      mutations.length > 0 ||
      !sameInterval(interval, baseline) ||
      Boolean(
        interval && (link.noteBase ?? link.source).raw !== candidate.raw,
      ) ||
      Boolean(interval && !projection?.googleUid),
  };
}

export class TaskReconciler {
  readonly occurrenceUndo: TaskOccurrenceUndoController;
  readonly identity: TaskIdentityRepairController;
  readonly state = writable<{ issues: TaskReconcileIssue[]; error: string }>({
    issues: [],
    error: "",
  });
  private pending?: Promise<void>;
  private again = false;
  private stopped = false;

  get running() {
    return Boolean(this.pending);
  }

  constructor(
    private readonly service: TaskService,
    private readonly capture: TaskCapture,
    private readonly scheduler: TaskScheduler,
    private readonly settings: () => TaskCaptureSettings,
  ) {
    this.identity = new TaskIdentityRepairController(
      service,
      capture,
      settings,
      () => !this.stopped,
    );
    this.occurrenceUndo = new TaskOccurrenceUndoController(
      service,
      capture,
      scheduler,
      settings,
      () => !this.stopped,
    );
  }

  publish() {
    if (this.stopped) return;
    const snapshot = get(this.service.state).snapshot;
    this.state.update((state) => ({
      ...state,
      issues: Object.values(this.service.registry.snapshot().issues).filter(
        (issue) =>
          issue.provider === snapshot?.provider &&
          issue.accountId === snapshot.account.id,
      ),
    }));
  }

  async retryOccurrence(id: string) {
    await this.pending;
    const snapshot = get(this.service.state).snapshot;
    const record = this.service.registry.snapshot().occurrences[id];
    if (
      !snapshot ||
      !this.current(snapshot) ||
      record?.provider !== snapshot.provider ||
      record.accountId !== snapshot.account.id
    )
      throw new TaskReadError(
        "Reconnect the original task account before retrying this occurrence's history.",
      );
    for (const operation of this.service.registry
      .snapshot()
      .schedules.filter(
        (item) =>
          item.occurrenceId === id &&
          !["complete", "cancelled"].includes(item.phase),
      ))
      await this.scheduler.retry(operation.id);
    await this.scan();
    this.service.publish();
  }

  scan(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.pending) {
      this.again = true;
      return this.pending;
    }
    const pending = this.run().catch((error: unknown) => {
      if (!this.stopped)
        this.state.update((state) => ({
          ...state,
          error:
            error instanceof Error
              ? error.message
              : "Linked tasks need review before reconciliation can continue.",
        }));
    });
    this.pending = pending;
    return pending.finally(() => {
      this.pending = undefined;
      if (this.again && !this.stopped) {
        this.again = false;
        void this.scan();
      }
    });
  }

  private current(snapshot: TaskSnapshot) {
    const browser = get(this.service.state);
    return (
      !this.stopped &&
      this.capture.ready() &&
      browser.writable &&
      browser.snapshot?.provider === snapshot.provider &&
      browser.snapshot.account.id === snapshot.account.id
    );
  }

  private async conflictContext(id: string) {
    await this.pending;
    await this.capture.scan();
    const snapshot = get(this.service.state).snapshot;
    if (!snapshot || !this.current(snapshot))
      throw new TaskReadError(
        "Reconnect the original task account before reviewing this note.",
      );
    const state = this.service.registry.snapshot();
    const issue = Object.values(state.issues).find(
      (issue) =>
        issue.id === id &&
        issue.provider === snapshot.provider &&
        issue.accountId === snapshot.account.id,
    );
    const link = issue && state.links[issue.linkUid];
    if (!issue || !link?.taskId || !link.base)
      throw new TaskReadError(
        "This note conflict changed. Recheck the linked task.",
      );
    if (
      issue.fields.some((field) =>
        ["source", "task", "recurrence", "unlink"].includes(field),
      )
    )
      throw new TaskReadError(
        "Restore this note/task link or review its recurring occurrence before choosing field values.",
      );
    if (
      state.schedules.some(
        (operation) =>
          operation.linkUid === issue.linkUid && scheduleBlocksTask(operation),
      ) ||
      state.operations.some(
        (operation) =>
          operation.provider === issue.provider &&
          operation.accountId === issue.accountId &&
          operationTaskId(operation) === issue.taskId &&
          isOutstanding(operation),
      )
    )
      throw new TaskReadError(
        "Finish this task's saved change before reviewing another note conflict.",
      );
    const candidate = this.capture
      .candidates()
      .find((candidate) => candidate.uid === issue.linkUid);
    if (!candidate || !(await this.capture.sourceIsCurrent(candidate)))
      throw new TaskReadError(
        "Leave the linked task's edited line and reopen its comparison.",
      );
    const remote = await this.service.readTask(link.taskId);
    if (!remote || !this.current(snapshot))
      throw new TaskReadError(
        "The linked task/account is unavailable. Recheck its connection.",
      );
    const projection = state.projections[issue.linkUid];
    let block: LocalBlock | undefined;
    if (
      projection?.interval ||
      getTimeRangeMatch(candidate.raw.split(/\r?\n/)[0] ?? "")
    )
      block = (await this.scheduler.scanNotes()).find(
        (block) =>
          block.path === candidate.path &&
          block.from === candidate.from &&
          block.raw === candidate.raw,
      );
    if (
      !this.current(snapshot) ||
      !(await this.capture.sourceIsCurrent(candidate)) ||
      JSON.stringify(this.service.registry.snapshot().links[issue.linkUid]) !==
        JSON.stringify(link)
    )
      throw new TaskReadError(
        "The linked note changed during comparison. Reopen its latest values.",
      );
    const input: NotePlanInput = {
      link,
      candidate,
      remote,
      projection,
      block,
      snapshot,
      settings: this.settings(),
    };
    const plan = planTaskReconciliation(input);
    if (plan.conflicts.includes("recurrence"))
      throw new TaskReadError(
        "This recurring occurrence changed. Review its occurrence history before applying values.",
      );
    const values = (
      comparison: NoteFieldComparison,
      side: "base" | "local" | "remote",
    ): TaskConflictValues => {
      const result = comparisonValues(comparison.key, comparison[side]);
      if (comparison.key !== "schedule") return result;
      result.due =
        side === "local"
          ? plan.localScheduleDue
          : side === "base"
            ? link.base!.due
            : remote.due;
      if (snapshot.account.capabilities?.duration)
        result.duration =
          side === "local"
            ? plan.localScheduleDuration
            : side === "base"
              ? link.base!.duration
              : remote.duration;
      return result;
    };
    const fields: TaskConflictField[] = plan.comparisons.map((comparison) => ({
      key: comparison.key,
      fields: Object.keys(
        values(comparison, "local"),
      ) as (keyof TaskConflictValues)[],
      base: values(comparison, "base"),
      local: values(comparison, "local"),
      remote: values(comparison, "remote"),
      conflict: true,
      localAllowed:
        comparison.key !== "title" ||
        Boolean(taskSchema.shape.title.parse(comparison.local).trim()),
      localUnavailableReason:
        comparison.key === "title"
          ? "Enter a nonempty note title to use it, or keep the provider title."
          : undefined,
    }));
    const review: TaskNoteConflictReview = {
      issue,
      current: remote,
      title: remote.title,
      localLabel: "Current note",
      fields,
      fingerprint: JSON.stringify({
        issue: issue.id,
        link,
        candidate,
        remote,
        owner: { provider: snapshot.provider, account: snapshot.account },
        interval: block?.snapshot,
        account: taskAccountSettings(input.settings, snapshot),
      }),
    };
    return { input, review };
  }

  async inspectConflict(id: string) {
    return (await this.conflictContext(id)).review;
  }

  async resolveConflict(
    review: TaskNoteConflictReview,
    choices: TaskConflictChoices,
  ): Promise<
    { kind: "changed"; review: TaskNoteConflictReview } | { kind: "saved" }
  > {
    const fresh = await this.conflictContext(review.issue.id);
    if (fresh.review.fingerprint !== review.fingerprint)
      return { kind: "changed", review: fresh.review };
    if (
      Object.keys(choices).some(
        (key) => !fresh.review.fields.some((field) => field.key === key),
      ) ||
      fresh.review.fields.some(
        (field) =>
          !["local", "remote"].includes(choices[field.key] ?? "") ||
          (choices[field.key] === "local" && !field.localAllowed),
      )
    )
      throw new TaskReadError("Choose a value for every conflicting field.");
    const plan = planTaskReconciliation({ ...fresh.input, choices });
    if (plan.conflicts.length)
      throw new TaskReadError(
        "Review the remaining field conflicts before applying this comparison.",
      );
    await this.scheduler.reconcile({
      ...plan,
      linkUid: fresh.review.issue.linkUid,
      task: fresh.input.remote,
      expectedLink: fresh.input.link,
    });
    this.publish();
    return { kind: "saved" };
  }

  private async linkedNoteContext(linkUid: string, deletionId?: string) {
    await this.pending;
    await this.capture.scan();
    const snapshot = get(this.service.state).snapshot;
    if (!snapshot || !this.current(snapshot))
      throw new TaskReadError(
        "Reconnect the original task account before reviewing its note link.",
      );
    const state = this.service.registry.snapshot();
    const link = state.links[linkUid];
    if (
      link?.taskId &&
      pendingTaskDeletion(
        state,
        { provider: link.provider, accountId: link.accountId },
        link.taskId,
        deletionId,
      )
    )
      throw new TaskReadError(
        "Finish this task's saved deletion before reviewing its note link.",
      );
    if (
      !link?.taskId ||
      !link.base ||
      link.provider !== snapshot.provider ||
      link.accountId !== snapshot.account.id
    )
      throw new TaskReadError(
        "This note link changed. Refresh before reviewing it.",
      );
    if (
      state.operations.some(
        (operation) =>
          operation.provider === link.provider &&
          operation.accountId === link.accountId &&
          operationTaskId(operation) === link.taskId &&
          isOutstanding(operation),
      )
    )
      throw new TaskReadError(
        "Finish this task's saved change before reviewing its note link.",
      );
    const source = this.capture
      .candidates()
      .find((candidate) => candidate.uid === linkUid);
    if (!source || !(await this.capture.sourceIsCurrent(source)))
      throw new TaskReadError(
        "Choose the current note block before reviewing this task link.",
      );
    return { link, source, state, task: link.base };
  }

  async unlink(linkUid: string, deletionId?: string) {
    const { link, source, state, task } = await this.linkedNoteContext(
      linkUid,
      deletionId,
    );
    await this.scheduler.reconcile({
      linkUid,
      task,
      source,
      raw: withoutTaskCaptureTag(source.raw),
      interval: state.projections[linkUid]?.interval ?? null,
      mutations: [],
      expectedLink: link,
      unlink: true,
      deletionId,
    });
    this.publish();
  }

  async keepLinked(linkUid: string) {
    const { link, source, state, task } = await this.linkedNoteContext(linkUid);
    const operation = await this.scheduler.reconcile({
      linkUid,
      task,
      source,
      raw: withTaskCaptureTag(source.raw, link.noteBase?.raw),
      interval: state.projections[linkUid]?.interval ?? null,
      mutations: [],
      expectedLink: link,
      repairCaptureTag: true,
    });
    const saved = this.service.registry
      .snapshot()
      .schedules.find((item) => item.id === operation.id);
    if (!saved?.taskAcknowledged)
      throw new TaskReadError(
        saved?.error ??
          "Finish the saved tag restoration before closing this decision.",
      );
    await this.scan();
    this.publish();
  }

  private async issue(
    uid: string,
    link: TaskLink,
    remote: ProviderTask | null,
    fields: string[],
    message: string,
    source?: CaptureCandidate,
  ) {
    if (this.stopped) return;
    await this.service.registry.change((state) => {
      if (this.stopped) return;
      const previous = state.issues[uid];
      state.issues[uid] = {
        id: previous?.id ?? crypto.randomUUID(),
        provider: link.provider,
        accountId: link.accountId,
        linkUid: uid,
        taskId: link.taskId!,
        source,
        remote,
        fields,
        message,
      };
    });
    this.publish();
  }

  private async run() {
    const browser = get(this.service.state);
    let snapshot = browser.snapshot;
    if (
      !snapshot ||
      !browser.writable ||
      browser.loading ||
      browser.error ||
      !this.capture.ready()
    )
      return;
    this.publish();
    await this.capture.scan();
    if (!this.current(snapshot)) return;
    if (get(this.capture.state).error)
      throw new TaskReadError(get(this.capture.state).error);
    await this.identity.resume();
    await this.occurrenceUndo.resume();
    if (!this.current(snapshot)) return;
    snapshot = get(this.service.state).snapshot;
    if (
      !snapshot ||
      get(this.service.state).loading ||
      get(this.service.state).error
    )
      return;
    await observeExternalTaskOccurrences(
      this.service,
      this.capture,
      snapshot,
      () => this.current(snapshot),
    );
    if (!this.current(snapshot)) return;
    await freezeTaskOccurrences(
      this.service,
      this.capture,
      this.scheduler,
      snapshot,
      this.settings(),
      () => this.current(snapshot),
    );
    if (!this.current(snapshot)) return;
    const inspection = await this.capture.inspectCurrentIdentities();
    let blocks: LocalBlock[] | undefined;
    for (const uid of Object.keys(this.service.registry.snapshot().links)) {
      if (!this.current(snapshot)) return;
      const state = this.service.registry.snapshot(),
        link = state.links[uid]!;
      if (
        !link.taskId ||
        !link.base ||
        link.provider !== snapshot.provider ||
        link.accountId !== snapshot.account.id
      )
        continue;
      if (
        pendingIdentityDecision(state, link, link.taskId) ||
        pendingTaskOccurrence(state, link, link.taskId) ||
        pendingTaskDeletion(
          state,
          { provider: link.provider, accountId: link.accountId },
          link.taskId,
        ) ||
        state.schedules.some(
          (operation) =>
            operation.provider === link.provider &&
            operation.accountId === link.accountId &&
            operation.task.id === link.taskId &&
            scheduleBlocksTask(operation),
        ) ||
        state.operations.some(
          (operation) =>
            operation.provider === link.provider &&
            operation.accountId === link.accountId &&
            operationTaskId(operation) === link.taskId &&
            isOutstanding(operation),
        )
      )
        continue;
      const candidate = inspection.candidates.find(
        (candidate) => candidate.uid === uid,
      );
      if (!candidate) {
        const missing = await this.capture.missingSource(uid, inspection);
        if (missing === undefined) continue;
        if (missing && this.current(snapshot)) {
          await this.scheduler.reconcile({
            linkUid: uid,
            task: link.base,
            source: link.source,
            raw: link.source.raw,
            interval: state.projections[uid]?.interval ?? null,
            mutations: [],
            expectedLink: link,
            unlink: true,
            missingSource: missing,
          });
          continue;
        }
        const identityIssue = inspection.identityIssues.find((issue) =>
          issue.uids.includes(uid),
        );
        await this.issue(
          uid,
          link,
          snapshot.tasks.find((task) => task.id === link.taskId) ?? null,
          ["source"],
          identityIssue?.message ??
            "The linked note task is missing. Restore it or unlink this task.",
        );
        continue;
      }
      if (!(await this.capture.sourceIsCurrent(candidate))) continue;
      if (
        taskCaptureTagRemoved((link.noteBase ?? link.source).raw, candidate)
      ) {
        await this.issue(
          uid,
          link,
          snapshot.tasks.find((task) => task.id === link.taskId) ?? link.base,
          ["unlink"],
          "The capture tag was removed. Review whether to unlink this note.",
          candidate,
        );
        continue;
      }
      const remote =
        snapshot.tasks.find((task) => task.id === link.taskId) ??
        (await this.service.readTask(link.taskId));
      if (!this.current(snapshot)) return;
      if (!remote) {
        await this.issue(
          uid,
          link,
          null,
          ["task"],
          "The provider task is unavailable. Review its note link.",
          candidate,
        );
        continue;
      }
      const projection = state.projections[uid];
      let block: LocalBlock | undefined;
      if (
        projection?.interval ||
        getTimeRangeMatch(candidate.raw.split(/\r?\n/)[0] ?? "")
      ) {
        blocks ??= await this.scheduler.scanNotes();
        block = blocks.find(
          (block) =>
            block.path === candidate.path &&
            block.from === candidate.from &&
            block.raw === candidate.raw,
        );
        if (!block) {
          blocks = await this.scheduler.scanNotes();
          block = blocks.find(
            (block) =>
              block.path === candidate.path &&
              block.from === candidate.from &&
              block.raw === candidate.raw,
          );
        }
        if (
          !this.current(snapshot) ||
          !(await this.capture.sourceIsCurrent(candidate))
        )
          continue;
      }
      try {
        const plan = planTaskReconciliation({
          link,
          candidate,
          remote,
          projection,
          block,
          snapshot,
          settings: this.settings(),
        });
        if (plan.conflicts.length) {
          await this.issue(
            uid,
            link,
            remote,
            plan.conflicts,
            "The note and provider changed the same fields. Review both values before continuing.",
            candidate,
          );
          continue;
        }
        if (
          !(await this.capture.sourceIsCurrent(candidate)) ||
          !this.current(snapshot)
        )
          continue;
        if (plan.changed) {
          await this.scheduler.reconcile({
            ...plan,
            linkUid: uid,
            task: remote,
            expectedLink: link,
          });
          blocks = undefined;
        } else if (
          !projection ||
          JSON.stringify(link.base) !== JSON.stringify(remote) ||
          JSON.stringify(link.noteBase) !==
            JSON.stringify({
              path: candidate.path,
              from: candidate.from,
              raw: candidate.raw,
              title: candidate.title,
            }) ||
          state.issues[uid]
        )
          await this.service.registry.change((current) => {
            if (
              !this.current(snapshot) ||
              JSON.stringify(current.links[uid]) !== JSON.stringify(link)
            )
              return;
            current.links[uid]!.base = remote;
            current.links[uid]!.noteBase = {
              path: candidate.path,
              from: candidate.from,
              raw: candidate.raw,
              title: candidate.title,
            };
            current.projections[uid] = {
              provider: link.provider,
              accountId: link.accountId,
              taskId: remote.id,
              linkUid: uid,
              occurrenceKey: taskOccurrenceKey(remote),
              interval: null,
              ...current.projections[uid],
              base: remote,
              source: {
                path: candidate.path,
                from: candidate.from,
                raw: candidate.raw,
                title: candidate.title,
              },
            };
            delete current.issues[uid];
          });
        this.scheduler.publish();
      } catch (error) {
        if (!this.current(snapshot)) return;
        if (!(error instanceof TaskReadError)) throw error;
        await this.issue(
          uid,
          link,
          remote,
          ["source"],
          error.message,
          candidate,
        );
      }
    }
    if (!this.stopped) {
      this.state.update((state) => ({ ...state, error: "" }));
      this.publish();
    }
  }

  stop() {
    this.stopped = true;
  }
}
