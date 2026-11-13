import { describe, expect, test, vi } from "vitest";

import {
  resolveCalendarConflict,
  resolveMissingLocalConflict,
  syncCalendar,
  type CalendarConflict,
  type MissingLocalConflict,
} from "../src/google-calendar/engine";
import type {
  CalendarApi,
  CalendarNotes,
  CalendarSyncState,
} from "../src/google-calendar/types";

const uid = "a".repeat(32),
  namespace = "b".repeat(32);
const base = {
  title: "Original",
  start: "2030-01-01T09:00:00.000Z",
  end: "2030-01-01T10:00:00.000Z",
};
const local = {
  uid,
  path: "Daily/2030-01-01.md",
  raw: "09:00 Note",
  snapshot: { ...base, title: "Note" },
};
const remoteSnapshot = { ...base, title: "Google" };
const remote = {
  id: `dp${namespace}${uid}`,
  etag: "v1",
  summary: remoteSnapshot.title,
  start: { dateTime: base.start },
  end: { dateTime: base.end },
  extendedProperties: {
    private: { dayPlannerVault: namespace, dayPlannerBlock: uid },
  },
};
const conflict: CalendarConflict = { uid, local, remote, remoteSnapshot, base };

function setup() {
  const state: CalendarSyncState = {
    version: 2,
    namespace,
    calendarId: "calendar",
    records: {
      [uid]: { eventId: remote.id, path: local.path, base: { ...base } },
    },
  };
  const api = {
    get: vi.fn(async () => remote),
    update: vi.fn(async (_event, snapshot) => ({
      ...remote,
      summary: snapshot.title,
    })),
  } as unknown as CalendarApi;
  const notes = {
    scan: vi.fn(async () => [local]),
    isUnchanged: vi.fn(async () => true),
    write: vi.fn(async (_uid, snapshot) => ({ ...local, snapshot })),
  } as unknown as CalendarNotes;
  const save = vi.fn(async () => {});
  return { state, api, notes, save };
}

describe("calendar conflict resolution", () => {
  test.each(["note", "google"] as const)(
    "keeps %s and advances only the confirmed baseline",
    async (choice) => {
      const h = setup();
      await resolveCalendarConflict(
        conflict,
        choice,
        h.state,
        h.api,
        h.notes,
        h.save,
      );
      expect(h.state.records[uid]?.base).toEqual(
        choice === "note" ? local.snapshot : remoteSnapshot,
      );
      expect(h.save).toHaveBeenCalledOnce();
      expect(h.api.update).toHaveBeenCalledTimes(choice === "note" ? 1 : 0);
      expect(h.notes.write).toHaveBeenCalledTimes(choice === "google" ? 1 : 0);
    },
  );
  test("rejects changed note or Google etag without advancing baseline", async () => {
    const h = setup();
    vi.mocked(h.notes.isUnchanged).mockResolvedValueOnce(false);
    await expect(
      resolveCalendarConflict(
        conflict,
        "google",
        h.state,
        h.api,
        h.notes,
        h.save,
      ),
    ).rejects.toThrow("note changed");
    vi.mocked(h.api.get).mockResolvedValueOnce({ ...remote, etag: "v2" });
    await expect(
      resolveCalendarConflict(
        conflict,
        "note",
        h.state,
        h.api,
        h.notes,
        h.save,
      ),
    ).rejects.toThrow("Google changed");
    expect(h.state.records[uid]?.base).toEqual(base);
    expect(h.save).not.toHaveBeenCalled();
    expect(h.api.update).not.toHaveBeenCalled();
    expect(h.notes.write).not.toHaveBeenCalled();
  });
  test("does not overwrite an event without confirmed ownership", async () => {
    const h = setup();
    vi.mocked(h.api.get).mockResolvedValueOnce({
      ...remote,
      extendedProperties: {},
    });
    await expect(
      resolveCalendarConflict(
        conflict,
        "note",
        h.state,
        h.api,
        h.notes,
        h.save,
      ),
    ).rejects.toThrow("ownership");
    expect(h.api.update).not.toHaveBeenCalled();
    expect(h.save).not.toHaveBeenCalled();
  });
});

