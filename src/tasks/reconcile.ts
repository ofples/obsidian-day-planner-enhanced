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
import {
  isOutstanding,
  mutationFields,
  operationTaskId,
  sameTaskField,
  type TaskMutation,
  type TaskPatch,
} from "./operations";
import { rewriteTaskNote } from "./reconcile-markdown";
import type { TaskLink, TaskReconcileIssue } from "./registry";
import type { TaskScheduler } from "./schedule";
import {
  intervalForTaskDate,
  taskOccurrenceKey,
  type ScheduleInterval,
  type TaskProjection,
} from "./schedule-types";
import type { TaskService } from "./service";
import { TaskReadError, type ProviderTask, type TaskSnapshot } from "./types";

function sameInterval(
  first: ScheduleInterval | null,
  second: ScheduleInterval | null,
) {
  return first === null || second === null
    ? first === second
    : Date.parse(first.start) === Date.parse(second.start) &&
        Date.parse(first.end) === Date.parse(second.end);
}

export function planTaskReconciliation(input: {
  link: TaskLink;
  candidate: CaptureCandidate;
  remote: ProviderTask;
  projection?: TaskProjection;
  block?: LocalBlock;
  snapshot: TaskSnapshot;
  settings: TaskCaptureSettings;
}) {
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
  const merge = <T>(
    field: string,
    localBase: T,
    remoteBase: T,
    local: T,
    upstream: T,
    same: (first: T, second: T) => boolean = (first, second) =>
      JSON.stringify(first) === JSON.stringify(second),
  ) => {
    const localChanged = !same(localBase, local),
      remoteChanged = !same(remoteBase, upstream);
    if (localChanged && remoteChanged && !same(local, upstream))
      conflicts.push(field);
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
  if (!desiredTitle.trim())
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
    base.due?.recurring &&
    (candidate.completed !==
      (link.noteBase ? noteBase.completed : base.completed) ||
      !sameTaskField(base.due, remote.due, "due"))
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
    raw,
    mutations,
    interval,
    source: candidate,
    googleUid: block?.uid,
    changed:
      raw !== candidate.raw ||
      mutations.length > 0 ||
      !sameInterval(interval, baseline) ||
      Boolean(interval && (link.noteBase ?? link.source).raw !== candidate.raw),
  };
}

export class TaskReconciler {
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
  ) {}

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
      browser.writable &&
      browser.snapshot?.provider === snapshot.provider &&
      browser.snapshot.account.id === snapshot.account.id
    );
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
    const browser = get(this.service.state),
      snapshot = browser.snapshot;
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
        state.schedules.some(
          (operation) =>
            operation.provider === link.provider &&
            operation.accountId === link.accountId &&
            operation.task.id === link.taskId &&
            !["complete", "cancelled"].includes(operation.phase),
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
      const candidate = this.capture
        .candidates()
        .find((candidate) => candidate.uid === uid);
      if (!candidate) {
        await this.issue(
          uid,
          link,
          snapshot.tasks.find((task) => task.id === link.taskId) ?? null,
          ["source"],
          "The linked note task is missing. Restore it or unlink this task.",
        );
        continue;
      }
      if (!(await this.capture.sourceIsCurrent(candidate))) continue;
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
