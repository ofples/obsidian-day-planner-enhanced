import { webcrypto } from "node:crypto";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { syncCanonicalCalendar } from "../src/google-calendar/canonical-engine";
import { importUid } from "../src/google-calendar/engine";
import { renderBlock } from "../src/google-calendar/markdown";
import { defaultSettingsForTests } from "../src/settings";
import { structuredDescription } from "../src/google-calendar/subtasks";
import type {
  CalendarApi,
  CalendarNotes,
  CalendarSnapshot,
  CalendarSyncState,
  GoogleEvent,
  LocalBlock,
} from "../src/google-calendar/types";

beforeEach(() => vi.stubGlobal("crypto", webcrypto));
const timeMin = "2026-11-14T00:00:00.000Z",
  timeMax = "2026-11-15T00:00:00.000Z";
const state = (): CalendarSyncState => ({
  version: 2,
  namespace: "a".repeat(32),
  calendarId: "fixture",
  records: {},
});
const event = (
  id: string,
  start = "2026-11-14T09:00:00.000Z",
): GoogleEvent => ({
  id,
  etag: "v1",
  summary: "Event",
  start: { dateTime: start },
  end: { dateTime: new Date(Date.parse(start) + 3600000).toISOString() },
  description: structuredDescription("", [], ""),
});
const notes = (): CalendarNotes => ({
  scan: vi.fn(async () => []),
  isUnchanged: vi.fn(async () => true),
  canDelete: vi.fn(async () => false),
  cancel: vi.fn(async () => {}),
  write: vi.fn(async (uid, snapshot) => ({
    uid,
    path: "Daily.md",
    raw: "- Event",
    snapshot,
  })),
});
const run = (
  state: CalendarSyncState,
  api: CalendarApi,
  note: CalendarNotes,
  importEvents = true,
) =>
  syncCanonicalCalendar({
    state,
    api,
    notes: note,
    save: vi.fn(async () => {}),
    timeMin,
    timeMax,
    importEvents,
  });