describe("missing note conflict resolution", () => {
  const missing: MissingLocalConflict = {
    uid,
    path: local.path,
    remote,
    remoteSnapshot,
    base,
  };
  function missingSetup() {
    const h = setup();
    vi.mocked(h.notes.scan).mockResolvedValue([]);
    h.api.remove = vi.fn(async () => {});
    h.api.list = vi.fn(async () => [remote]);
    h.notes.canDelete = vi.fn(async () => false);
    return h;
  }
  test("exposes an owned missing conflict without deleting it automatically", async () => {
    const h = missingSetup();
    const result = await syncCalendar({
      ...h,
      timeMin: "2029-12-31T00:00:00.000Z",
      timeMax: "2030-01-03T00:00:00.000Z",
      importEvents: false,
    });
    expect(result.missingLocal).toEqual([missing]);
    expect(h.api.remove).not.toHaveBeenCalled();
  });
  test("restores the current event to a note and advances the baseline", async () => {
    const h = missingSetup();
    h.state.identities = {
      [uid]: {
        path: local.path,
        from: 0,
        raw: "- [ ] Old\n  - [ ] Child",
        snapshot: base,
      },
    };
    await resolveMissingLocalConflict(
      missing,
      "restore",
      h.state,
      h.api,
      h.notes,
      h.save,
    );
    expect(h.notes.write).toHaveBeenCalledExactlyOnceWith(
      uid,
      remoteSnapshot,
      undefined,
      "- [ ] Old\n  - [ ] Child",
    );
    expect(h.state.records[uid]?.base).toEqual(remoteSnapshot);
    expect(h.api.remove).not.toHaveBeenCalled();
  });
  test("journals explicit removal before deleting and records the tombstone", async () => {
    const h = missingSetup();
    vi.mocked(h.api.remove).mockImplementation(async () =>
      expect(h.state.records[uid]?.pendingDelete).toBe(true),
    );
    await resolveMissingLocalConflict(
      missing,
      "remove",
      h.state,
      h.api,
      h.notes,
      h.save,
    );
    expect(h.api.remove).toHaveBeenCalledExactlyOnceWith(remote);
    expect(h.state.records[uid]).toMatchObject({ deleted: true });
    expect(h.state.records[uid]?.pendingDelete).toBeUndefined();
    expect(h.save).toHaveBeenCalledTimes(2);
  });
  test("rejects reappeared notes, changed events and foreign ownership", async () => {
    const h = missingSetup();
    vi.mocked(h.notes.scan).mockResolvedValueOnce([local]);
    await expect(
      resolveMissingLocalConflict(
        missing,
        "remove",
        h.state,
        h.api,
        h.notes,
        h.save,
      ),
    ).rejects.toThrow("returned");
    vi.mocked(h.api.get).mockResolvedValueOnce({ ...remote, etag: "v2" });
    await expect(
      resolveMissingLocalConflict(
        missing,
        "remove",
        h.state,
        h.api,
        h.notes,
        h.save,
      ),
    ).rejects.toThrow("Google changed");
    vi.mocked(h.api.get).mockResolvedValueOnce({
      ...remote,
      extendedProperties: {},
    });
    await expect(
      resolveMissingLocalConflict(
        missing,
        "restore",
        h.state,
        h.api,
        h.notes,
        h.save,
      ),
    ).rejects.toThrow("ownership");
    expect(h.api.remove).not.toHaveBeenCalled();
    expect(h.notes.write).not.toHaveBeenCalled();
    expect(h.save).not.toHaveBeenCalled();
  });
  test("keeps the delete journal when the provider response is lost", async () => {
    const h = missingSetup();
    vi.mocked(h.api.remove).mockRejectedValueOnce(
      new Error("Network interrupted"),
    );
    await expect(
      resolveMissingLocalConflict(
        missing,
        "remove",
        h.state,
        h.api,
        h.notes,
        h.save,
      ),
    ).rejects.toThrow("Network interrupted");
    expect(h.state.records[uid]?.pendingDelete).toBe(true);
    expect(h.state.records[uid]?.deleted).not.toBe(true);
  });
});
