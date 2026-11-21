import moment, { parseZone } from "moment";
import type { Plugin } from "obsidian";
import { Notice } from "obsidian";
import { afterEach, expect, test, vi } from "vitest";

vi.mock("obsidian", async () => ({
  moment: (await import("moment")).default,
  Modal: class {},
  Notice: vi.fn(),
  Platform: { isDesktopApp: true },
  TFile: class {},
}));

import {
  GoogleCalendarSync,
  type CalendarNoteEditScope,
} from "../src/google-calendar/service";
import type {
  CalendarSyncState,
  GoogleEvent,
} from "../src/google-calendar/types";
import type { AppStore } from "../src/redux/store";
import type { PeriodicNotes } from "../src/service/periodic-notes";
import { defaultSettingsForTests } from "../src/settings";

const uid = "a".repeat(32),
  namespace = "b".repeat(32),
  path = "Daily/2031-01-01.md";
const snapshot = {
  title: "Task",
  start: "2031-01-01T09:00:00.000Z",
  end: "2031-01-01T10:00:00.000Z",
  tags: [],
};

function setup() {
  const state: CalendarSyncState = {
    version: 2,
    namespace,
    calendarId: "calendar",
    records: { [uid]: { eventId: "event", path, base: snapshot } },
    identities: { [uid]: { path, raw: "- [ ] 09:00 Task", from: 0, snapshot } },
  };
  const service = new GoogleCalendarSync(
    { app: {} } as Plugin,
    {} as PeriodicNotes,
    () => ({
      ...defaultSettingsForTests,
      googleCalendar: {
        ...defaultSettingsForTests.googleCalendar,
        autoSync: true,
      },
    }),
    {} as AppStore,
  );
  const event: GoogleEvent = {
    id: "event",
    etag: "v1",
    summary: "Task",
    start: { dateTime: snapshot.start },
    end: { dateTime: snapshot.end },
    extendedProperties: {
      private: { dayPlannerVault: namespace, dayPlannerBlock: uid },
    },
  };
  const api = {
    validateCalendar: vi.fn(async () => "calendar"),
    get: vi.fn(async () => event),
    remove: vi.fn(async () => {
      expect(Reflect.get(service, "busy")).toBe(true);
    }),
  };
  const notes = {
    scan: vi.fn(async () => []),
    canSync: vi.fn(async () => true),
  };
  Reflect.set(service, "state", state);
  Reflect.set(
    service,
    "api",
    vi.fn(() => api),
  );
  Reflect.set(
    service,
    "noteContext",
    vi.fn(() => ({ notes })),
  );
  Reflect.set(
    service,
    "save",
    vi.fn(async () => {}),
  );
  vi.spyOn(service, "refreshView").mockResolvedValue();
  return { service, state, api, notes, event };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

test("AI cleanup uses the existing ownership/version checks under the note-edit fence", async () => {
  vi.useFakeTimers();
  const h = setup();
  h.service.setPlanningUndoHold(true);
  let completedScope: CalendarNoteEditScope | undefined;
  await h.service.editNotes(async (_notes, _blocks, scope) => {
    expect(Reflect.get(h.service, "busy")).toBe(true);
    completedScope = scope;
    await scope.removeProjection(uid, snapshot, path);
  });
  expect(h.api.remove).toHaveBeenCalledExactlyOnceWith(h.event);
  expect(h.state.records[uid]?.deleted).toBe(true);
  expect(Reflect.get(h.service, "busy")).toBe(false);
  await expect(
    completedScope!.removeProjection(uid, snapshot, path),
  ).rejects.toThrow("finished");
  expect(h.api.get).toHaveBeenCalledTimes(1);
  await expect(h.service.removeProjection(uid, snapshot, path)).rejects.toThrow(
    "pending AI Undo",
  );
});

test("scoped cleanup preserves a Google event that changed after export", async () => {
  vi.useFakeTimers();
  const h = setup();
  h.event.summary = "Changed remotely";
  await expect(
    h.service.editNotes(async (_notes, _blocks, scope) => {
      await scope.removeProjection(uid, snapshot, path);
    }),
  ).rejects.toThrow("changed in Google Calendar");
  expect(h.api.remove).not.toHaveBeenCalled();
  expect(h.state.records[uid]?.deleted).not.toBe(true);
  expect(Reflect.get(h.service, "busy")).toBe(false);
});

test("an uncertain create is cleaned by its owned event identity and cannot resume afterward", async () => {
  vi.useFakeTimers();
  const h = setup();
  delete h.state.records[uid];
  expect(h.service.projectionNeedsCleanup(uid)).toBe(false);
  h.event.id = `dp${namespace}${uid}`;
  h.state.pendingCreate = { uid, path, snapshot, eventId: h.event.id };
  expect(h.service.projectionNeedsCleanup(uid)).toBe(true);
  h.service.setPlanningUndoHold(true);
  await h.service.editNotes(async (_notes, _blocks, scope) => {
    await scope.removeProjection(uid, snapshot, path);
  });
  expect(h.api.get).toHaveBeenCalledExactlyOnceWith(h.event.id);
  expect(h.api.remove).toHaveBeenCalledExactlyOnceWith(h.event);
  expect(h.state.pendingCreate).toBeUndefined();
  expect(h.state.records[uid]?.deleted).toBe(true);
  expect(h.service.projectionNeedsCleanup(uid)).toBe(false);
});

test("a held Undo quietly stops automatic sync while local edits remain available", async () => {
  vi.useFakeTimers();
  const h = setup();
  h.service.setPlanningUndoHold(true);
  const reset = vi.spyOn(h.service, "resetForUserRetry");
  await h.service.run(true);
  await h.service.run();
  expect(reset).not.toHaveBeenCalled();
  expect(h.api.get).not.toHaveBeenCalled();
  expect(Notice).toHaveBeenCalledExactlyOnceWith(
    expect.stringContaining("pending AI Undo"),
  );
  const localEdit = vi.fn(async () => "saved locally");
  expect(await h.service.editNotes(localEdit)).toBe("saved locally");
  const run = vi.spyOn(h.service, "run").mockResolvedValue();
  Reflect.get(h.service, "queueAutomaticSync").call(h.service);
  await vi.advanceTimersByTimeAsync(6_000);
  expect(run).not.toHaveBeenCalled();
  h.service.setPlanningUndoHold(false);
  await vi.advanceTimersByTimeAsync(13_999);
  expect(run).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(run).toHaveBeenCalledExactlyOnceWith(true);
});

test("identity snapshots are detached from the service state", () => {
  const h = setup(),
    snapshot = h.service.identitySnapshot();
  snapshot[uid]!.snapshot.title = "External copy";
  delete snapshot[uid];
  expect(h.state.identities![uid]?.snapshot.title).toBe("Task");
});

function setupCalendarRead() {
  const h = setup();
  const settings = {
    ...defaultSettingsForTests,
    googleCalendar: {
      ...defaultSettingsForTests.googleCalendar,
      showCalendarEvents: true,
      visibleCalendarIds: ["calendar", "personal", "task-feed"],
    },
  };
  const dispatch = vi.fn();
  Reflect.set(h.service, "store", {
    dispatch,
    getState: () => ({
      ical: {
        taskCalendarDisplay: { googleCalendarIds: ["task-feed"], icalUrls: [] },
      },
    }),
  });
  Reflect.set(h.service, "getSettings", () => settings);
  Reflect.set(h.service, "clientId", () => "client");
  vi.spyOn(h.service, "isConnected").mockReturnValue(true);
  vi.spyOn(h.service, "calendars").mockResolvedValue(
    ["calendar", "personal", "task-feed", "other"].map((id) => ({
      id,
      summary: id,
      selected: true,
    })),
  );
  const list = vi.fn(async () => [h.event]);
  const personalList = vi.fn(async () => [
    {
      ...h.event,
      id: "personal-event",
      colorId: "1",
      extendedProperties: undefined,
    },
  ]);
  Reflect.set(h.service, "api", (id?: string) => ({
    eventColors: async () => ({ "1": { background: "#123456" } }),
    list: id === "personal" ? personalList : list,
  }));
  return { ...h, settings, dispatch, list, personalList };
}

test("calendar reads use the requested range and configured display policy without changing the viewport", async () => {
  const h = setupCalendarRead();
  const first = parseZone("2031-01-01T00:00:00+05:30");
  const last = first.clone().add(7, "days");
  const blocks = await h.service.readCalendarBlocks(first, last);
  expect(h.list).toHaveBeenCalledExactlyOnceWith(
    first.toISOString(),
    last.toISOString(),
  );
  expect(h.personalList).toHaveBeenCalledExactlyOnceWith(
    first.toISOString(),
    last.toISOString(),
  );
  expect(blocks).toHaveLength(1);
  expect(blocks[0]).toMatchObject({
    calendar: { name: "personal", color: "#123456" },
    summary: "Task",
  });
  expect(h.dispatch).not.toHaveBeenCalled();
  expect(h.api.remove).not.toHaveBeenCalled();
  expect(first.format()).toBe("2031-01-01T00:00:00+05:30");
});

test("calendar reads preserve display disablement and propagate unavailable data", async () => {
  const h = setupCalendarRead();
  const first = moment("2031-01-01");
  const last = first.clone().add(1, "day");
  h.settings.googleCalendar.showCalendarEvents = false;
  expect(await h.service.readCalendarBlocks(first, last)).toEqual([]);
  expect(h.list).not.toHaveBeenCalled();
  h.settings.googleCalendar.showCalendarEvents = true;
  h.personalList.mockRejectedValueOnce(new Error("Calendar unavailable"));
  await expect(h.service.readCalendarBlocks(first, last)).rejects.toThrow(
    "Calendar unavailable",
  );
  vi.spyOn(h.service, "isConnected").mockReturnValue(false);
  await expect(h.service.readCalendarBlocks(first, last)).rejects.toThrow(
    "Connect Google Calendar",
  );
  h.settings.googleCalendar.calendarId = "";
  h.settings.googleCalendar.visibleCalendarIds = [];
  expect(await h.service.readCalendarBlocks(first, last)).toEqual([]);
  expect(h.dispatch).not.toHaveBeenCalled();
});
