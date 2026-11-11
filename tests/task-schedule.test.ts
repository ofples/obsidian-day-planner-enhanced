import { TFile, type App } from "obsidian";
import { DateTime } from "luxon";
import { get } from "svelte/store";
import { describe, expect, test, vi } from "vitest";

import {
  recoverCalendarProjection,
  syncCalendar,
} from "../src/google-calendar/engine";
import { sameSnapshot } from "../src/google-calendar/types";
import { ObsidianCalendarNotes } from "../src/google-calendar/notes";
import type {
  CalendarApi,
  CalendarSyncState,
  GoogleEvent,
} from "../src/google-calendar/types";
import type { GoogleCalendarSync } from "../src/google-calendar/service";
import type { PeriodicNotes } from "../src/service/periodic-notes";
import { defaultSettings } from "../src/settings";
import { parseCaptureCandidates } from "../src/tasks/capture-parser";
import { TaskCapture } from "../src/tasks/capture";
import { TaskDeletionController } from "../src/tasks/deletion";
import { taskSubtree } from "../src/tasks/browser";
import { TaskReconciler } from "../src/tasks/reconcile";
import { mutationFields } from "../src/tasks/operations";
import { taskCaptureSettingsSchema } from "../src/tasks/capture-settings";
import type { TaskOperation } from "../src/tasks/operations";
import { TaskScheduler } from "../src/tasks/schedule";
import { scheduleOperationSchema } from "../src/tasks/schedule-types";
import { TaskService } from "../src/tasks/service";
import type { ProviderTask, TaskSnapshot } from "../src/tasks/types";

const root: ProviderTask = {
  id: "root",
  title: "Work",
  description: "Keep",
  projectId: "work",
  parentId: null,
  labels: [],
  priority: 1,
  completed: false,
  order: 1,
  due: null,
};
const child: ProviderTask = {
  ...root,
  id: "child",
  title: "Child",
  parentId: root.id,
  order: 2,
};
const interval = { start: "2026-11-11T09:00:00Z", end: "2026-11-11T09:30:00Z" };

async function harness() {
  let cache: string | null = null,
    taskDisk: string | null = null,
    secret = "";
  let failTaskWrite = false,
    failPath = "",
    failCalendar = false,
    loseCalendarResponse = false;
  let stable = true;
  let loseTaskResponse = false;
  let exportGuardFailure = "";
  const exportGuard = vi.fn(async () => { if (exportGuardFailure) throw new Error(exportGuardFailure); });
  let failWriteCountdown = 0;
  const calendarSettings = structuredClone(defaultSettings);
  let calendarState: CalendarSyncState = {
    version: 2,
    namespace: "c".repeat(32),
    calendarId: "managed",
    records: {},
  };
  let calendarDisk = JSON.stringify(calendarState);
  const texts = new Map<string, string>(),
    files = new Map<string, TFile>();
  const tasks = new Map([
    [root.id, structuredClone(root)],
    [child.id, structuredClone(child)],
  ]);
  const events = new Map<string, GoogleEvent>();
  const file = (path: string) => {
    let value = files.get(path);
    if (!value) {
      value = Object.assign(new TFile(), { path });
      files.set(path, value);
    }
    return value;
  };
  const process = vi.fn(
    async (value: TFile, update: (text: string) => string) => {
      if (value.path === failPath) throw new Error("interrupted note write");
      const next = update(texts.get(value.path) ?? "");
      texts.set(value.path, next);
      return next;
    },
  );
  const app = {
    vault: {
      getAbstractFileByPath: (path: string) => files.get(path),
      getMarkdownFiles: () => [...files.values()],
      read: async (value: TFile) => texts.get(value.path) ?? "",
      process,
    },
  } as unknown as App;
  const daily = {
    getAllDailyNotes: () =>
      Object.fromEntries(
        [...files].filter(([path]) => path.startsWith("Daily/")),
      ),
    getDateFromFile: (value: TFile) =>
      window.moment(value.path.slice(6, -3), "YYYY-MM-DD", true),
    createDailyNoteIfNeeded: async (day: ReturnType<typeof window.moment>) => {
      const path = `Daily/${day.format("YYYY-MM-DD")}.md`;
      if (!texts.has(path))
        texts.set(path, "# Day planner\n\n# Journal\nKeep journal.\n");
      return file(path);
    },
  } as unknown as PeriodicNotes;
  const makeNotes = () =>
    new ObsidianCalendarNotes(
      app,
      daily,
      calendarSettings,
      "2026-11-01T00:00:00Z",
      "2026-12-01T00:00:00Z",
      calendarState,
      async () => {
        calendarDisk = JSON.stringify(calendarState);
      },
    );
  let notes = makeNotes();
  const api: CalendarApi = {
    list: async () => [...events.values()],
    get: async (id) => events.get(id) ?? null,
    create: async (id, uid, snapshot) => {
      const event = {
        id,
        etag: "one",
        summary: snapshot.title,
        start: { dateTime: snapshot.start },
        end: { dateTime: snapshot.end },
        extendedProperties: {
          private: {
            dayPlannerVault: calendarState.namespace,
            dayPlannerBlock: uid,
          },
        },
      };
      events.set(id, event);
      if (loseCalendarResponse) {
        failCalendar = true;
        throw new Error("calendar response lost");
      }
      return event;
    },
    update: async (event, snapshot) => {
      const updated = {
        ...event,
        etag: "two",
        summary: snapshot.title,
        start: { dateTime: snapshot.start },
        end: { dateTime: snapshot.end },
      };
      events.set(event.id, updated);
      if (loseCalendarResponse) {
        failCalendar = true;
        throw new Error("calendar response lost");
      }
      return updated;
    },
    remove: async (event) => {
      events.delete(event.id);
    },
  };
  const calendar: Pick<
    GoogleCalendarSync,
    "editNotes" | "syncProjection" | "recoverProjection" | "removeProjection" | "assertTaskExportAllowed"
  > = {
    assertTaskExportAllowed: exportGuard,
    editNotes: async (edit) => edit(notes, await notes.scan()),
    recoverProjection: async (uid, snapshot, path, base) => {
      if (failCalendar) throw new Error("calendar offline");
      await recoverCalendarProjection({
        uid,
        snapshot,
        path,
        base,
        state: calendarState,
        api,
        save: async () => {
          calendarDisk = JSON.stringify(calendarState);
        },
      });
    },
    syncProjection: async (uid, expected) => {
      if (failCalendar) throw new Error("calendar offline");
      await syncCalendar({
        state: calendarState,
        api,
        notes,
        save: async () => {
          calendarDisk = JSON.stringify(calendarState);
        },
        timeMin: "2026-11-01T00:00:00Z",
        timeMax: "2026-12-01T00:00:00Z",
        importEvents: false,
      });
      const record = calendarState.records[uid];
      if (!record || record.deleted || !sameSnapshot(record.base, expected))
        throw new Error("calendar projection not verified");
      return record.eventId;
    },
    removeProjection: async (uid) => {
      if (failCalendar) throw new Error("calendar offline");
      const record = calendarState.records[uid];
      if (record) {
        events.delete(record.eventId);
        record.deleted = true;
        calendarDisk = JSON.stringify(calendarState);
      }
    },
  };
  const snapshot = (): TaskSnapshot => ({
    provider: "todoist",
    account: {
      id: "account",
      name: "Test",
      timezone: "UTC",
      capabilities: { duration: false, delete: true },
    },
    projects: [{ id: "work", name: "Work", order: 1, inbox: true }],
    tasks: structuredClone(
      [...tasks.values()].filter((task) => !task.completed),
    ),
    fetchedAt: new Date().toISOString(),
  });
  const commands = new Map<string, string>();
  const apply = vi.fn(async (operation: TaskOperation) => {
    if (!commands.has(operation.id) && operation.mutation.kind === "delete") {
      const remote = tasks.get(operation.mutation.taskId);
      if (remote) {
        for (const item of taskSubtree({ ...snapshot(), tasks: [...tasks.values()].map(task => ({ ...task, completed: false })) }, remote))
          tasks.delete(item.task.id);
        tasks.delete(remote.id);
      }
    }
    else if (!commands.has(operation.id) && operation.mutation.kind === "complete" && operation.base?.due?.recurring) {
      const remote = tasks.get(operation.mutation.taskId)!;
      const due = remote.due!;
      tasks.set(remote.id, {
        ...remote,
        completed: false,
        completionCount: remote.completionCount! + 1,
        due: { ...due, date: DateTime.fromISO(due.date, { zone: due.timezone ?? "UTC" }).plus({ days: 1 }).toISO()! },
      });
    }
    else if (!commands.has(operation.id) && operation.mutation.kind !== "create")
      tasks.set(operation.mutation.taskId, {
        ...tasks.get(operation.mutation.taskId)!,
        ...mutationFields(operation.mutation),
      });
    commands.set(operation.id, "applied");
    if (loseTaskResponse && operation.mutation.kind === "complete") {
      loseTaskResponse = false;
      throw new Error("completion response lost");
    }
    return {
      taskId:
        operation.mutation.kind === "create"
          ? "unexpected"
          : operation.mutation.taskId,
    };
  });
  const readTask = vi.fn(async (id: string) => structuredClone(tasks.get(id) ?? null));
  const provider = () => ({
    read: async () => snapshot(),
    get: readTask,
    apply,
  });
  const storage = {
    read: async () => cache,
    write: async (text: string) => {
      cache = text;
    },
    readState: async () => taskDisk,
    writeState: async (text: string) => {
      if (failWriteCountdown && --failWriteCountdown === 0)
        throw new Error("task state interrupted");
      if (failTaskWrite) throw new Error("task state offline");
      taskDisk = text;
    },
    getSecret: () => secret,
    setSecret: (_key: string, value: string) => {
      secret = value;
    },
  };
  let service = new TaskService(storage, provider);
  await service.initialize();
  await service.connect("token");
  const host = {
    read: async (path: string) => texts.get(path) ?? null,
    flush: async () => {},
    settings: () => taskCaptureSettingsSchema.parse({}),
  };
  let scheduler = new TaskScheduler(service, calendar, host);
  const makeCapture = () =>
    new TaskCapture(service, {
      candidates: () =>
        [...texts].flatMap(([path, text]) =>
          parseCaptureCandidates(path, text),
        ),
      read: host.read,
      stable: () => stable,
      stableMissing: () => stable,
      paths: () => [...texts.keys()],
      ready: () => true,
      settings: host.settings,
    });
  let capture = makeCapture();
  let reconciler = new TaskReconciler(
    service,
    capture,
    scheduler,
    host.settings,
  );
  let deleter = new TaskDeletionController(service, capture, scheduler, reconciler);
  return {
    get deleter() { return deleter; },
    get capture() { return capture; },
    get service() {
      return service;
    },
    get scheduler() {
      return scheduler;
    },
    get notes() {
      return notes;
    },
    get reconciler() {
      return reconciler;
    },
    get calendarState() {
      return calendarState;
    },
    texts,
    file,
    events,
    tasks,
    apply,
    readTask,
    exportGuard,
    setExportGuardFailure(value: string) { exportGuardFailure = value; },
    process,
    setFailTaskWrite(value: boolean) {
      failTaskWrite = value;
    },
    setFailPath(value: string) {
      failPath = value;
    },
    setFailCalendar(value: boolean) {
      failCalendar = value;
    },
    setLoseCalendarResponse(value: boolean) {
      loseCalendarResponse = value;
    },
    setLoseTaskResponse(value: boolean) { loseTaskResponse = value; },
    setStable(value: boolean) {
      stable = value;
    },
    failWriteAfter(count: number) {
      failWriteCountdown = count;
    },
    async syncCalendar(syncDeletions = false) {
      calendarSettings.googleCalendar.syncDeletions = syncDeletions;
      return syncCalendar({
        state: calendarState,
        api,
        notes,
        save: async () => {
          calendarDisk = JSON.stringify(calendarState);
        },
        timeMin: "2026-11-01T00:00:00Z",
        timeMax: "2026-12-01T00:00:00Z",
        importEvents: false,
      });
    },
    async settle() {
      await scheduler.resume();
      await vi.waitUntil(() => !get(service.state).loading);
      await scheduler.resume();
    },
    async reconcile() {
      await reconciler.scan();
      await scheduler.resume();
      await vi.waitUntil(() => !get(service.state).loading);
      await reconciler.scan();
      await scheduler.resume();
    },
    async indexNotes() {
      await capture.scan();
    },
    async restart() {
      deleter.stop();
      scheduler.stop();
      capture.stop();
      reconciler.stop();
      service.stop();
      calendarState = JSON.parse(calendarDisk);
      notes = makeNotes();
      service = new TaskService(storage, provider);
      await service.initialize();
      scheduler = new TaskScheduler(service, calendar, host);
      capture = makeCapture();
      reconciler = new TaskReconciler(
        service,
        capture,
        scheduler,
        host.settings,
      );
      deleter = new TaskDeletionController(service, capture, scheduler, reconciler);
    },
  };
}

