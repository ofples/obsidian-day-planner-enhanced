import { TFile, type App } from "obsidian";
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
import { TaskReconciler } from "../src/tasks/reconcile";
import { mutationFields } from "../src/tasks/operations";
import { taskCaptureSettingsSchema } from "../src/tasks/capture-settings";
import type { TaskOperation } from "../src/tasks/operations";
import { TaskScheduler } from "../src/tasks/schedule";
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
      defaultSettings,
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
    "editNotes" | "syncProjection" | "recoverProjection" | "removeProjection"
  > = {
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
      capabilities: { duration: false },
    },
    projects: [{ id: "work", name: "Work", order: 1, inbox: true }],
    tasks: structuredClone(
      [...tasks.values()].filter((task) => !task.completed),
    ),
    fetchedAt: new Date().toISOString(),
  });
  const commands = new Map<string, string>();
  const apply = vi.fn(async (operation: TaskOperation) => {
    if (!commands.has(operation.id) && operation.mutation.kind !== "create")
      tasks.set(operation.mutation.taskId, {
        ...tasks.get(operation.mutation.taskId)!,
        ...mutationFields(operation.mutation),
      });
    commands.set(operation.id, "applied");
    return {
      taskId:
        operation.mutation.kind === "create"
          ? "unexpected"
          : operation.mutation.taskId,
    };
  });
  const provider = () => ({
    read: async () => snapshot(),
    get: async (id: string) => structuredClone(tasks.get(id) ?? null),
    apply,
  });
  const storage = {
    read: async () => cache,
    write: async (text: string) => {
      cache = text;
    },
    readState: async () => taskDisk,
    writeState: async (text: string) => {
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
  return {
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
    setStable(value: boolean) {
      stable = value;
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
    },
  };
}

describe("linked task scheduling", () => {
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