describe("canonical incremental cache", () => {
  test("reuses cached events and supplies the prior sync token", async () => {
    const data = state();
    data.eventCache = {
      timeMin,
      timeMax,
      syncToken: "first",
      events: [event("cached")],
    };
    const changes = vi.fn(async () => ({
      events: [],
      syncToken: "next",
      reset: false,
    }));
    const api = {
      changes,
      list: vi.fn(),
      get: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      remove: vi.fn(),
    } as unknown as CalendarApi;
    await run(data, api, notes(), false);
    expect(changes).toHaveBeenCalledWith(timeMin, timeMax, "first");
    expect(data.eventCache?.events.map((item) => item.id)).toEqual(["cached"]);
    expect(data.eventCache?.syncToken).toBe("next");
  });

  test("a reset replaces the cache without clearing saved drafts", async () => {
    const data = state(),
      old = event("old"),
      fresh = event("fresh");
    const draft = {
      mine: { title: "Draft", start: timeMin, end: timeMax },
      raw: "- Draft",
      fields: ["title"],
      detectedAt: "now",
    };
    data.records.keep = {
      eventId: "old",
      path: "outside.md",
      base: draft.mine,
      pendingConflict: draft,
    };
    data.eventCache = { timeMin, timeMax, syncToken: "expired", events: [old] };
    const changes = vi.fn(async () => ({
      events: [fresh],
      syncToken: "reset-token",
      reset: true,
    }));
    const api = {
      changes,
      list: vi.fn(),
      get: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      remove: vi.fn(),
    } as unknown as CalendarApi;
    const note = notes();
    note.canSync = vi.fn(async () => false);
    await run(data, api, note);
    expect(data.eventCache?.events.map((item) => item.id)).toEqual(["fresh"]);
    expect(data.records.keep?.pendingConflict).toEqual(draft);
    expect(api.create).not.toHaveBeenCalled();
  });

  test("out-of-window incremental events are not imported or linked", async () => {
    const data = state();
    const changes = vi.fn(async () => ({
      events: [event("later", "2026-12-14T09:00:00.000Z")],
      syncToken: "next",
      reset: false,
    }));
    const api = {
      changes,
      link: vi.fn(),
      list: vi.fn(),
      get: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      remove: vi.fn(),
    } as unknown as CalendarApi;
    const note = notes();
    await run(data, api, note);
    expect(note.write).not.toHaveBeenCalled();
    expect(api.link).not.toHaveBeenCalled();
    expect(data.records).toEqual({});
  });

  test("a reset does not discard an out-of-scope pending import", async () => {
    const data = state();
    const snapshot = { title: "Pending", start: timeMin, end: timeMax };
    data.pendingImport = { uid: "pending", eventId: "event", snapshot };
    data.eventCache = {
      timeMin,
      timeMax,
      syncToken: "expired",
      events: [event("old")],
    };
    const changes = vi.fn(async () => ({
      events: [event("fresh")],
      syncToken: "reset-token",
      reset: true,
    }));
    const api = {
      changes,
      list: vi.fn(),
      get: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      remove: vi.fn(),
    } as unknown as CalendarApi;
    const note = notes();
    note.canSync = vi.fn(async () => false);
    await expect(run(data, api, note)).rejects.toThrow(
      "pending import is outside sync scope",
    );
    expect(data.pendingImport).toEqual({
      uid: "pending",
      eventId: "event",
      snapshot,
    });
    expect(data.eventCache?.events.map((item) => item.id)).toEqual(["fresh"]);
  });

  test("failed local import write retains its journal and resumes from cached event", async () => {
    const data = state(),
      remote = event("remote");
    const changes = vi
      .fn()
      .mockResolvedValueOnce({
        events: [remote],
        syncToken: "one",
        reset: false,
      })
      .mockResolvedValueOnce({ events: [], syncToken: "two", reset: false });
    let linked: GoogleEvent | null = null;
    const api = {
      changes,
      link: vi.fn(
        async (item: GoogleEvent, uid: string) =>
          (linked = {
            ...item,
            extendedProperties: {
              private: {
                dayPlannerVault: data.namespace,
                dayPlannerBlock: uid,
              },
            },
          }),
      ),
      list: vi.fn(),
      get: vi.fn(async () => linked),
      create: vi.fn(),
      update: vi.fn(async (item) => item),
      remove: vi.fn(),
    } as unknown as CalendarApi;
    const note = notes();
    vi.mocked(note.write).mockRejectedValueOnce(new Error("write interrupted"));
    expect((await run(data, api, note)).conflicts).toHaveLength(1);
    expect(data.pendingImport?.eventId).toBe("remote");
    await run(data, api, note);
    expect(data.pendingImport).toBeUndefined();
    expect(Object.values(data.records)).toHaveLength(1);
    expect(note.write).toHaveBeenCalledTimes(2);
  });

  test("pending import recovery retains a note edit made after the original write", async () => {
    const data = state(),
      uid = await importUid(data.namespace, "remote");
    const original = {
      title: "Event",
      start: "2026-11-14T09:00:00.000Z",
      end: "2026-11-14T10:00:00.000Z",
      tags: [],
      subtasks: "",
      description: "",
      colorId: null,
    };
    const mine = { ...original, title: "Edited locally" };
    const local = {
      uid,
      path: "Daily.md",
      raw: renderBlock(uid, mine, defaultSettingsForTests),
      snapshot: mine,
    };
    const remote = {
      ...event("remote"),
      extendedProperties: {
        private: { dayPlannerVault: data.namespace, dayPlannerBlock: uid },
      },
    };
    data.pendingImport = { uid, eventId: "remote", snapshot: original };
    const changes = vi.fn(async () => ({
      events: [remote],
      syncToken: "next",
      reset: false,
    }));
    const update = vi.fn(
      async (item: GoogleEvent, snapshot: CalendarSnapshot) => ({
        ...item,
        summary: snapshot.title,
      }),
    );
    const api = {
      changes,
      update,
      list: vi.fn(),
      get: vi.fn(async () => remote),
      create: vi.fn(),
      remove: vi.fn(),
    } as unknown as CalendarApi;
    const note = notes();
    vi.mocked(note.scan).mockResolvedValue([local]);
    await run(data, api, note);
    expect(note.write).not.toHaveBeenCalled();
    expect(update.mock.calls[0]?.[1].title).toBe("Edited locally");
  });

  test("failed first export cache write retains the pre-create merge baseline", async () => {
    const data = state(),
      uid = "b".repeat(32);
    const original = {
      title: "Event",
      start: "2026-11-14T09:00:00.000Z",
      end: "2026-11-14T10:00:00.000Z",
      tags: [],
      subtasks: "",
      description: "",
      colorId: null,
    };
    let local: LocalBlock = {
      uid,
      path: "Daily.md",
      raw: renderBlock(uid, original, defaultSettingsForTests),
      snapshot: original,
    };
    let created: GoogleEvent | null = null;
    const changes = vi.fn(async () => ({
      events: [],
      syncToken: "next",
      reset: false,
    }));
    const api = {
      changes,
      list: vi.fn(),
      get: vi.fn(async () => created),
      create: vi.fn(
        async (id: string) =>
          (created = {
            ...event(id),
            summary: "Google normalized",
            extendedProperties: {
              private: {
                dayPlannerVault: data.namespace,
                dayPlannerBlock: uid,
              },
            },
          }),
      ),
      update: vi.fn(async (item: GoogleEvent) => item),
      remove: vi.fn(),
    } as unknown as CalendarApi;
    const note = notes();
    vi.mocked(note.scan).mockImplementation(async () => [local]);
    vi.mocked(note.write)
      .mockRejectedValueOnce(new Error("write interrupted"))
      .mockImplementation(
        async (_uid, snapshot) =>
          (local = {
            ...local,
            raw: renderBlock(uid, snapshot, defaultSettingsForTests),
            snapshot,
          }),
      );
    await expect(run(data, api, note, false)).rejects.toThrow(
      "write interrupted",
    );
    expect(data.pendingCreate?.snapshot.title).toBe("Event");
    expect(data.records[uid]).toBeUndefined();
    await run(data, api, note, false);
    expect(data.records[uid]?.base.title).toBe("Google normalized");
    expect(local.raw).toContain("Google normalized");
    expect(api.create).toHaveBeenCalledOnce();
  });
});