describe("recurring occurrence freezing", () => {
  async function scheduled() {
    const h = await harness();
    h.tasks.set(root.id, {
      ...root,
      completionCount: 0,
      due: {
        date: "2026-11-11",
        text: "every day",
        recurring: true,
        timezone: "UTC",
      },
    });
    await h.service.refresh();
    await h.scheduler.schedule(root.id, interval);
    await h.settle();
    const projection = h.scheduler.projection(root.id)!;
    return { h, projection, source: h.texts.get(projection.source.path)! };
  }

  test("checking the Markdown source completes and archives the same occurrence without a second freeze journal", async () => {
    const { h, projection } = await scheduled();
    const initial = h.texts.get(projection.source.path)!;
    h.texts.set(projection.source.path, initial.replace("- [ ]", "- [x]"));
    await h.reconcile();
    const state = h.service.registry.snapshot();
    const completion = state.operations.find(
      (operation) => operation.mutation.kind === "complete",
    )!;
    const history = state.occurrences[completion.id]!;
    const journal = state.schedules.find(
      (operation) => operation.occurrenceId === completion.id,
    )!;
    expect(history.phase).toBe("complete");
    expect(journal.phase).toBe("complete");
    expect(journal.providerSteps?.at(-1)?.id).toBe(completion.id);
    expect(
      scheduleOperationSchema.safeParse({
        ...journal,
        occurrenceId: crypto.randomUUID(),
      }).success,
    ).toBe(false);
    expect(
      scheduleOperationSchema.safeParse({
        ...journal,
        providerSteps: [
          {
            ...journal.providerSteps!.at(-1)!,
            base: { ...completion.base!, id: "another-task" },
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      state.schedules.filter(
        (operation) => operation.occurrenceId === completion.id,
      ),
    ).toHaveLength(1);
    expect(history.before.task.completionCount).toBe(0);
    expect(history.links[projection.linkUid]?.base).toMatchObject({
      completed: true,
      completionCount: 0,
    });
    expect(h.tasks.get(root.id)).toMatchObject({
      completed: false,
      completionCount: 1,
    });
    expect(
      Date.parse(h.events.get(projection.googleEventId!)!.start!.dateTime!),
    ).toBe(Date.parse(interval.start));
    expect(h.texts.get(projection.source.path)).toBe(
      initial.replace("- [ ]", "- [x]"),
    );
    expect(h.scheduler.projection(root.id)).toBeUndefined();
    await h.restart();
    await h.reconcile();
    expect(
      h.apply.mock.calls.filter(
        ([operation]) => operation.mutation.kind === "complete",
      ),
    ).toHaveLength(1);
    expect(
      h.service.registry.snapshot().occurrences[completion.id]?.phase,
    ).toBe("complete");
    h.service.stop();
  });

  test("a recurring note can change title and time while completing without moving history to the next date", async () => {
    const { h, projection } = await scheduled();
    h.texts.set(
      projection.source.path,
      h.texts
        .get(projection.source.path)!
        .replace("Work #todoist", "Edited work #todoist")
        .replace(/\d{2}:\d{2} - \d{2}:\d{2}/, "16:00 - 16:30")
        .replace("- [ ]", "- [x]"),
    );
    const local = (await h.scheduler.scanNotes()).find((block) =>
      block.raw.includes("Edited work"),
    )!;
    await h.reconcile();
    const history = Object.values(
      h.service.registry.snapshot().occurrences,
    )[0]!;
    expect(history.phase).toBe("complete");
    expect(history.before.task.title).toBe("Edited work");
    expect(Date.parse(history.before.task.due!.date)).toBe(
      Date.parse(local.snapshot.start),
    );
    expect(
      Date.parse(h.events.get(projection.googleEventId!)!.start!.dateTime!),
    ).toBe(Date.parse(local.snapshot.start));
    expect(h.texts.get(projection.source.path)).toContain(
      "[x] 16:00 - 16:30 Edited work",
    );
    expect(h.tasks.get(root.id)?.completionCount).toBe(1);
    expect(h.tasks.get(root.id)?.due?.text).toBe("every day");
    h.service.stop();
  });

  test("a remote reschedule keeps the current occurrence and linked event without another task write", async () => {
    const { h, projection } = await scheduled();
    const current = h.tasks.get(root.id)!;
    const date = DateTime.fromISO(current.due!.date).plus({ days: 1 }).toISO()!;
    h.tasks.set(root.id, { ...current, due: { ...current.due!, date } });
    const count = h.apply.mock.calls.length;
    await h.service.refresh();
    await h.reconcile();
    const moved = h.scheduler.projection(root.id)!;
    expect(moved.linkUid).toBe(projection.linkUid);
    expect(moved.googleEventId).toBe(projection.googleEventId);
    expect(moved.occurrenceKey).toBe(projection.occurrenceKey);
    expect(h.service.registry.snapshot().occurrences).toEqual({});
    expect(
      Date.parse(h.events.get(projection.googleEventId!)!.start!.dateTime!),
    ).toBe(Date.parse(date));
    expect(h.apply).toHaveBeenCalledTimes(count);
    h.service.stop();
  });

  test("a lost note-completion response resumes the original UUID after restart and advances once", async () => {
    const { h, projection } = await scheduled();
    h.setLoseTaskResponse(true);
    h.texts.set(
      projection.source.path,
      h.texts.get(projection.source.path)!.replace("- [ ]", "- [x]"),
    );
    await h.reconcile();
    const operation = h.service.registry
      .snapshot()
      .operations.find((item) => item.mutation.kind === "complete")!;
    expect(operation.status).toBe("sent");
    expect(h.tasks.get(root.id)?.completionCount).toBe(1);
    await h.restart();
    await h.service.retryOperation(operation.id);
    await h.reconcile();
    expect(h.service.registry.snapshot().occurrences[operation.id]?.phase).toBe(
      "complete",
    );
    expect(h.tasks.get(root.id)?.completionCount).toBe(1);
    expect(
      new Set(
        h.apply.mock.calls
          .filter(([item]) => item.mutation.kind === "complete")
          .map(([item]) => item.id),
      ),
    ).toEqual(new Set([operation.id]));
    h.service.stop();
  });

  test("choosing the current rescheduled occurrence discards a stale Markdown completion and moves the open note", async () => {
    const { h, projection } = await scheduled();
    const current = h.tasks.get(root.id)!;
    const nextDate = DateTime.fromISO(current.due!.date)
      .plus({ days: 1 })
      .toISO()!;
    h.tasks.set(root.id, {
      ...current,
      due: { ...current.due!, date: nextDate },
    });
    h.texts.set(
      projection.source.path,
      h.texts.get(projection.source.path)!.replace("- [ ]", "- [x]"),
    );
    await h.reconcile();
    const original = h.service.registry
      .snapshot()
      .operations.find((operation) => operation.mutation.kind === "complete")!;
    expect(original.status).toBe("conflict");
    const review = await h.service.inspectConflict(original.id);
    expect(
      review.fields.find((field) => field.key === "completed")?.localAllowed,
    ).toBe(false);
    await h.service.resolveConflict(review, { completed: "remote" });
    await h.reconcile();
    await h.settle();
    const moved = h.scheduler.projection(root.id)!;
    expect(h.service.registry.snapshot().occurrences[original.id]?.phase).toBe(
      "cancelled",
    );
    expect(moved.source.path).not.toBe(projection.source.path);
    expect(moved.source.raw).toContain("- [ ]");
    expect(moved.googleEventId).toBe(projection.googleEventId);
    expect(
      Date.parse(h.events.get(projection.googleEventId!)!.start!.dateTime!),
    ).toBe(Date.parse(nextDate));
    expect(h.tasks.get(root.id)?.completionCount).toBe(0);
    expect(
      h.apply.mock.calls.filter(
        ([operation]) => operation.mutation.kind === "complete",
      ),
    ).toHaveLength(0);
    h.service.stop();
  });

  test("a reviewed replacement completion archives its own verified occurrence without copying the next date into history", async () => {
    const { h, projection } = await scheduled();
    h.apply.mockImplementationOnce(async (operation) => {
      expect(operation.mutation.kind).toBe("complete");
      return { taskId: root.id };
    });
    h.texts.set(
      projection.source.path,
      h.texts.get(projection.source.path)!.replace("- [ ]", "- [x]"),
    );
    await h.reconcile();
    const original = h.service.registry
      .snapshot()
      .operations.find((operation) => operation.mutation.kind === "complete")!;
    expect(original.status).toBe("conflict");
    const review = await h.service.inspectConflict(original.id);
    expect(
      review.fields.find((field) => field.key === "completed")?.localAllowed,
    ).toBe(true);
    const resolved = await h.service.resolveConflict(review, {
      completed: "local",
    });
    if (resolved.kind !== "saved") throw Error("Review changed unexpectedly");
    await h.reconcile();
    await h.settle();
    const replacementId = resolved.operationIds[0]!;
    const state = h.service.registry.snapshot();
    expect(state.occurrences[original.id]?.phase).toBe("cancelled");
    expect(state.occurrences[replacementId]?.phase).toBe("complete");
    expect(
      state.schedules
        .filter((operation) => operation.occurrenceId === replacementId)
        .at(-1)?.phase,
    ).toBe("complete");
    expect(
      state.occurrences[replacementId]?.links[projection.linkUid]?.base
        ?.completionCount,
    ).toBe(0);
    expect(h.tasks.get(root.id)?.completionCount).toBe(1);
    expect(h.scheduler.projection(root.id)).toBeUndefined();
    expect(
      Date.parse(h.events.get(projection.googleEventId!)!.start!.dateTime!),
    ).toBe(Date.parse(interval.start));
    expect(h.texts.get(projection.source.path)).toContain("- [x]");
    h.service.stop();
  });

  test("completion retains an earlier reviewed title choice in its historical baseline", async () => {
    const { h, projection } = await scheduled();
    h.tasks.set(root.id, { ...h.tasks.get(root.id)!, title: "Remote title" });
    h.texts.set(
      projection.source.path,
      h.texts
        .get(projection.source.path)!
        .replace("Work #todoist", "Local title #todoist")
        .replace("- [ ]", "- [x]"),
    );
    await h.reconcile();
    const original = h.service.registry
      .snapshot()
      .operations.find(
        (operation) =>
          operation.mutation.kind === "update" &&
          operation.mutation.changes.title === "Local title",
      )!;
    expect(original.status).toBe("conflict");
    expect(
      h.apply.mock.calls.filter(
        ([operation]) => operation.mutation.kind === "complete",
      ),
    ).toHaveLength(0);
    const review = await h.service.inspectConflict(original.id);
    await h.service.resolveConflict(review, { title: "remote" });
    await h.reconcile();
    await h.settle();
    const history = Object.values(
      h.service.registry.snapshot().occurrences,
    ).find((record) => record.phase === "complete")!;
    expect(history.before.task.title).toBe("Remote title");
    expect(history.links[projection.linkUid]?.base?.title).toBe("Remote title");
    expect(h.texts.get(projection.source.path)).toContain(
      "Remote title #todoist",
    );
    expect(h.texts.get(projection.source.path)).not.toContain("Local title");
    expect(h.tasks.get(root.id)).toMatchObject({
      title: "Remote title",
      completionCount: 1,
    });
    expect(
      Date.parse(h.events.get(projection.googleEventId!)!.start!.dateTime!),
    ).toBe(Date.parse(interval.start));
    h.service.stop();
  });

  test("a completion-only note change acknowledges Todoist while its calendar is offline", async () => {
    const { h, projection } = await scheduled();
    const guards = h.exportGuard.mock.calls.length;
    h.setExportGuardFailure("calendar offline");
    h.setFailCalendar(true);
    h.texts.set(
      projection.source.path,
      h.texts.get(projection.source.path)!.replace("- [ ]", "- [x]"),
    );
    await h.reconcile();
    const history = Object.values(
      h.service.registry.snapshot().occurrences,
    )[0]!;
    expect(history.phase).toBe("complete");
    expect(h.tasks.get(root.id)?.completionCount).toBe(1);
    expect(h.exportGuard).toHaveBeenCalledTimes(guards);
    expect(
      h.service.registry
        .snapshot()
        .schedules.find((operation) => operation.occurrenceId === history.id)
        ?.phase,
    ).toBe("calendar-pending");
    await h.restart();
    h.setExportGuardFailure("");
    h.setFailCalendar(false);
    await h.settle();
    expect(
      h.service.registry
        .snapshot()
        .schedules.find((operation) => operation.occurrenceId === history.id)
        ?.phase,
    ).toBe("complete");
    expect(
      h.service.registry.snapshot().occurrences[history.id]?.projections[
        projection.linkUid
      ]?.googleEventId,
    ).toBe(projection.googleEventId);
    expect(
      h.apply.mock.calls.filter(
        ([operation]) => operation.mutation.kind === "complete",
      ),
    ).toHaveLength(1);
    h.service.stop();
  });

  test("removing a local time while completing keeps the historical checklist untimed and retires its owned event", async () => {
    const { h, projection } = await scheduled();
    h.texts.set(
      projection.source.path,
      h.texts
        .get(projection.source.path)!
        .replace(/\d{2}:\d{2} - \d{2}:\d{2}\s*/, "")
        .replace("- [ ]", "- [x]"),
    );
    await h.reconcile();
    const history = Object.values(
      h.service.registry.snapshot().occurrences,
    )[0]!;
    expect(history.phase).toBe("complete");
    expect(history.projections[projection.linkUid]?.interval).toBeNull();
    expect(h.texts.get(projection.source.path)).toContain(
      "- [x] Work #todoist",
    );
    expect(h.events.size).toBe(0);
    expect(h.tasks.get(root.id)?.completionCount).toBe(1);
    expect(
      h.apply.mock.calls.filter(
        ([operation]) => operation.mutation.kind === "complete",
      ),
    ).toHaveLength(1);
    h.service.stop();
  });

  test("completion freezes the checked note and children while the next occurrence gets fresh links/events", async () => {
    const { h, projection, source } = await scheduled();
    const oldChildUid = Object.entries(
      h.service.registry.snapshot().links,
    ).find(([, link]) => link.taskId === child.id)![0];
    const completion = await h.service.complete(h.tasks.get(root.id)!);
    await h.service.refresh();
    const before = structuredClone(
      h.service.registry.snapshot().occurrences[completion.id]!.before,
    );
    expect(before.links[projection.linkUid]?.source.raw).toContain("- [ ]");
    expect(
      h.service.registry.snapshot().occurrences[completion.id]?.phase,
    ).toBe("freezing");
    await h.reconcile();
    const record = h.service.registry.snapshot().occurrences[completion.id]!;
    expect(record.phase).toBe("complete");
    expect(record.before).toEqual(before);
    expect(record.links[projection.linkUid]?.source.raw).toContain("- [x]");
    expect(record.links[oldChildUid]?.taskId).toBe(child.id);
    expect(h.texts.get(projection.source.path)).toBe(
      source.replace("- [ ]", "- [x]"),
    );
    expect(record.projections[projection.linkUid]?.googleEventId).toBe(
      projection.googleEventId,
    );
    expect(h.events.size).toBe(1);
    expect(h.scheduler.projection(root.id)).toBeUndefined();
    expect(Object.keys(h.service.registry.snapshot().links)).toHaveLength(0);
    expect(
      get(h.service.state).snapshot?.tasks.find((task) => task.id === root.id),
    ).toMatchObject({ completionCount: 1, completed: false });
    const nextInterval = {
      start: "2026-11-12T10:00:00Z",
      end: "2026-11-12T10:30:00Z",
    };
    await h.scheduler.schedule(root.id, nextInterval);
    await h.settle();
    const next = h.scheduler.projection(root.id)!;
    expect(next.linkUid).not.toBe(projection.linkUid);
    expect(next.googleUid).not.toBe(projection.googleUid);
    expect(next.googleEventId).not.toBe(projection.googleEventId);
    expect(next.occurrenceKey).toBe("recurring:1");
    expect(h.events.size).toBe(2);
    const candidates = h.capture.candidates();
    expect(
      candidates.find((candidate) => candidate.uid === projection.linkUid)
        ?.completed,
    ).toBe(true);
    expect(
      candidates.find((candidate) => candidate.uid === next.linkUid)?.completed,
    ).toBe(false);
    expect(
      candidates.find((candidate) => candidate.uid === oldChildUid)?.path,
    ).toBe(projection.source.path);
    await h.restart();
    await h.reconcile();
    expect(
      h.service.registry.snapshot().occurrences[completion.id]?.before,
    ).toEqual(before);
    expect(h.scheduler.projection(root.id)?.linkUid).toBe(next.linkUid);
    expect(h.events.size).toBe(2);
    expect(
      h.apply.mock.calls.filter(
        ([operation]) => operation.mutation.kind === "complete",
      ),
    ).toHaveLength(1);
    h.service.stop();
  });

  test("a calendar-only history retry remains independent of scheduling the next occurrence across restart", async () => {
    const { h, projection } = await scheduled();
    h.setFailCalendar(true);
    const completion = await h.service.complete(h.tasks.get(root.id)!);
    await h.service.refresh();
    await h.reconcile();
    expect(
      h.service.registry.snapshot().occurrences[completion.id]?.phase,
    ).toBe("complete");
    const freeze = h.service.registry
      .snapshot()
      .schedules.find((operation) => operation.occurrenceId === completion.id)!;
    expect(freeze).toMatchObject({
      phase: "calendar-pending",
      taskAcknowledged: true,
    });
    await h.scheduler.schedule(root.id, {
      start: "2026-11-12T09:00:00Z",
      end: "2026-11-12T09:30:00Z",
    });
    await h.settle();
    expect(
      h.service.registry
        .snapshot()
        .schedules.find((operation) => operation.id === freeze.id)?.phase,
    ).toBe("calendar-pending");
    expect(h.scheduler.projection(root.id)?.occurrenceKey).toBe("recurring:1");
    await h.restart();
    h.setFailCalendar(false);
    await h.settle();
    await h.reconcile();
    expect(
      h.service.registry
        .snapshot()
        .schedules.find((operation) => operation.id === freeze.id)?.phase,
    ).toBe("complete");
    expect(
      h.service.registry.snapshot().occurrences[completion.id]?.projections[
        projection.linkUid
      ]?.googleEventId,
    ).toBe(projection.googleEventId);
    expect(h.events.size).toBe(2);
    expect(
      Date.parse(h.events.get(projection.googleEventId!)!.start!.dateTime!),
    ).toBe(Date.parse(interval.start));
    h.service.stop();
  });

  test("an interrupted historical note write resumes from its saved plan without completing the next task", async () => {
    const { h, projection } = await scheduled();
    const completion = await h.service.complete(h.tasks.get(root.id)!);
    await h.service.refresh();
    h.setFailPath(projection.source.path);
    await h.reconcile();
    expect(
      h.service.registry.snapshot().occurrences[completion.id]?.phase,
    ).toBe("freezing");
    expect(
      h.service.registry.snapshot().occurrences[completion.id]?.error,
    ).toContain("note write");
    await expect(h.scheduler.schedule(root.id, interval)).rejects.toThrow(
      "occurrence history",
    );
    await expect(
      h.service.mutate({
        kind: "update",
        taskId: child.id,
        changes: { title: "Changed" },
      }),
    ).rejects.toThrow("occurrence history");
    await expect(h.deleter.review(root.id)).rejects.toThrow();
    await h.restart();
    h.setFailPath("");
    await h.reconciler.retryOccurrence(completion.id);
    await h.settle();
    expect(
      h.service.registry.snapshot().occurrences[completion.id]?.phase,
    ).toBe("complete");
    expect(h.texts.get(projection.source.path)).toContain("- [x]");
    expect(h.tasks.get(root.id)?.completionCount).toBe(1);
    expect(
      h.apply.mock.calls.filter(
        ([operation]) => operation.mutation.kind === "complete",
      ),
    ).toHaveLength(1);
    h.service.stop();
  });

  test("focused historical edits defer freezing and preserve their note text without changing the next task", async () => {
    const { h, projection } = await scheduled();
    const completion = await h.service.complete(h.tasks.get(root.id)!);
    await h.service.refresh();
    h.setStable(false);
    h.texts.set(
      projection.source.path,
      h.texts
        .get(projection.source.path)!
        .replace("Work #todoist", "Historical title #todoist"),
    );
    await h.reconcile();
    expect(
      h.service.registry.snapshot().occurrences[completion.id]?.phase,
    ).toBe("freezing");
    expect(get(h.reconciler.state).issues).toHaveLength(0);
    h.setStable(true);
    await h.reconcile();
    expect(
      h.service.registry.snapshot().occurrences[completion.id]?.phase,
    ).toBe("complete");
    expect(h.texts.get(projection.source.path)).toContain("Historical title");
    expect(h.tasks.get(root.id)?.title).toBe(root.title);
    h.service.stop();
  });

  test("unchecking a historical occurrence reserves its old identity and never creates or reopens a task", async () => {
    const { h, projection } = await scheduled();
    const completion = await h.service.complete(h.tasks.get(root.id)!);
    await h.service.refresh();
    await h.reconcile();
    const count = h.apply.mock.calls.length;
    h.texts.set(
      projection.source.path,
      h.texts.get(projection.source.path)!.replace("- [x]", "- [ ]"),
    );
    await h.capture.scan();
    await h.reconcile();
    expect(get(h.capture.state).issues[0]?.occurrenceId).toBe(completion.id);
    expect(h.apply).toHaveBeenCalledTimes(count);
    expect(h.tasks.get(root.id)?.completionCount).toBe(1);
    expect(h.service.registry.snapshot().links).toEqual({});
    h.service.stop();
  });

  test("an independently scheduled child retains its active projection when its parent occurrence is frozen", async () => {
    const { h } = await scheduled();
    await h.scheduler.schedule(child.id, {
      start: "2026-11-12T11:00:00Z",
      end: "2026-11-12T11:30:00Z",
    });
    await h.settle();
    await h.indexNotes();
    const independent = h.scheduler.projection(child.id)!;
    const completion = await h.service.complete(h.tasks.get(root.id)!);
    await h.service.refresh();
    await h.reconcile();
    const record = h.service.registry.snapshot().occurrences[completion.id]!;
    expect(record.phase).toBe("complete");
    expect(
      Object.values(record.links).some((link) => link.taskId === child.id),
    ).toBe(false);
    expect(h.scheduler.projection(child.id)?.linkUid).toBe(independent.linkUid);
    expect(h.scheduler.projection(child.id)?.googleEventId).toBe(
      independent.googleEventId,
    );
    await h.scheduler.schedule(root.id, {
      start: "2026-11-13T10:00:00Z",
      end: "2026-11-13T10:30:00Z",
    });
    await h.settle();
    expect(
      h.texts.get(h.scheduler.projection(root.id)!.source.path),
    ).not.toContain(child.title);
    expect(h.tasks.get(child.id)?.parentId).toBe(root.id);
    expect(h.events.size).toBe(3);
    h.service.stop();
  });

  test("moving a completed note retains history identities independently of the next occurrence", async () => {
    const { h, projection } = await scheduled();
    const completion = await h.service.complete(h.tasks.get(root.id)!);
    await h.service.refresh();
    await h.reconcile();
    await h.scheduler.schedule(root.id, {
      start: "2026-11-12T10:00:00Z",
      end: "2026-11-12T10:30:00Z",
    });
    await h.settle();
    const current = h.scheduler.projection(root.id)!;
    const movedPath = "Archive/Completed.md";
    h.texts.set(movedPath, h.texts.get(projection.source.path)!);
    h.texts.delete(projection.source.path);
    h.file(movedPath);
    const count = h.apply.mock.calls.length;
    await h.indexNotes();
    await h.reconcile();
    const record = h.service.registry.snapshot().occurrences[completion.id]!;
    expect(record.links[projection.linkUid]?.source.path).toBe(movedPath);
    expect(record.before.links[projection.linkUid]?.source.path).toBe(
      projection.source.path,
    );
    expect(
      h.capture
        .candidates()
        .find((candidate) => candidate.uid === projection.linkUid)?.path,
    ).toBe(movedPath);
    expect(h.scheduler.projection(root.id)?.linkUid).toBe(current.linkUid);
    expect(h.apply).toHaveBeenCalledTimes(count);
    expect(h.tasks.get(root.id)?.completionCount).toBe(1);
    h.service.stop();
  });
});

describe("verified task deletion", () => {
  async function finish(h: Awaited<ReturnType<typeof harness>>) {
    await h.deleter.resume();
    await h.service.refresh();
    await h.deleter.resume();
    await h.settle();
    await h.deleter.resume();
  }

  test("opening a confirmation has no deletion intent or provider writes", async () => {
    const h = await harness();
    const review = await h.deleter.review(root.id);
    expect(review.record.tasks.map(task => task.id)).toEqual([root.id, child.id]);
    expect(h.service.registry.snapshot().deletions).toEqual({});
    expect(h.service.registry.snapshot().operations).toEqual([]);
    expect(h.apply).not.toHaveBeenCalled();
    await expect(h.service.mutate({ kind: "delete", taskId: root.id })).rejects.toThrow("Confirm");
    h.service.stop();
  });

  test("a changed task tree requires another confirmation", async () => {
    const h = await harness();
    const review = await h.deleter.review(root.id);
    h.tasks.set(child.id, { ...child, title: "Edited child" });
    const result = await h.deleter.confirm(review);
    expect(result.kind).toBe("changed");
    expect(h.apply).not.toHaveBeenCalled();
    expect(h.service.registry.snapshot().deletions).toEqual({});
    h.service.stop();
  });

  test("deleting a scheduled tree saves metadata and preserves local notes and calendar events", async () => {
    const h = await harness();
    await h.scheduler.schedule(root.id, interval);
    await h.settle();
    const projection = h.scheduler.projection(root.id)!;
    const before = h.texts.get(projection.source.path)!;
    const oldLinks = h.service.registry.snapshot().links;
    const review = await h.deleter.review(root.id);
    expect(review.record.links).toEqual(oldLinks);
    expect(review.record.tasks[0]?.description).toBe("Keep");
    const result = await h.deleter.confirm(review);
    expect(result.kind).toBe("saved");
    await finish(h);
    const state = h.service.registry.snapshot();
    const record = Object.values(state.deletions)[0]!;
    expect(record.phase).toBe("complete");
    expect(record.tasks.map(task => task.id)).toEqual([root.id, child.id]);
    expect(h.tasks.size).toBe(0);
    expect(state.links).toEqual({});
    expect(Object.values(state.detached).every(item => item.reason === "deleted" && item.deletionId === record.id)).toBe(true);
    expect(h.events.size).toBe(1);
    expect(h.texts.get(projection.source.path)).toBe(before.replaceAll(" #todoist", ""));
    expect(h.texts.get(projection.source.path)).toContain("Child");
    expect(h.texts.get(projection.source.path)).not.toContain("#todoist");
    const deletion = state.operations.find(op => op.mutation.kind === "delete")!;
    expect(deletion.deletionReadback).toEqual({ root: null, child: null });
    await h.indexNotes();
    expect(get(h.capture.state).issues).toEqual([]);
    await h.restart();
    h.texts.set(projection.source.path, before);
    await h.indexNotes();
    expect(h.service.registry.snapshot().links).toEqual({});
    expect(get(h.capture.state).issues.some(issue => issue.deletionId === record.id)).toBe(true);
    expect(h.apply.mock.calls.filter(([op]) => op.mutation.kind === "create")).toHaveLength(0);
    h.scheduler.stop();
    h.service.stop();
  });

  test("an interrupted note write resumes after restart without repeating deletion", async () => {
    const h = await harness();
    await h.scheduler.schedule(root.id, interval);
    await h.settle();
    const projection = h.scheduler.projection(root.id)!;
    h.setFailPath(projection.source.path);
    await h.deleter.confirm(await h.deleter.review(root.id));
    await finish(h);
    expect(h.tasks.size).toBe(0);
    expect(Object.values(h.service.registry.snapshot().deletions)[0]?.phase).toBe("unlinking");
    expect(h.service.registry.snapshot().links[projection.linkUid]).toBeDefined();
    await h.restart();
    h.setFailPath("");
    await h.service.refresh();
    await finish(h);
    expect(Object.values(h.service.registry.snapshot().deletions)[0]?.phase).toBe("complete");
    expect(h.service.registry.snapshot().links).toEqual({});
    expect(h.apply.mock.calls.filter(([op]) => op.mutation.kind === "delete")).toHaveLength(1);
    h.scheduler.stop();
    h.service.stop();
  });

  test("a confirmation state-write failure never deletes the remote task", async () => {
    const h = await harness();
    const review = await h.deleter.review(root.id);
    h.setFailTaskWrite(true);
    await expect(h.deleter.confirm(review)).rejects.toThrow("task state offline");
    expect(h.tasks.size).toBe(2);
    expect(h.apply).not.toHaveBeenCalled();
    expect(h.service.registry.snapshot().deletions).toEqual({});
    h.setFailTaskWrite(false);
    h.service.stop();
  });

  test("known completed children are preserved in recovery and removed from reopen history", async () => {
    const h = await harness();
    await h.service.mutate({ kind: "complete", taskId: child.id });
    await h.service.refresh();
    expect(get(h.service.state).completed.map(task => task.id)).toEqual([child.id]);
    const review = await h.deleter.review(root.id);
    expect(review.record.tasks.find(task => task.id === child.id)?.completed).toBe(true);
    await h.deleter.confirm(review);
    await finish(h);
    expect(Object.values(h.service.registry.snapshot().deletions)[0]?.phase).toBe("complete");
    expect(get(h.service.state).completed).toEqual([]);
    h.service.stop();
  });

  test("a saved deletion reserves descendants and refuses new children until it is stopped", async () => {
    const h = await harness();
    const review = await h.deleter.review(root.id);
    await h.service.registry.change(state => { state.deletions[review.record.id] = review.record; });
    await expect(h.service.mutate({ kind: "update", taskId: child.id, changes: { title: "Blocked" } })).rejects.toThrow("saved deletion");
    await expect(h.scheduler.schedule(child.id, interval)).rejects.toThrow("saved deletion");
    await expect(h.service.mutate({ kind: "create", task: { ...child, parentId: root.id } })).rejects.toThrow("saved deletion");
    await h.deleter.cancel(review.record.id);
    await h.service.mutate({ kind: "update", taskId: child.id, changes: { title: "Allowed" } });
    await h.service.refresh();
    expect(h.tasks.get(child.id)?.title).toBe("Allowed");
    h.service.stop();
  });

  test("switching account suspends a saved deletion and preserves its details", async () => {
    const h = await harness();
    const review = await h.deleter.review(root.id);
    await h.service.registry.change(state => { state.deletions[review.record.id] = review.record; });
    h.service.disconnect();
    await h.deleter.resume();
    expect(h.apply).not.toHaveBeenCalled();
    expect(h.service.registry.snapshot().deletions[review.record.id]?.tasks).toEqual(review.record.tasks);
    await expect(h.deleter.cancel(review.record.id)).rejects.toThrow();
    h.service.stop();
  });

  test("a child surviving the provider cascade retains its note link", async () => {
    const h = await harness();
    await h.scheduler.schedule(root.id, interval);
    await h.settle();
    const childUid = Object.entries(h.service.registry.snapshot().links).find(([, link]) => link.taskId === child.id)![0];
    const apply = h.apply.getMockImplementation()!;
    h.apply.mockImplementation(async op => {
      if (op.mutation.kind !== "delete") return apply(op);
      h.tasks.delete(root.id);
      h.tasks.set(child.id, { ...h.tasks.get(child.id)!, parentId: null });
      return { taskId: root.id };
    });
    await h.deleter.confirm(await h.deleter.review(root.id));
    await finish(h);
    expect(h.service.registry.snapshot().links[childUid]?.taskId).toBe(child.id);
    expect(h.service.registry.snapshot().detached[childUid]).toBeUndefined();
    expect(Object.values(h.service.registry.snapshot().deletions)[0]?.phase).toBe("complete");
    expect(h.events.size).toBe(1);
    h.scheduler.stop();
    h.service.stop();
  });

  test("independently scheduled child notes survive deletion as local checklists", async () => {
    const h = await harness();
    await h.scheduler.schedule(root.id, interval);
    await h.settle();
    await h.scheduler.schedule(child.id, { start: "2026-11-12T10:00:00Z", end: "2026-11-12T10:30:00Z" });
    await h.settle();
    const paths = [...new Set(Object.values(h.service.registry.snapshot().links).map(link => link.source.path))];
    expect(paths).toHaveLength(2);
    await h.deleter.confirm(await h.deleter.review(root.id));
    await finish(h);
    expect(h.service.registry.snapshot().links).toEqual({});
    expect(h.events.size).toBe(2);
    expect(paths.every(path => !h.texts.get(path)?.includes("#todoist"))).toBe(true);
    expect(h.texts.get(paths[0]!)).toContain("Work");
    expect(h.texts.get(paths[1]!)).toContain("Child");
    h.scheduler.stop();
    h.service.stop();
  });
});

describe("linked task scheduling", () => {
  test("an exporter collision retains the local schedule and prevents task-date writes until retry", async () => {
    const h = await harness();
    h.setExportGuardFailure("Todoist is already exporting into this managed calendar.");
    await h.scheduler.schedule(root.id, interval);
    await h.settle();
    const intent = h.service.registry.snapshot().schedules.at(-1)!;
    expect(intent.phase).toBe("provider-pending");
    expect(intent.error).toContain("already exporting");
    expect([...h.texts.values()].join("\n")).toContain("Work #todoist");
    expect(h.apply).not.toHaveBeenCalled();
    expect(h.events.size).toBe(0);
    await h.restart();
    h.setExportGuardFailure("");
    await h.scheduler.retry(intent.id);
    await h.settle();
    expect(h.service.registry.snapshot().schedules.find(op => op.id === intent.id)?.phase).toBe("complete");
    expect(h.events.size).toBe(1);
    expect(h.tasks.get(root.id)?.due?.date).toBe(interval.start);
    h.scheduler.stop();h.service.stop();
  });

  test("an untimed task capture remains available while calendar export is paused", async () => {
    const h = await harness();
    h.setExportGuardFailure("Calendar unavailable");
    const path = "Tasks.md", before = "# Tasks\n";
    h.texts.set(path, before);h.file(path);
    await h.scheduler.insert(root.id, { path, offset: before.length, before });
    await h.settle();
    expect(h.exportGuard).not.toHaveBeenCalled();
    expect(h.service.registry.snapshot().schedules.at(-1)?.phase).toBe("complete");
    expect(h.texts.get(path)).toContain("Work #todoist");
    h.scheduler.stop();h.service.stop();
  });
  test("a restored note before missing-source acknowledgment cancels stale detachment", async () => {
    const h = await harness();
    await h.scheduler.schedule(root.id, interval);
    await h.settle();
    const p = h.scheduler.projection(root.id)!;
    const link = h.service.registry.snapshot().links[p.linkUid]!;
    const before = h.texts.get(p.source.path)!;
    await h.scheduler.reconcile({
      linkUid: p.linkUid,
      task: link.base!,
      source: link.source,
      raw: link.source.raw,
      interval: p.interval,
      mutations: [],
      unlink: true,
      missingSource: { document: "" },
      expectedLink: link,
    });
    expect(h.service.registry.snapshot().schedules.at(-1)?.phase).toBe(
      "cancelled",
    );
    expect(h.service.registry.snapshot().detached).toEqual({});
    expect(h.service.registry.snapshot().links[p.linkUid]).toEqual(link);
    expect(h.texts.get(p.source.path)).toBe(before);
    h.scheduler.stop();
    h.reconciler.stop();
    h.service.stop();
  });

  test("provider edits made while a note is deleted reconcile after restoring its original link", async () => {
    const h = await harness();
    await h.scheduler.schedule(root.id, interval);
    await h.settle();
    const p = h.scheduler.projection(root.id)!;
    const before = h.texts.get(p.source.path)!;
    h.texts.set(p.source.path, before.replace(p.source.raw, ""));
    await h.reconcile();
    h.tasks.set(root.id, {
      ...h.tasks.get(root.id)!,
      title: "Remote title",
      description: "Remote description",
    });
    await h.service.refresh();
    h.texts.set(p.source.path, before);
    await h.reconcile();
    expect(h.service.registry.snapshot().links[p.linkUid]?.taskId).toBe(
      root.id,
    );
    expect(h.texts.get(p.source.path)).toContain("Remote title");
    expect(h.tasks.get(root.id)?.description).toBe("Remote description");
    expect(h.scheduler.projection(root.id)?.googleEventId).toBe(
      p.googleEventId,
    );
    expect(h.events.size).toBe(1);
    h.scheduler.stop();
    h.reconciler.stop();
    h.service.stop();
  });

  test("missing-source journals reject note edits and provider mutations", async () => {
    const h = await harness();
    await h.scheduler.schedule(root.id, interval);
    await h.settle();
    const p = h.scheduler.projection(root.id)!;
    const before = h.texts.get(p.source.path)!;
    h.texts.set(p.source.path, before.replace(p.source.raw, ""));
    await h.reconcile();
    const operation = h.service.registry
      .snapshot()
      .schedules.find((x) => x.missingSource)!;
    for (const patch of [
      { unlink: false },
      { raw: "- [ ] Different" },
      { syncTaskDate: true },
      { providerChanges: { title: "Unexpected" } },
      {
        plan: {
          ...operation.plan,
          edits: [{ path: "Other.md", before: "", after: "Unexpected" }],
        },
      },
    ])
      await expect(
        h.service.registry.change((state) => {
          Object.assign(
            state.schedules.find((x) => x.id === operation.id)!,
            patch,
          );
        }),
      ).rejects.toThrow();
    h.scheduler.stop();
    h.reconciler.stop();
    h.service.stop();
  });

  test("deleting a scheduled subtree detaches its task links and restores their original identities on undo", async () => {
    const h = await harness();
    await h.scheduler.schedule(root.id, interval);
    await h.settle();
    const projection = h.scheduler.projection(root.id)!;
    const before = h.texts.get(projection.source.path)!;
    const original = h.service.registry.snapshot().links;
    const writes = h.apply.mock.calls.length;
    const noteWrites = h.process.mock.calls.length;
    const after = before.replace(projection.source.raw, "");
    h.texts.set(projection.source.path, after);
    await h.reconcile();
    expect(h.texts.get(projection.source.path)).toBe(after);
    expect(h.process).toHaveBeenCalledTimes(noteWrites);
    expect(h.apply).toHaveBeenCalledTimes(writes);
    expect(h.service.registry.snapshot().links).toEqual({});
    expect(
      Object.values(h.service.registry.snapshot().detached)
        .map((x) => x.link.taskId)
        .toSorted(),
    ).toEqual([child.id, root.id].toSorted());
    expect(get(h.reconciler.state).issues).toEqual([]);
    await h.restart();
    h.texts.set(projection.source.path, before);
    await h.indexNotes();
    expect(Object.keys(h.service.registry.snapshot().links).toSorted()).toEqual(
      Object.keys(original).toSorted(),
    );
    expect(
      h.service.registry.snapshot().links[projection.linkUid]?.taskId,
    ).toBe(root.id);
    await h.reconcile();
    expect(h.scheduler.projection(root.id)?.googleEventId).toBe(
      projection.googleEventId,
    );
    expect(h.events.size).toBe(1);
    expect(h.apply).toHaveBeenCalledTimes(writes);
    expect(h.texts.get(projection.source.path)).toBe(before);
    h.scheduler.stop();
    h.reconciler.stop();
    h.service.stop();
  });

  test("restoring a deleted block adopts a fresh calendar identity after verified event deletion", async () => {
    const h = await harness();
    await h.scheduler.schedule(root.id, interval);
    await h.settle();
    const old = h.scheduler.projection(root.id)!;
    const before = h.texts.get(old.source.path)!;
    h.texts.set(old.source.path, before.replace(old.source.raw, ""));
    await h.reconcile();
    await h.syncCalendar(true);
    expect(h.events.size).toBe(0);
    expect(h.calendarState.records[old.googleUid!]?.deleted).toBe(true);
    await h.restart();
    h.texts.set(old.source.path, before);
    await h.reconcile();
    const restored = h.scheduler.projection(root.id)!;
    expect(restored.linkUid).toBe(old.linkUid);
    expect(restored.googleUid).not.toBe(old.googleUid);
    expect(restored.googleEventId).not.toBe(old.googleEventId);
    expect(h.events.size).toBe(1);
    expect(h.service.registry.snapshot().links[old.linkUid]?.taskId).toBe(
      root.id,
    );
    h.scheduler.stop();
    h.reconciler.stop();
    h.service.stop();
  });

  test("a deleted note file detaches its registered tasks without writing or deleting provider tasks", async () => {
    const h = await harness();
    await h.scheduler.schedule(root.id, interval);
    await h.settle();
    const projection = h.scheduler.projection(root.id)!;
    const writes = h.apply.mock.calls.length;
    h.texts.delete(projection.source.path);
    await h.reconcile();
    expect(h.service.registry.snapshot().links).toEqual({});
    expect(
      h.service.registry.snapshot().detached[projection.linkUid]?.link.taskId,
    ).toBe(root.id);
    expect(h.apply).toHaveBeenCalledTimes(writes);
    expect(h.tasks.size).toBe(2);
    expect(h.texts.has(projection.source.path)).toBe(false);
    h.scheduler.stop();
    h.reconciler.stop();
    h.service.stop();
  });

  test("missing-source detachment waits while notes are being edited", async () => {
    const h = await harness();
    await h.scheduler.schedule(root.id, interval);
    await h.settle();
    const projection = h.scheduler.projection(root.id)!;
    h.texts.set(projection.source.path, "");
    h.setStable(false);
    await h.reconcile();
    expect(
      h.service.registry.snapshot().links[projection.linkUid]?.taskId,
    ).toBe(root.id);
    expect(h.service.registry.snapshot().detached).toEqual({});
    h.setStable(true);
    await h.reconcile();
    expect(h.service.registry.snapshot().links).toEqual({});
    h.scheduler.stop();
    h.reconciler.stop();
    h.service.stop();
  });

  test.each([1, 2, 3])(
    "missing-source journal resumes after interrupted registry write %i",
    async (write) => {
      const h = await harness();
      await h.scheduler.schedule(root.id, interval);
      await h.settle();
      const projection = h.scheduler.projection(root.id)!;
      const before = h.texts.get(projection.source.path)!;
      h.texts.set(
        projection.source.path,
        before.replace(projection.source.raw, ""),
      );
      h.failWriteAfter(write);
      await h.reconciler.scan();
      expect(h.tasks.size).toBe(2);
      await h.restart();
      await h.settle();
      await h.reconcile();
      expect(h.service.registry.snapshot().links).toEqual({});
      expect(
        h.service.registry.snapshot().detached[projection.linkUid]?.link.taskId,
      ).toBe(root.id);
      h.texts.set(projection.source.path, before);
      await h.reconcile();
      expect(
        h.service.registry.snapshot().links[projection.linkUid]?.taskId,
      ).toBe(root.id);
      expect(h.events.size).toBe(1);
      h.scheduler.stop();
      h.reconciler.stop();
      h.service.stop();
    },
  );

  test("deletion during an uncertain calendar export retains recovery through restart and undo", async () => {
    const h = await harness();
    h.setLoseCalendarResponse(true);
    await h.scheduler.schedule(root.id, interval);
    await h.settle();
    const projection = h.scheduler.projection(root.id)!;
    const before = h.texts.get(projection.source.path)!;
    const eventId = [...h.events.keys()][0]!;
    h.texts.set(
      projection.source.path,
      before.replace(projection.source.raw, ""),
    );
    await h.reconcile();
    expect(h.service.registry.snapshot().links).toEqual({});
    expect(
      h.service.registry.snapshot().schedules.find((x) => x.missingSource)
        ?.phase,
    ).toBe("calendar-pending");
    h.texts.set(projection.source.path, before);
    await h.indexNotes();
    expect(
      h.service.registry.snapshot().links[projection.linkUid],
    ).toBeUndefined();
    await h.restart();
    h.setLoseCalendarResponse(false);
    h.setFailCalendar(false);
    await h.settle();
    await h.reconcile();
    expect(h.scheduler.projection(root.id)?.googleEventId).toBe(eventId);
    expect(h.events.size).toBe(1);
    expect(
      h.service.registry.snapshot().links[projection.linkUid]?.taskId,
    ).toBe(root.id);
    h.scheduler.stop();
    h.reconciler.stop();
    h.service.stop();
  });

  test("ambiguous restored copies require a link decision and create no replacement Todoist task", async () => {
    const h = await harness();
    await h.scheduler.schedule(root.id, interval);
    await h.settle();
    const projection = h.scheduler.projection(root.id)!;
    const before = h.texts.get(projection.source.path)!;
    h.texts.set(
      projection.source.path,
      before.replace(projection.source.raw, ""),
    );
    await h.reconcile();
    const writes = h.apply.mock.calls.length;
    h.texts.set(projection.source.path, before + "\n" + projection.source.raw);
    await h.indexNotes();
    expect(h.service.registry.snapshot().links).toEqual({});
    expect(h.apply).toHaveBeenCalledTimes(writes);
    h.texts.set(projection.source.path, before);
    await h.reconcile();
    expect(
      h.service.registry.snapshot().links[projection.linkUid]?.taskId,
    ).toBe(root.id);
    expect(h.apply).toHaveBeenCalledTimes(writes);
    h.scheduler.stop();
    h.reconciler.stop();
    h.service.stop();
  });

  test("capture-tag removal pauses propagation until keeping the link restores independent edits", async () => {
    const h = await harness();
    await h.scheduler.schedule(root.id, interval);
    await h.settle();
    const projection = h.scheduler.projection(root.id)!;
    const before = h.texts.get(projection.source.path)!;
    const writes = h.apply.mock.calls.length;
    h.texts.set(
      projection.source.path,
      before.replace("Work #todoist", "Renamed local"),
    );
    h.tasks.set(root.id, {
      ...h.tasks.get(root.id)!,
      description: "Independent remote description",
    });
    await h.service.refresh();
    await h.reconcile();
    expect(
      get(h.reconciler.state).issues.find((issue) => issue.taskId === root.id)
        ?.fields,
    ).toEqual(["unlink"]);
    expect(h.apply).toHaveBeenCalledTimes(writes);
    expect(h.tasks.get(root.id)?.title).toBe("Work");
    await h.reconciler.keepLinked(projection.linkUid);
    await h.reconcile();
    expect(h.tasks.get(root.id)).toMatchObject({
      title: "Renamed local",
      description: "Independent remote description",
    });
    expect(h.texts.get(projection.source.path)).toContain(
      "Renamed local #todoist #work",
    );
    expect(h.scheduler.projection(root.id)?.googleEventId).toBe(
      projection.googleEventId,
    );
    expect(Object.values(h.service.registry.snapshot().issues)).toEqual([]);
    h.scheduler.stop();
    h.reconciler.stop();
    h.service.stop();
  });

  test("cancelled tag removal restores exact original note bytes without a task command", async () => {
    const h = await harness();
    await h.scheduler.schedule(root.id, interval);
    await h.settle();
    const projection = h.scheduler.projection(root.id)!;
    const before = h.texts.get(projection.source.path)!;
    const writes = h.apply.mock.calls.length;
    h.texts.set(projection.source.path, before.replace(" #todoist", ""));
    await h.reconcile();
    await h.reconciler.keepLinked(projection.linkUid);
    expect(h.texts.get(projection.source.path)).toBe(before);
    expect(h.apply).toHaveBeenCalledTimes(writes);
    expect(
      h.service.registry.snapshot().links[projection.linkUid]?.noteBase?.raw,
    ).toBe(projection.source.raw);
    expect(h.service.registry.snapshot().schedules.at(-1)).toMatchObject({
      repairCaptureTag: true,
      phase: "complete",
    });
    expect(h.scheduler.projection(root.id)?.googleEventId).toBe(
      projection.googleEventId,
    );
    h.scheduler.stop();
    h.reconciler.stop();
    h.service.stop();
  });

  test("keeping a link reconciles combined title and interval edits after restoring its tag", async () => {
    const h = await harness();
    await h.scheduler.schedule(root.id, interval);
    await h.settle();
    const projection = h.scheduler.projection(root.id)!;
    const updated = {
      start: "2026-11-11T10:15:00Z",
      end: "2026-11-11T11:00:00Z",
    };
    const range = (value: typeof interval) =>
      `${window.moment(value.start).format("HH:mm")} - ${window.moment(value.end).format("HH:mm")}`;
    h.texts.set(
      projection.source.path,
      h.texts
        .get(projection.source.path)!
        .replace(range(interval), range(updated))
        .replace("Work #todoist", "Changed planned"),
    );
    await h.reconcile();
    expect(h.tasks.get(root.id)?.title).toBe("Work");
    expect(h.tasks.get(root.id)?.due?.date).toBe(interval.start);
    await h.reconciler.keepLinked(projection.linkUid);
    await h.reconcile();
    expect(h.tasks.get(root.id)?.title).toBe("Changed planned");
    expect(Date.parse(h.tasks.get(root.id)!.due!.date)).toBe(
      Date.parse(updated.start),
    );
    expect(h.scheduler.projection(root.id)?.interval).toEqual({
      start: new Date(updated.start).toISOString(),
      end: new Date(updated.end).toISOString(),
    });
    expect([...h.events.keys()]).toEqual([projection.googleEventId]);
    expect(h.texts.get(projection.source.path)).toContain(
      "Changed planned #todoist",
    );
    h.scheduler.stop();
    h.reconciler.stop();
    h.service.stop();
  });

  test("confirming tag removal unlinks the same note without creating a replacement task", async () => {
    const h = await harness();
    await h.scheduler.schedule(root.id, interval);
    await h.settle();
    const projection = h.scheduler.projection(root.id)!;
    const removed = h.texts
      .get(projection.source.path)!
      .replace(" #todoist", "");
    h.texts.set(projection.source.path, removed);
    await h.reconcile();
    const writes = h.apply.mock.calls.length;
    await h.reconciler.unlink(projection.linkUid);
    await h.reconcile();
    expect(h.texts.get(projection.source.path)).toBe(removed);
    expect(h.scheduler.projection(root.id)).toBeUndefined();
    expect(h.apply).toHaveBeenCalledTimes(writes);
    expect([...h.events.keys()]).toEqual([projection.googleEventId]);
    h.scheduler.stop();
    h.reconciler.stop();
    h.service.stop();
  });

  test("failed tag-repair intent keeps the unresolved decision and acknowledged note baseline", async () => {
    const h = await harness();
    await h.scheduler.schedule(root.id, interval);
    await h.settle();
    const projection = h.scheduler.projection(root.id)!;
    const removed = h.texts
      .get(projection.source.path)!
      .replace(" #todoist", "");
    h.texts.set(projection.source.path, removed);
    await h.reconcile();
    h.setFailTaskWrite(true);
    await expect(h.reconciler.keepLinked(projection.linkUid)).rejects.toThrow(
      "task state offline",
    );
    expect(h.texts.get(projection.source.path)).toBe(removed);
    expect(
      h.service.registry.snapshot().links[projection.linkUid]?.noteBase?.raw,
    ).toBe(projection.source.raw);
    expect(
      get(h.reconciler.state).issues.find((issue) => issue.taskId === root.id)
        ?.fields,
    ).toEqual(["unlink"]);
    h.scheduler.stop();
    h.reconciler.stop();
    h.service.stop();
  });

  test("tag restoration resumes after interrupted note writes and retains unacknowledged title edits", async () => {
    const h = await harness();
    await h.scheduler.schedule(root.id, interval);
    await h.settle();
    const projection = h.scheduler.projection(root.id)!;
    h.texts.set(
      projection.source.path,
      h.texts
        .get(projection.source.path)!
        .replace("Work #todoist", "Recovered edit"),
    );
    await h.reconcile();
    h.setFailPath(projection.source.path);
    await expect(h.reconciler.keepLinked(projection.linkUid)).rejects.toThrow(
      "interrupted note write",
    );
    expect(h.service.registry.snapshot().schedules.at(-1)).toMatchObject({
      repairCaptureTag: true,
      phase: "prepared",
    });
    h.setFailPath("");
    await h.restart();
    await h.settle();
    await h.reconcile();
    expect(h.tasks.get(root.id)?.title).toBe("Recovered edit");
    expect(h.texts.get(projection.source.path)).toContain(
      "Recovered edit #todoist #work",
    );
    expect([...h.events.keys()]).toEqual([projection.googleEventId]);
    h.scheduler.stop();
    h.reconciler.stop();
    h.service.stop();
  });

  test("keeping the link during an uncertain calendar export preserves later task edits across restart", async () => {
    const h = await harness();
    h.setLoseCalendarResponse(true);
    await h.scheduler.schedule(root.id, interval);
    await h.settle();
    const projection = h.scheduler.projection(root.id)!;
    const eventId = [...h.events.keys()][0]!;
    h.texts.set(
      projection.source.path,
      h.texts
        .get(projection.source.path)!
        .replace("Work #todoist", "Offline kept edit"),
    );
    await h.reconcile();
    await h.reconciler.keepLinked(projection.linkUid);
    await h.reconcile();
    expect(h.tasks.get(root.id)?.title).toBe("Offline kept edit");
    expect(h.texts.get(projection.source.path)).toContain(
      "Offline kept edit #todoist #work",
    );
    await h.restart();
    h.setLoseCalendarResponse(false);
    h.setFailCalendar(false);
    await h.settle();
    expect([...h.events.keys()]).toEqual([eventId]);
    expect(h.events.get(eventId)?.summary).toContain("Offline kept edit");
    expect(h.service.registry.snapshot().schedules.at(-1)?.phase).toBe(
      "complete",
    );
    h.scheduler.stop();
    h.reconciler.stop();
    h.service.stop();
  });

  test("tag restoration rejects an outstanding task change without acknowledging its removed tag", async () => {
    const h = await harness();
    await h.scheduler.schedule(root.id, interval);
    await h.settle();
    const projection = h.scheduler.projection(root.id)!;
    const removed = h.texts
      .get(projection.source.path)!
      .replace(" #todoist", "");
    h.texts.set(projection.source.path, removed);
    await h.reconcile();
    await h.service.registry.change((state) => {
      state.operations.push({
        id: crypto.randomUUID(),
        tempId: crypto.randomUUID(),
        provider: "todoist",
        accountId: "account",
        mutation: {
          kind: "update",
          taskId: root.id,
          changes: { title: "Queued edit" },
        },
        base: h.tasks.get(root.id)!,
        status: "conflict",
        attempts: 0,
        createdAt: new Date().toISOString(),
      });
    });
    await expect(h.reconciler.keepLinked(projection.linkUid)).rejects.toThrow(
      "saved change",
    );
    await expect(h.reconciler.unlink(projection.linkUid)).rejects.toThrow(
      "saved change",
    );
    expect(h.texts.get(projection.source.path)).toBe(removed);
    expect(
      h.service.registry.snapshot().links[projection.linkUid]?.noteBase?.raw,
    ).toBe(projection.source.raw);
    h.scheduler.stop();
    h.reconciler.stop();
    h.service.stop();
  });

  test("tag repair resumes after successful note writing followed by failed link acknowledgment", async () => {
    const h = await harness();
    await h.scheduler.schedule(root.id, interval);
    await h.settle();
    const projection = h.scheduler.projection(root.id)!;
    h.texts.set(
      projection.source.path,
      h.texts
        .get(projection.source.path)!
        .replace("Work #todoist", "Restored acknowledged edit"),
    );
    await h.reconcile();
    h.process.mockImplementationOnce(async (value, update) => {
      const next = update(h.texts.get(value.path) ?? "");
      h.texts.set(value.path, next);
      h.setFailTaskWrite(true);
      return next;
    });
    await expect(h.reconciler.keepLinked(projection.linkUid)).rejects.toThrow(
      "saved tag restoration",
    );
    expect(h.texts.get(projection.source.path)).toContain(
      "Restored acknowledged edit #todoist",
    );
    expect(
      h.service.registry.snapshot().links[projection.linkUid]?.noteBase?.raw,
    ).toBe(projection.source.raw);
    h.setFailTaskWrite(false);
    await h.restart();
    await h.settle();
    await h.reconcile();
    expect(h.tasks.get(root.id)?.title).toBe("Restored acknowledged edit");
    expect([...h.events.keys()]).toEqual([projection.googleEventId]);
    expect(Object.values(h.service.registry.snapshot().issues)).toEqual([]);
    h.scheduler.stop();
    h.reconciler.stop();
    h.service.stop();
  });

  test("capture-tag repair journals reject task commands, unlink and new scheduling", async () => {
    const h = await harness();
    await h.scheduler.schedule(root.id, interval);
    await h.settle();
    const projection = h.scheduler.projection(root.id)!;
    h.texts.set(
      projection.source.path,
      h.texts.get(projection.source.path)!.replace(" #todoist", ""),
    );
    await h.reconcile();
    await h.reconciler.keepLinked(projection.linkUid);
    const before = h.service.registry.snapshot();
    for (const patch of [
      { unlink: true },
      { syncTaskDate: true },
      { target: { kind: "schedule", interval } },
      { providerChanges: { title: "Wrong edit" } },
      {
        providerSteps: [
          {
            id: crypto.randomUUID(),
            base: root,
            mutation: { kind: "complete", taskId: root.id },
          },
        ],
      },
    ]) {
      await expect(
        h.service.registry.change((state) => {
          Object.assign(state.schedules.at(-1)!, patch);
        }),
      ).rejects.toThrow("journals");
      expect(h.service.registry.snapshot()).toEqual(before);
    }
    h.scheduler.stop();
    h.reconciler.stop();
    h.service.stop();
  });

  test("unlink keeps the timed note, children, remote task and existing calendar event", async () => {
    const h = await harness();
    await h.scheduler.schedule(root.id, interval);
    await h.settle();
    const projection = h.scheduler.projection(root.id)!;
    const before = h.texts.get(projection.source.path)!;
    const remote = structuredClone(h.tasks.get(root.id));
    const writes = h.apply.mock.calls.length;
    h.setFailCalendar(true);
    await h.reconciler.unlink(projection.linkUid);
    expect(h.texts.get(projection.source.path)).toBe(
      before.replace(" #todoist", ""),
    );
    expect(h.tasks.get(root.id)).toEqual(remote);
    expect(h.apply).toHaveBeenCalledTimes(writes);
    expect([...h.events.keys()]).toEqual([projection.googleEventId]);
    expect(h.scheduler.projection(root.id)).toBeUndefined();
    expect(
      h.service.registry.snapshot().links[projection.linkUid],
    ).toBeUndefined();
    expect(
      Object.values(h.service.registry.snapshot().links).map(
        (link) => link.taskId,
      ),
    ).toEqual([child.id]);
    expect(h.service.registry.snapshot().schedules.at(-1)).toMatchObject({
      unlink: true,
      phase: "complete",
      taskAcknowledged: true,
    });
    await h.reconcile();
    expect(h.tasks.get(root.id)).toEqual(remote);
    expect(h.apply).toHaveBeenCalledTimes(writes);
    h.scheduler.stop();
    h.reconciler.stop();
    h.service.stop();
  });

  test("unlink preserves untimed formatting, comments, native IDs and nested bytes", async () => {
    const h = await harness();
    h.file("Tasks.md");
    h.texts.set("Tasks.md", "");
    await h.scheduler.insert(root.id, {
      path: "Tasks.md",
      offset: 0,
      before: "",
    });
    await h.settle();
    const projection = h.scheduler.projection(root.id)!;
    const before = h.texts
      .get("Tasks.md")!
      .replace(
        "Work #todoist #work",
        "**Work** #todoist #work <!-- keep --> ^native",
      )
      .replace(/\n/g, "\r\n");
    h.texts.set("Tasks.md", before);
    await h.reconciler.unlink(projection.linkUid);
    expect(h.texts.get("Tasks.md")).toBe(before.replace(" #todoist", ""));
    expect(
      h.service.registry.snapshot().schedules.at(-1)?.unlinkNoteBase?.raw,
    ).toBe(projection.source.raw);
    expect(h.events.size).toBe(0);
    expect(h.apply).not.toHaveBeenCalled();
    expect(h.scheduler.projection(root.id)).toBeUndefined();
    h.scheduler.stop();
    h.reconciler.stop();
    h.service.stop();
  });

  test("unlink recovers uncertain calendar ownership after restart and preserves later local edits", async () => {
    const h = await harness();
    h.setLoseCalendarResponse(true);
    await h.scheduler.schedule(root.id, interval);
    await h.settle();
    const projection = h.scheduler.projection(root.id)!;
    const eventId = [...h.events.keys()][0]!;
    await h.reconciler.unlink(projection.linkUid);
    expect(h.service.registry.snapshot().schedules.at(-1)).toMatchObject({
      unlink: true,
      phase: "calendar-pending",
      taskAcknowledged: true,
    });
    expect(h.scheduler.projection(root.id)).toBeUndefined();
    const later = h.texts
      .get(projection.source.path)!
      .replace("Work #work", "Independent local edit #work");
    h.texts.set(projection.source.path, later);
    await expect(h.scheduler.schedule(root.id, interval)).rejects.toThrow(
      "saved schedule change",
    );
    await h.restart();
    h.setLoseCalendarResponse(false);
    h.setFailCalendar(false);
    await h.settle();
    expect(h.texts.get(projection.source.path)).toBe(later);
    expect([...h.events.keys()]).toEqual([eventId]);
    expect(h.calendarState.records[projection.googleUid!]?.eventId).toBe(
      eventId,
    );
    expect(h.service.registry.snapshot().schedules.at(-1)?.phase).toBe(
      "complete",
    );
    expect(
      h.service.registry.snapshot().links[projection.linkUid],
    ).toBeUndefined();
    h.scheduler.stop();
    h.reconciler.stop();
    h.service.stop();
  });

  test("unlink carries an earlier explicit event removal through restart", async () => {
    const h = await harness();
    await h.scheduler.schedule(root.id, interval);
    await h.settle();
    h.setFailCalendar(true);
    await h.scheduler.unschedule(root.id);
    await h.settle();
    const projection = h.scheduler.projection(root.id)!;
    await h.reconciler.unlink(projection.linkUid);
    expect(h.events.size).toBe(1);
    expect(h.service.registry.snapshot().schedules.at(-1)?.phase).toBe(
      "calendar-pending",
    );
    await h.restart();
    h.setFailCalendar(false);
    await h.settle();
    expect(h.events.size).toBe(0);
    expect(h.service.registry.snapshot().schedules.at(-1)?.phase).toBe(
      "complete",
    );
    expect(h.texts.get(projection.source.path)).not.toContain("#todoist");
    h.scheduler.stop();
    h.reconciler.stop();
    h.service.stop();
  });

  test("a failed unlink intent write preserves the original note and link", async () => {
    const h = await harness();
    await h.scheduler.schedule(root.id, interval);
    await h.settle();
    const projection = h.scheduler.projection(root.id)!;
    const before = h.texts.get(projection.source.path);
    h.setFailTaskWrite(true);
    await expect(h.reconciler.unlink(projection.linkUid)).rejects.toThrow(
      "task state offline",
    );
    expect(h.texts.get(projection.source.path)).toBe(before);
    expect(
      h.service.registry.snapshot().links[projection.linkUid],
    ).toBeDefined();
    expect(h.service.registry.snapshot().schedules).toHaveLength(1);
    h.scheduler.stop();
    h.reconciler.stop();
    h.service.stop();
  });

  test("unlink resumes an interrupted note write before dropping its link", async () => {
    const h = await harness();
    await h.scheduler.schedule(root.id, interval);
    await h.settle();
    const projection = h.scheduler.projection(root.id)!;
    const before = h.texts.get(projection.source.path)!;
    h.setFailPath(projection.source.path);
    await h.reconciler.unlink(projection.linkUid);
    expect(h.texts.get(projection.source.path)).toBe(before);
    expect(
      h.service.registry.snapshot().links[projection.linkUid],
    ).toBeDefined();
    expect(h.service.registry.snapshot().schedules.at(-1)?.phase).toBe(
      "prepared",
    );
    h.setFailPath("");
    await h.restart();
    await h.settle();
    expect(h.texts.get(projection.source.path)).toBe(
      before.replace(" #todoist", ""),
    );
    expect(
      h.service.registry.snapshot().links[projection.linkUid],
    ).toBeUndefined();
    expect(h.service.registry.snapshot().schedules.at(-1)?.phase).toBe(
      "complete",
    );
    h.scheduler.stop();
    h.reconciler.stop();
    h.service.stop();
  });

  test("unlink recovers when the note write succeeds before its link acknowledgment fails", async () => {
    const h = await harness();
    await h.scheduler.schedule(root.id, interval);
    await h.settle();
    const projection = h.scheduler.projection(root.id)!;
    const before = h.texts.get(projection.source.path)!;
    h.process.mockImplementationOnce(async (value, update) => {
      const next = update(h.texts.get(value.path) ?? "");
      h.texts.set(value.path, next);
      h.setFailTaskWrite(true);
      return next;
    });
    await h.reconciler.unlink(projection.linkUid);
    expect(h.texts.get(projection.source.path)).toBe(
      before.replace(" #todoist", ""),
    );
    expect(
      h.service.registry.snapshot().links[projection.linkUid],
    ).toBeDefined();
    expect(h.service.registry.snapshot().schedules.at(-1)?.phase).toBe(
      "prepared",
    );
    h.setFailTaskWrite(false);
    await h.restart();
    await h.settle();
    expect(h.texts.get(projection.source.path)).toBe(
      before.replace(" #todoist", ""),
    );
    expect(
      h.service.registry.snapshot().links[projection.linkUid],
    ).toBeUndefined();
    expect(h.service.registry.snapshot().schedules.at(-1)?.phase).toBe(
      "complete",
    );
    expect([...h.events.keys()]).toEqual([projection.googleEventId]);
    h.scheduler.stop();
    h.reconciler.stop();
    h.service.stop();
  });

  test("unlink defers an actively edited or ambiguous source", async () => {
    const h = await harness();
    await h.scheduler.schedule(root.id, interval);
    await h.settle();
    const projection = h.scheduler.projection(root.id)!;
    h.setStable(false);
    await expect(h.reconciler.unlink(projection.linkUid)).rejects.toThrow(
      "current note block",
    );
    h.setStable(true);
    h.texts.set(
      projection.source.path,
      h.texts
        .get(projection.source.path)!
        .replace("Work #todoist", "Changed parent #todoist")
        .replace("- [ ] Child", "- [ ] Changed child"),
    );
    await expect(h.reconciler.unlink(projection.linkUid)).rejects.toThrow(
      "current note block",
    );
    expect(
      h.service.registry.snapshot().links[projection.linkUid],
    ).toBeDefined();
    h.scheduler.stop();
    h.reconciler.stop();
    h.service.stop();
  });

  test("unlink journal validation rejects provider writes and a new schedule intent", async () => {
    const h = await harness();
    await h.scheduler.schedule(root.id, interval);
    await h.settle();
    const projection = h.scheduler.projection(root.id)!;
    await h.reconciler.unlink(projection.linkUid);
    const before = h.service.registry.snapshot();
    for (const patch of [
      { syncTaskDate: true },
      { providerChanges: { title: "Wrong update" } },
      { target: { kind: "schedule", interval } },
      {
        providerSteps: [
          {
            id: crypto.randomUUID(),
            base: root,
            mutation: { kind: "complete", taskId: root.id },
          },
        ],
      },
    ]) {
      await expect(
        h.service.registry.change((state) => {
          Object.assign(state.schedules.at(-1)!, patch);
        }),
      ).rejects.toThrow("Unlink journals");
      expect(h.service.registry.snapshot()).toEqual(before);
    }
    h.scheduler.stop();
    h.reconciler.stop();
    h.service.stop();
  });

  test("successive offline title and time rewrites retain the known task projection through calendar replacement matching", async () => {
    const h = await harness();
    h.setLoseCalendarResponse(true);
    await h.scheduler.schedule(root.id, interval);
    await h.settle();
    const first = h.service.registry.snapshot().schedules[0]!;
    const eventId = [...h.events.keys()][0]!;
    let previousTitle = "Work";
    for (const hour of [1, 2]) {
      const source = h.scheduler.projection(root.id)!.source;
      const beforeRange = `${window
        .moment(interval.start)
        .add(hour - 1, "hour")
        .format("HH:mm")} - ${window
        .moment(interval.end)
        .add(hour - 1, "hour")
        .format("HH:mm")}`;
      const nextRange = `${window.moment(interval.start).add(hour, "hour").format("HH:mm")} - ${window.moment(interval.end).add(hour, "hour").format("HH:mm")}`;
      const title = `Offline edit ${hour}`;
      h.texts.set(
        source.path,
        h.texts
          .get(source.path)!
          .replace(beforeRange, nextRange)
          .replace(`${previousTitle} #todoist`, `${title} #todoist`),
      );
      await h.reconcile();
      expect(h.scheduler.projection(root.id)?.googleUid).toBe(first.googleUid);
      expect(h.tasks.get(root.id)?.title).toBe(title);
      previousTitle = title;
    }
    await h.restart();
    h.setLoseCalendarResponse(false);
    h.setFailCalendar(false);
    await h.settle();
    expect([...h.events.keys()]).toEqual([eventId]);
    expect(h.events.get(eventId)?.summary).toBe(
      "Offline edit 2 #todoist #work",
    );
    expect(h.service.registry.snapshot().schedules.at(-1)?.phase).toBe(
      "complete",
    );
    expect(Object.values(h.service.registry.snapshot().issues)).toEqual([]);
    h.scheduler.stop();
    h.reconciler.stop();
    h.service.stop();
  });

  test("source field review can resolve a conflict while a Calendar-only retry is pending", async () => {
    const h = await harness();
    h.setFailCalendar(true);
    await h.scheduler.schedule(root.id, interval);
    await h.settle();
    const first = h.service.registry.snapshot().schedules[0]!;
    const source = h.scheduler.projection(root.id)!.source;
    h.texts.set(
      source.path,
      h.texts.get(source.path)!.replace("Work #todoist", "Local #todoist"),
    );
    h.tasks.set(root.id, { ...h.tasks.get(root.id)!, title: "Remote" });
    await h.service.refresh();
    await h.reconcile();
    const issue = Object.values(h.service.registry.snapshot().issues)[0]!;
    const review = await h.reconciler.inspectConflict(issue.id);
    await h.reconciler.resolveConflict(review, { title: "local" });
    await h.settle();
    expect(h.tasks.get(root.id)?.title).toBe("Local");
    expect(
      h.service.registry.snapshot().schedules[0]?.supersededBy,
    ).toBeDefined();
    expect(Object.values(h.service.registry.snapshot().issues)).toEqual([]);
    h.setFailCalendar(false);
    await h.settle();
    expect(h.scheduler.projection(root.id)?.googleUid).toBe(first.googleUid);
    expect([...h.events.values()].map((event) => event.summary)).toEqual([
      "Local #todoist #work",
    ]);
    h.scheduler.stop();
    h.reconciler.stop();
    h.service.stop();
  });

  test.each(["note", "provider"])(
    "a schedule move preserves an unreconciled %s title edit",
    async (origin) => {
      const h = await harness();
      await h.scheduler.schedule(root.id, interval);
      await h.settle();
      const path = h.scheduler.projection(root.id)!.source.path;
      if (origin === "note") {
        h.texts.set(
          path,
          h.texts.get(path)!.replace("Work #todoist", "Edited #todoist"),
        );
        await h.indexNotes();
      } else {
        h.tasks.set(root.id, { ...h.tasks.get(root.id)!, title: "Edited" });
        await h.service.refresh();
      }
      await h.scheduler.schedule(root.id, {
        start: "2026-11-12T10:00:00Z",
        end: "2026-11-12T10:30:00Z",
      });
      await h.settle();
      await h.reconcile();
      expect(h.tasks.get(root.id)?.title).toBe("Edited");
      expect(h.texts.get("Daily/2026-11-12.md")).toContain("Edited #todoist");
      expect(Object.values(h.service.registry.snapshot().issues)).toEqual([]);
      h.scheduler.stop();
      h.reconciler.stop();
      h.service.stop();
    },
  );

  test.each(["create", "update"])(
    "a lost Calendar %s response survives supersession and restart with one event",
    async (kind) => {
      const h = await harness();
      if (kind === "update") {
        await h.scheduler.schedule(root.id, interval);
        await h.settle();
      }
      h.setLoseCalendarResponse(true);
      await h.scheduler.schedule(root.id, {
        start: "2026-11-12T09:00:00Z",
        end: "2026-11-12T09:30:00Z",
      });
      await h.settle();
      const previous = h.service.registry.snapshot().schedules.at(-1)!;
      expect(previous.phase).toBe("calendar-pending");
      const eventId = [...h.events.keys()][0]!;
      const source =
        h.service.registry.snapshot().links[previous.linkUid]!.source;
      h.texts.set(
        source.path,
        h.texts.get(source.path)!.replace("Work #todoist", "Latest #todoist"),
      );
      await h.reconcile();
      expect(h.tasks.get(root.id)?.title).toBe("Latest");
      await h.restart();
      h.setLoseCalendarResponse(false);
      h.setFailCalendar(false);
      await h.settle();
      expect([...h.events.keys()]).toEqual([eventId]);
      expect(h.events.get(eventId)?.summary).toBe("Latest #todoist #work");
      expect(h.service.registry.snapshot().schedules.at(-1)?.phase).toBe(
        "complete",
      );
      expect(h.apply).toHaveBeenCalledTimes(kind === "update" ? 3 : 2);
      h.scheduler.stop();
      h.reconciler.stop();
      h.service.stop();
    },
  );

  test("offline unschedule, note edit and reschedule retain the pending event removal", async () => {
    const h = await harness();
    await h.scheduler.schedule(root.id, interval);
    await h.settle();
    const oldId = h.scheduler.projection(root.id)!.googleEventId!;
    h.setFailCalendar(true);
    await h.scheduler.unschedule(root.id);
    await h.settle();
    const source = h.scheduler.projection(root.id)!.source;
    h.texts.set(
      source.path,
      h.texts.get(source.path)!.replace("Work #todoist", "Later #todoist"),
    );
    await h.reconcile();
    expect(h.tasks.get(root.id)?.title).toBe("Later");
    await h.scheduler.schedule(root.id, {
      start: "2026-11-12T10:00:00Z",
      end: "2026-11-12T10:30:00Z",
    });
    await h.settle();
    expect(h.events.has(oldId)).toBe(true);
    expect(
      h.service.registry.snapshot().schedules.at(-1)?.calendarRemovals,
    ).toHaveLength(1);
    await h.restart();
    h.setFailCalendar(false);
    await h.settle();
    expect(h.events.has(oldId)).toBe(false);
    expect(h.events.size).toBe(1);
    expect(h.scheduler.projection(root.id)?.googleEventId).not.toBe(oldId);
    expect(h.service.registry.snapshot().schedules.at(-1)?.phase).toBe(
      "complete",
    );
    h.scheduler.stop();
    h.reconciler.stop();
    h.service.stop();
  });

  test("an uncertain create can be unscheduled while offline without leaking its event", async () => {
    const h = await harness();
    h.setLoseCalendarResponse(true);
    await h.scheduler.schedule(root.id, interval);
    await h.settle();
    expect(h.events.size).toBe(1);
    expect(Object.keys(h.calendarState.records)).toHaveLength(0);
    await h.scheduler.unschedule(root.id);
    await h.settle();
    h.setLoseCalendarResponse(false);
    h.setFailCalendar(false);
    await h.restart();
    await h.settle();
    expect(h.events.size).toBe(0);
    expect(h.scheduler.projection(root.id)?.interval).toBeNull();
    expect(h.service.registry.snapshot().schedules.at(-1)?.phase).toBe(
      "complete",
    );
    h.scheduler.stop();
    h.reconciler.stop();
    h.service.stop();
  });

  test("a failed supersession save keeps its original calendar intent recoverable", async () => {
    const h = await harness();
    h.setFailCalendar(true);
    await h.scheduler.schedule(root.id, interval);
    await h.settle();
    const before = h.service.registry.snapshot();
    h.setFailTaskWrite(true);
    await expect(
      h.scheduler.schedule(root.id, {
        start: "2026-11-12T10:00:00Z",
        end: "2026-11-12T10:30:00Z",
      }),
    ).rejects.toThrow("task state offline");
    expect(h.service.registry.snapshot()).toEqual(before);
    h.setFailTaskWrite(false);
    h.setFailCalendar(false);
    await h.settle();
    expect(h.events.size).toBe(1);
    expect(h.service.registry.snapshot().schedules[0]?.phase).toBe("complete");
    h.scheduler.stop();
    h.reconciler.stop();
    h.service.stop();
  });

  test("acknowledges task and note fields while Calendar is offline and converges later edits", async () => {
    const h = await harness();
    h.setFailCalendar(true);
    await h.scheduler.schedule(root.id, interval);
    await h.settle();
    const first = h.service.registry.snapshot().schedules[0]!;
    const link = h.service.registry.snapshot().links[first.linkUid]!;
    expect(link.base?.due?.date).toBe(interval.start);
    expect(link.noteBase).toEqual(first.plan!.links[0]!.source);
    const path = link.source.path;
    h.texts.set(
      path,
      h.texts.get(path)!.replace("Work #todoist", "Edited #todoist"),
    );
    await h.reconcile();
    expect(h.tasks.get(root.id)?.title).toBe("Edited");
    expect(Object.values(h.service.registry.snapshot().issues)).toEqual([]);
    expect(h.service.registry.snapshot().schedules[0]?.phase).toBe("cancelled");
    await h.restart();
    h.setFailCalendar(false);
    await h.settle();
    expect([...h.events.values()].map((event) => event.summary)).toEqual([
      "Edited #todoist #work",
    ]);
    expect(h.scheduler.projection(root.id)?.googleUid).toBe(first.googleUid);
    expect(h.service.registry.snapshot().schedules.at(-1)?.phase).toBe(
      "complete",
    );
    h.scheduler.stop();
    h.reconciler.stop();
    h.service.stop();
  });

  test("a cleared provider date conflicts with a simultaneous note move and stays cleared when chosen", async () => {
    const h = await harness();
    await h.scheduler.schedule(root.id, interval);
    await h.settle();
    const path = "Daily/2026-11-11.md",
      writes = h.apply.mock.calls.length;
    const originalRange = `${window.moment(interval.start).format("HH:mm")} - ${window.moment(interval.end).format("HH:mm")}`;
    const movedRange = `${window.moment(interval.start).add(1, "hour").format("HH:mm")} - ${window.moment(interval.end).add(1, "hour").format("HH:mm")}`;
    h.texts.set(path, h.texts.get(path)!.replace(originalRange, movedRange));
    h.tasks.set(root.id, { ...h.tasks.get(root.id)!, due: null });
    await h.service.refresh();
    await h.reconcile();
    const review = await h.reconciler.inspectConflict(
      Object.values(h.service.registry.snapshot().issues)[0]!.id,
    );
    expect(review.fields[0]?.remote?.due).toBeNull();
    expect(review.fields[0]?.local.due?.date).toBe("2026-11-11T10:00:00.000Z");
    await h.reconciler.resolveConflict(review, { schedule: "remote" });
    await h.settle();
    expect(h.texts.get(path)).toContain(originalRange);
    expect(h.tasks.get(root.id)?.due).toBeNull();
    expect(h.apply).toHaveBeenCalledTimes(writes);
    h.scheduler.stop();
    h.reconciler.stop();
    h.service.stop();
  });

  test("a blank local title can be restored from the provider without sending an empty update", async () => {
    const h = await harness();
    await h.scheduler.schedule(root.id, interval);
    await h.settle();
    const path = "Daily/2026-11-11.md",
      writes = h.apply.mock.calls.length;
    h.texts.set(path, h.texts.get(path)!.replace("Work #todoist", "#todoist"));
    await h.reconcile();
    const review = await h.reconciler.inspectConflict(
      Object.values(h.service.registry.snapshot().issues)[0]!.id,
    );
    expect(review.fields[0]).toMatchObject({
      key: "title",
      localAllowed: false,
    });
    await expect(
      h.reconciler.resolveConflict(review, { title: "local" }),
    ).rejects.toThrow("every conflicting field");
    await h.reconciler.resolveConflict(review, { title: "remote" });
    await h.settle();
    expect(h.texts.get(path)).toContain("Work #todoist");
    expect(h.apply).toHaveBeenCalledTimes(writes);
    h.scheduler.stop();
    h.reconciler.stop();
    h.service.stop();
  });

  test("concurrent source conflict submissions persist one projection change", async () => {
    const h = await harness();
    await h.scheduler.schedule(root.id, interval);
    await h.settle();
    const path = "Daily/2026-11-11.md";
    h.texts.set(
      path,
      h.texts.get(path)!.replace("Work #todoist", "Local #todoist"),
    );
    h.tasks.set(root.id, { ...h.tasks.get(root.id)!, title: "Remote" });
    await h.service.refresh();
    await h.reconcile();
    const review = await h.reconciler.inspectConflict(
      Object.values(h.service.registry.snapshot().issues)[0]!.id,
    );
    const count = h.service.registry.snapshot().schedules.length;
    const results = await Promise.allSettled([
      h.reconciler.resolveConflict(review, { title: "local" }),
      h.reconciler.resolveConflict(review, { title: "local" }),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    await h.settle();
    expect(h.service.registry.snapshot().schedules).toHaveLength(count + 1);
    expect(h.tasks.get(root.id)?.title).toBe("Local");
    h.scheduler.stop();
    h.reconciler.stop();
    h.service.stop();
  });

  test("note conflict choices merge the saved note title with independent provider edits", async () => {
    const h = await harness();
    await h.scheduler.schedule(root.id, interval);
    await h.settle();
    const path = "Daily/2026-11-11.md",
      eventId = h.scheduler.projection(root.id)!.googleEventId;
    h.texts.set(
      path,
      h.texts.get(path)!.replace("Work #todoist", "**Local title** #todoist"),
    );
    h.tasks.set(root.id, {
      ...h.tasks.get(root.id)!,
      title: "Remote title",
      description: "Keep remote description",
    });
    await h.service.refresh();
    await h.reconcile();
    const issue = Object.values(h.service.registry.snapshot().issues)[0]!;
    const review = await h.reconciler.inspectConflict(issue.id);
    expect(review.fields).toMatchObject([
      {
        key: "title",
        local: { title: "Local title" },
        remote: { title: "Remote title" },
      },
    ]);
    await h.reconciler.resolveConflict(review, { title: "local" });
    await h.settle();
    expect(h.tasks.get(root.id)).toMatchObject({
      title: "Local title",
      description: "Keep remote description",
    });
    expect(h.texts.get(path)).toContain("**Local title** #todoist");
    expect(h.texts.get(path)).toContain("- [ ] Child");
    expect(h.scheduler.projection(root.id)?.googleEventId).toBe(eventId);
    expect(h.service.registry.snapshot().issues).toEqual({});
    h.scheduler.stop();
    h.reconciler.stop();
    h.service.stop();
  });

  test("choosing the provider title preserves local native IDs and sends no provider update", async () => {
    const h = await harness();
    await h.scheduler.schedule(root.id, interval);
    await h.settle();
    const path = "Daily/2026-11-11.md",
      writes = h.apply.mock.calls.length;
    h.texts.set(
      path,
      h.texts
        .get(path)!
        .replace(
          "Work #todoist #work",
          "Local #todoist #work <!-- keep --> ^native",
        ),
    );
    h.tasks.set(root.id, { ...h.tasks.get(root.id)!, title: "Remote" });
    await h.service.refresh();
    await h.reconcile();
    const review = await h.reconciler.inspectConflict(
      Object.values(h.service.registry.snapshot().issues)[0]!.id,
    );
    await h.reconciler.resolveConflict(review, { title: "remote" });
    await h.settle();
    expect(h.texts.get(path)).toContain(
      "Remote #todoist #work <!-- keep --> ^native",
    );
    expect(h.texts.get(path)).toContain("- [ ] Child");
    expect(h.apply).toHaveBeenCalledTimes(writes);
    h.scheduler.stop();
    h.reconciler.stop();
    h.service.stop();
  });

  test("a note/provider edit during source conflict review requires a refreshed choice", async () => {
    const h = await harness();
    await h.scheduler.schedule(root.id, interval);
    await h.settle();
    const path = "Daily/2026-11-11.md";
    h.texts.set(
      path,
      h.texts.get(path)!.replace("Work #todoist", "Local #todoist"),
    );
    h.tasks.set(root.id, { ...h.tasks.get(root.id)!, title: "Remote" });
    await h.service.refresh();
    await h.reconcile();
    const review = await h.reconciler.inspectConflict(
      Object.values(h.service.registry.snapshot().issues)[0]!.id,
    );
    const count = h.service.registry.snapshot().schedules.length;
    h.texts.set(
      path,
      h.texts.get(path)!.replace("Local #todoist", "Local again #todoist"),
    );
    h.tasks.set(root.id, {
      ...h.tasks.get(root.id)!,
      description: "New remote description",
    });
    const result = await h.reconciler.resolveConflict(review, {
      title: "local",
    });
    expect(result.kind).toBe("changed");
    expect(h.service.registry.snapshot().schedules).toHaveLength(count);
    if (result.kind === "changed") {
      expect(result.review.fields[0]?.local.title).toBe("Local again");
      await h.reconciler.resolveConflict(result.review, { title: "local" });
      await h.settle();
    }
    expect(h.tasks.get(root.id)).toMatchObject({
      title: "Local again",
      description: "New remote description",
    });
    h.scheduler.stop();
    h.reconciler.stop();
    h.service.stop();
  });

  test("a chosen provider interval moves the note while preserving task date and event identity", async () => {
    const h = await harness();
    await h.scheduler.schedule(root.id, interval);
    await h.settle();
    const path = "Daily/2026-11-11.md",
      eventId = h.scheduler.projection(root.id)!.googleEventId;
    const oldStart = window.moment(interval.start).format("HH:mm"),
      oldEnd = window.moment(interval.end).format("HH:mm");
    const localStart = window
        .moment(interval.start)
        .add(1, "hour")
        .format("HH:mm"),
      localEnd = window.moment(interval.end).add(1, "hour").format("HH:mm");
    h.texts.set(
      path,
      h.texts
        .get(path)!
        .replace(`${oldStart} - ${oldEnd}`, `${localStart} - ${localEnd}`),
    );
    h.tasks.set(root.id, {
      ...h.tasks.get(root.id)!,
      due: { date: "2026-11-12", recurring: false, text: "", timezone: null },
    });
    await h.service.refresh();
    await h.reconcile();
    const review = await h.reconciler.inspectConflict(
      Object.values(h.service.registry.snapshot().issues)[0]!.id,
    );
    expect(review.fields[0]?.fields).toEqual(["interval", "due"]);
    await h.reconciler.resolveConflict(review, { schedule: "remote" });
    await h.settle();
    expect(h.texts.get("Daily/2026-11-12.md")).toContain(
      `${oldStart} - ${oldEnd}`,
    );
    expect(h.texts.get(path)).not.toContain("- [ ] Child");
    expect(h.tasks.get(root.id)?.due?.date).toBe("2026-11-12");
    expect(h.scheduler.projection(root.id)?.googleEventId).toBe(eventId);
    h.scheduler.stop();
    h.reconciler.stop();
    h.service.stop();
  });

  test("failed source resolution intent leaves note/provider values and the conflict intact", async () => {
    const h = await harness();
    await h.scheduler.schedule(root.id, interval);
    await h.settle();
    const path = "Daily/2026-11-11.md";
    h.texts.set(
      path,
      h.texts.get(path)!.replace("Work #todoist", "Local #todoist"),
    );
    h.tasks.set(root.id, { ...h.tasks.get(root.id)!, title: "Remote" });
    await h.service.refresh();
    await h.reconcile();
    const review = await h.reconciler.inspectConflict(
      Object.values(h.service.registry.snapshot().issues)[0]!.id,
    );
    h.setFailTaskWrite(true);
    await expect(
      h.reconciler.resolveConflict(review, { title: "remote" }),
    ).rejects.toThrow("task state offline");
    expect(h.texts.get(path)).toContain("Local #todoist");
    expect(h.tasks.get(root.id)?.title).toBe("Remote");
    expect(Object.values(h.service.registry.snapshot().issues)).toHaveLength(1);
    h.scheduler.stop();
    h.reconciler.stop();
    h.service.stop();
  });

  test("a captured untimed note gains navigation while a provider date stays unscheduled", async () => {
    const h = await harness();
    const path = "Projects/Work.md",
      text = "- [ ] Work #todoist #work\n";
    h.file(path);
    h.texts.set(path, text);
    const source = parseCaptureCandidates(path, text)[0]!;
    await h.service.registry.change((state) => {
      state.links.captured = {
        provider: "todoist",
        accountId: "account",
        taskId: root.id,
        source,
        noteBase: source,
        base: root,
      };
    });
    await h.reconcile();
    expect(h.scheduler.projection(root.id)).toMatchObject({
      source: { path },
      interval: null,
    });
    h.tasks.set(root.id, {
      ...root,
      due: { date: "2026-11-13", text: "", timezone: null, recurring: false },
    });
    await h.service.refresh();
    await h.reconcile();
    expect(h.scheduler.projection(root.id)?.interval).toBeNull();
    expect(h.events.size).toBe(0);
    expect(h.apply).not.toHaveBeenCalled();
    h.scheduler.stop();
    h.service.stop();
    h.reconciler.stop();
  });

  test("an actively edited note defers reconciliation until its source becomes stable", async () => {
    const h = await harness();
    await h.scheduler.schedule(root.id, interval);
    await h.settle();
    const path = "Daily/2026-11-11.md",
      writes = h.apply.mock.calls.length;
    h.texts.set(
      path,
      h.texts.get(path)!.replace("Work #todoist", "Editing #todoist"),
    );
    h.setStable(false);
    await h.reconcile();
    expect(h.apply).toHaveBeenCalledTimes(writes);
    expect(h.tasks.get(root.id)?.title).toBe(root.title);
    h.setStable(true);
    await h.reconcile();
    expect(h.tasks.get(root.id)?.title).toBe("Editing");
    h.scheduler.stop();
    h.service.stop();
    h.reconciler.stop();
  });

  test("a provider race after note intent recovers chosen remote values through the same projection", async () => {
    const h = await harness();
    await h.scheduler.schedule(root.id, interval);
    await h.settle();
    const path = "Daily/2026-11-11.md",
      eventId = h.scheduler.projection(root.id)!.googleEventId;
    h.texts.set(
      path,
      h.texts.get(path)!.replace("Work #todoist", "Local #todoist"),
    );
    h.tasks.set(root.id, {
      ...h.tasks.get(root.id)!,
      title: "Concurrent remote",
    });
    await h.reconcile();
    const pending = h.service.registry
      .snapshot()
      .schedules.find(
        (operation) =>
          operation.target.kind === "reconcile" &&
          operation.phase === "conflict",
      )!;
    expect(pending).toBeDefined();
    const review = await h.service.inspectConflict(
      pending.providerSteps![0]!.id,
    );
    await h.service.resolveConflict(review, { title: "remote" });
    await h.settle();
    await vi.waitUntil(
      () =>
        h.service.registry.snapshot().schedules.at(-1)?.phase === "complete",
    );
    expect(h.texts.get(path)).toContain("Concurrent remote #todoist");
    expect(h.scheduler.projection(root.id)?.googleEventId).toBe(eventId);
    await h.reconcile();
    expect(h.service.registry.snapshot().issues).toEqual({});
    expect(h.apply).toHaveBeenCalledTimes(1);
    h.scheduler.stop();
    h.service.stop();
    h.reconciler.stop();
  });

  test("reconciling one block refreshes positions before processing the next block", async () => {
    const h = await harness();
    const second = { ...root, id: "second", title: "Second", order: 3 };
    h.tasks.set(second.id, second);
    await h.service.refresh();
    await h.scheduler.schedule(root.id, interval);
    await h.settle();
    await h.scheduler.schedule(second.id, {
      start: "2026-11-11T11:00:00Z",
      end: "2026-11-11T11:30:00Z",
    });
    await h.settle();
    const secondId = h.scheduler.projection(second.id)!.googleEventId;
    h.tasks.set(root.id, {
      ...h.tasks.get(root.id)!,
      title: "A much longer remote title",
    });
    h.tasks.set(second.id, {
      ...h.tasks.get(second.id)!,
      title: "Another remote title",
    });
    await h.service.refresh();
    await h.reconcile();
    expect(h.events.size).toBe(2);
    expect(h.scheduler.projection(second.id)?.googleEventId).toBe(secondId);
    expect(h.scheduler.projection(second.id)?.interval).not.toBeNull();
    expect(h.texts.get("Daily/2026-11-11.md")).toContain(
      "Another remote title",
    );
    h.scheduler.stop();
    h.service.stop();
    h.reconciler.stop();
  });

  test("note titles and independent provider descriptions merge through the existing journal", async () => {
    const h = await harness();
    await h.scheduler.schedule(root.id, interval);
    await h.settle();
    const eventId = h.scheduler.projection(root.id)!.googleEventId;
    const path = "Daily/2026-11-11.md";
    h.texts.set(
      path,
      h.texts.get(path)!.replace("Work #todoist", "**Focused work** #todoist"),
    );
    h.tasks.set(root.id, {
      ...h.tasks.get(root.id)!,
      description: "Remote description",
    });
    await h.service.refresh();
    await h.reconcile();
    expect(h.tasks.get(root.id)).toMatchObject({
      title: "Focused work",
      description: "Remote description",
    });
    expect(h.texts.get(path)).toContain("**Focused work** #todoist");
    expect(h.texts.get(path)).toContain("- [ ] Child");
    expect(h.scheduler.projection(root.id)?.googleEventId).toBe(eventId);
    expect(h.service.registry.snapshot().issues).toEqual({});
    h.scheduler.stop();
    h.service.stop();
    h.reconciler.stop();
  });

  test("ambiguous source links become individual issues while another note still reconciles", async () => {
    const h = await harness();
    await h.scheduler.schedule(root.id, interval);
    await h.settle();
    const other: ProviderTask = { ...root, id: "other", title: "Independent" };
    h.tasks.set(other.id, other);
    h.file("Other.md");
    h.texts.set("Other.md", "");
    await h.service.refresh();
    await h.scheduler.insert(other.id, {
      path: "Other.md",
      offset: 0,
      before: "",
    });
    await h.settle();
    const eventId = h.scheduler.projection(root.id)!.googleEventId;
    const path = "Daily/2026-11-11.md";
    h.texts.set(
      path,
      h.texts
        .get(path)!
        .replace("Work #todoist", "Different parent #todoist")
        .replace("- [ ] Child", "- [ ] Different child"),
    );
    h.texts.set(
      "Other.md",
      h.texts
        .get("Other.md")!
        .replace("Independent #todoist", "Edited independent #todoist"),
    );
    await h.reconcile();
    const issues = get(h.reconciler.state).issues;
    expect(issues.map((issue) => issue.taskId).sort()).toEqual(
      [child.id, root.id].sort(),
    );
    expect(
      issues.every(
        (issue) =>
          issue.fields.includes("source") &&
          issue.message.includes("Several note tasks"),
      ),
    ).toBe(true);
    expect(get(h.reconciler.state).error).toBe("");
    expect(h.tasks.get(other.id)?.title).toBe("Edited independent");
    expect(h.tasks.get(root.id)?.title).toBe("Work");
    expect(h.events.size).toBe(1);
    expect([...h.events.keys()]).toEqual([eventId]);
    h.scheduler.stop();
    h.service.stop();
    h.reconciler.stop();
  });

  test("provider title/completion edits reach the linked note and preserve its child bytes", async () => {
    const h = await harness();
    await h.scheduler.schedule(root.id, interval);
    await h.settle();
    const writes = h.apply.mock.calls.length;
    h.tasks.set(root.id, {
      ...h.tasks.get(root.id)!,
      title: "Edited remotely",
      completed: true,
    });
    await h.service.refresh();
    await h.reconcile();
    expect(h.texts.get("Daily/2026-11-11.md")).toContain(
      `- [x] ${window.moment(interval.start).format("HH:mm")} - ${window.moment(interval.end).format("HH:mm")} Edited remotely #todoist #work`,
    );
    expect(h.texts.get("Daily/2026-11-11.md")).toContain("- [ ] Child");
    expect(h.apply).toHaveBeenCalledTimes(writes);
    h.scheduler.stop();
    h.service.stop();
    h.reconciler.stop();
  });

  test("local checkbox completion and reopening target the same provider task", async () => {
    const h = await harness();
    await h.scheduler.schedule(root.id, interval);
    await h.settle();
    const path = "Daily/2026-11-11.md";
    h.texts.set(
      path,
      h.texts.get(path)!.replace(/- \[ \] (?=\d{2}:\d{2})/, "- [x] "),
    );
    await h.reconcile();
    expect(h.tasks.get(root.id)?.completed).toBe(true);
    h.texts.set(
      path,
      h.texts.get(path)!.replace(/- \[x\] (?=\d{2}:\d{2})/, "- [ ] "),
    );
    await h.reconcile();
    expect(h.tasks.get(root.id)?.completed).toBe(false);
    expect(h.events.size).toBe(1);
    h.scheduler.stop();
    h.service.stop();
    h.reconciler.stop();
  });

  test("manual time edits and a remote date-only move preserve event identity and clock time", async () => {
    const h = await harness();
    await h.scheduler.schedule(root.id, interval);
    await h.settle();
    const eventId = h.scheduler.projection(root.id)!.googleEventId;
    const path = "Daily/2026-11-11.md";
    const oldRange = `${window.moment(interval.start).format("HH:mm")} - ${window.moment(interval.end).format("HH:mm")}`;
    const newRange = `${window.moment(interval.start).add(1, "hour").format("HH:mm")} - ${window.moment(interval.start).add(105, "minutes").format("HH:mm")}`;
    h.texts.set(path, h.texts.get(path)!.replace(oldRange, newRange));
    await h.reconcile();
    expect(h.tasks.get(root.id)?.due?.date).toBe("2026-11-11T10:00:00.000Z");
    h.tasks.set(root.id, {
      ...h.tasks.get(root.id)!,
      due: { date: "2026-11-12", recurring: false, text: "", timezone: null },
    });
    await h.service.refresh();
    await h.reconcile();
    expect(h.texts.get("Daily/2026-11-12.md")).toContain(`${newRange} Work`);
    expect(h.texts.get(path)).not.toContain("- [ ] Child");
    expect(h.scheduler.projection(root.id)?.googleEventId).toBe(eventId);
    expect(h.tasks.get(root.id)?.due?.date).toBe("2026-11-12");
    h.scheduler.stop();
    h.service.stop();
    h.reconciler.stop();
  });

  test("same-field note/provider conflicts preserve both sides until they agree", async () => {
    const h = await harness();
    await h.scheduler.schedule(root.id, interval);
    await h.settle();
    const path = "Daily/2026-11-11.md",
      writes = h.apply.mock.calls.length;
    h.texts.set(
      path,
      h.texts.get(path)!.replace("Work #todoist", "Local #todoist"),
    );
    h.tasks.set(root.id, { ...h.tasks.get(root.id)!, title: "Remote" });
    await h.service.refresh();
    await h.reconcile();
    expect(
      Object.values(h.service.registry.snapshot().issues)[0]?.fields,
    ).toContain("title");
    expect(h.apply).toHaveBeenCalledTimes(writes);
    expect(h.texts.get(path)).toContain("Local #todoist");
    h.texts.set(
      path,
      h.texts.get(path)!.replace("Local #todoist", "Remote #todoist"),
    );
    await h.reconcile();
    expect(h.service.registry.snapshot().issues).toEqual({});
    h.scheduler.stop();
    h.service.stop();
    h.reconciler.stop();
  });

  test("new scheduling creates one linked subtree, then repeated drops move its existing event", async () => {
    const h = await harness();
    const dropId = crypto.randomUUID();
    await Promise.all([
      h.scheduler.schedule(root.id, interval, dropId),
      h.scheduler.schedule(root.id, interval, dropId),
    ]);
    await h.settle();
    expect(h.events.size).toBe(1);
    const projection = h.scheduler.projection(root.id)!;
    const eventId = projection.googleEventId;
    expect(projection.source.raw).toContain("- [ ] Child");
    expect(Object.keys(h.service.registry.snapshot().links)).toHaveLength(2);
    expect(h.tasks.get(root.id)?.due?.date).toBe(interval.start);
    expect(h.tasks.get(root.id)?.duration).toBeUndefined();
    await h.scheduler.schedule(root.id, {
      start: "2026-11-12T10:00:00Z",
      end: "2026-11-12T10:45:00Z",
    });
    await h.settle();
    const moved = h.scheduler.projection(root.id)!;
    expect(moved.googleUid).toBe(projection.googleUid);
    expect(moved.googleEventId).toBe(eventId);
    expect(h.events.size).toBe(1);
    expect(h.texts.get("Daily/2026-11-11.md")).not.toContain("Work #todoist");
    expect(h.texts.get("Daily/2026-11-12.md")).toContain("- [ ] Child");
    expect(
      h.service.registry
        .snapshot()
        .schedules.every((op) => op.phase === "complete"),
    ).toBe(true);
    h.scheduler.stop();
    h.service.stop();
  });

  test("adopts an existing calendar block and event without replacing their identity", async () => {
    const h = await harness(),
      path = "Daily/2026-11-11.md";
    h.file(path);
    h.texts.set(
      path,
      "# Day planner\n- [ ] 09:00 - 09:30 Work #todoist #work ^native\n  - [ ] Local-only child\n",
    );
    const [block] = await h.notes.scan();
    const source = parseCaptureCandidates(path, h.texts.get(path)!)[0]!;
    await h.service.registry.change((state) => {
      state.links.source = {
        provider: "todoist",
        accountId: "account",
        taskId: root.id,
        source,
        base: root,
      };
    });
    const existing = await h.scheduler.schedule(root.id, interval);
    await h.settle();
    expect(h.scheduler.projection(root.id)?.googleUid).toBe(block!.uid);
    expect(h.events.size).toBe(1);
    expect(
      h.service.registry.snapshot().links[existing.linkUid]?.source.raw,
    ).toContain("^native");
    expect(h.texts.get(path)).toContain("Local-only child");
    h.scheduler.stop();
    h.service.stop();
  });

  test("failed intent persistence writes no note or provider task", async () => {
    const h = await harness();
    h.setFailTaskWrite(true);
    await expect(h.scheduler.schedule(root.id, interval)).rejects.toThrow(
      "task state offline",
    );
    expect(h.texts.size).toBe(0);
    expect(h.apply).not.toHaveBeenCalled();
    expect(h.process).not.toHaveBeenCalled();
    h.scheduler.stop();
    h.service.stop();
  });

  test("a cross-day interruption recovers its journal and preserves child text", async () => {
    const h = await harness();
    await h.scheduler.schedule(root.id, interval);
    await h.settle();
    const id = h.scheduler.projection(root.id)!.googleEventId;
    h.setFailPath("Daily/2026-11-11.md");
    await h.scheduler.schedule(root.id, {
      start: "2026-11-12T09:00:00Z",
      end: "2026-11-12T09:30:00Z",
    });
    await h.scheduler.resume();
    expect(h.calendarState.pendingNoteChange).toBeDefined();
    h.setFailPath("");
    await h.restart();
    await h.settle();
    expect(h.calendarState.pendingNoteChange).toBeUndefined();
    expect(h.scheduler.projection(root.id)?.googleEventId).toBe(id);
    expect(h.texts.get("Daily/2026-11-11.md")).not.toContain("- [ ] Child");
    expect(h.texts.get("Daily/2026-11-12.md")).toContain("- [ ] Child");
    expect(h.events.size).toBe(1);
    h.scheduler.stop();
    h.service.stop();
  });

  test("Google recovery resumes its phase after acknowledged Todoist success", async () => {
    const h = await harness();
    h.setFailCalendar(true);
    await h.scheduler.schedule(root.id, interval);
    await h.settle();
    expect(h.service.registry.snapshot().schedules[0]?.phase).toBe(
      "calendar-pending",
    );
    expect(h.apply).toHaveBeenCalledTimes(1);
    await h.restart();
    h.setFailCalendar(false);
    await h.settle();
    expect(h.apply).toHaveBeenCalledTimes(1);
    expect(h.events.size).toBe(1);
    expect(h.service.registry.snapshot().schedules[0]?.phase).toBe("complete");
    h.scheduler.stop();
    h.service.stop();
  });

  test("unscheduling preserves the provider date and child subtree while removing its managed event", async () => {
    const h = await harness();
    await h.scheduler.schedule(root.id, interval);
    await h.settle();
    const due = structuredClone(h.tasks.get(root.id)?.due),
      writes = h.apply.mock.calls.length;
    await h.scheduler.unschedule(root.id);
    await h.settle();
    expect(h.scheduler.projection(root.id)?.interval).toBeNull();
    expect(h.events.size).toBe(0);
    expect(h.tasks.get(root.id)?.due).toEqual(due);
    expect(h.apply).toHaveBeenCalledTimes(writes);
    expect(h.texts.get("Daily/2026-11-11.md")).toContain(
      "- [ ] Work #todoist #work\n  - [ ] Child",
    );
    h.scheduler.stop();
    h.service.stop();
  });

  test("a Markdown drop moves the linked subtree and keeps its provider date", async () => {
    const h = await harness();
    await h.scheduler.schedule(root.id, interval);
    await h.settle();
    const original = h.scheduler.projection(root.id)!;
    const due = structuredClone(h.tasks.get(root.id)?.due);
    const path = "Projects/Work.md";
    const before = "# Work\n\nKeep this paragraph.\n";
    h.file(path);
    h.texts.set(path, before);
    await h.scheduler.insert(root.id, { path, before, offset: before.length });
    await h.settle();
    const inserted = h.scheduler.projection(root.id)!;
    expect(inserted.linkUid).toBe(original.linkUid);
    expect(inserted.source.path).toBe(path);
    expect(inserted.interval).toBeNull();
    expect(h.events.size).toBe(0);
    expect(h.tasks.get(root.id)?.due).toEqual(due);
    expect(h.texts.get(path)).toContain(
      "Keep this paragraph.\n- [ ] Work #todoist #work\n  - [ ] Child",
    );
    expect(h.texts.get("Daily/2026-11-11.md")).not.toContain("- [ ] Child");
    expect(Object.keys(h.service.registry.snapshot().links)).toHaveLength(2);
    h.scheduler.stop();
    h.service.stop();
  });

  test("resolving a provider date conflict moves its saved schedule without replaying that command", async () => {
    const h = await harness();
    h.tasks.set(root.id, {
      ...root,
      due: {
        date: "2026-11-12",
        recurring: false,
        text: "",
        timezone: null,
      },
    });
    const original = await h.scheduler.schedule(root.id, interval);
    await h.settle();
    expect(h.service.registry.snapshot().schedules[0]?.phase).toBe("conflict");
    const review = await h.service.inspectConflict(
      original.providerOperationId,
    );
    await h.service.resolveConflict(review, { schedule: "remote" });
    await h.settle();
    await vi.waitUntil(
      () => h.service.registry.snapshot().schedules[1]?.phase === "complete",
    );
    expect(h.service.registry.snapshot().schedules[0]?.phase).toBe("cancelled");
    expect(h.scheduler.projection(root.id)?.interval).toEqual({
      start: "2026-11-12T09:00:00.000Z",
      end: "2026-11-12T09:30:00.000Z",
    });
    expect(h.apply).not.toHaveBeenCalled();
    expect(h.events.size).toBe(1);
    expect(h.texts.get("Daily/2026-11-12.md")).toContain("- [ ] Child");
    expect(h.texts.get("Daily/2026-11-11.md")).not.toContain("- [ ] Child");
    h.scheduler.stop();
    h.service.stop();
  });

  test("a changed destination suspends its saved drop before changing the source", async () => {
    const h = await harness();
    await h.scheduler.schedule(root.id, interval);
    await h.settle();
    const path = "Projects/Work.md";
    h.file(path);
    h.texts.set(path, "Changed destination\n");
    const operation = await h.scheduler.insert(root.id, {
      path,
      offset: 0,
      before: "Old destination\n",
    });
    await h.settle();
    expect(
      h.service.registry
        .snapshot()
        .schedules.find((op) => op.id === operation.id)?.phase,
    ).toBe("conflict");
    expect(h.texts.get(path)).toBe("Changed destination\n");
    expect(h.texts.get("Daily/2026-11-11.md")).toContain("- [ ] Child");
    expect(h.events.size).toBe(1);
    h.scheduler.stop();
    h.service.stop();
  });
});
