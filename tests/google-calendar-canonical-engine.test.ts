import { webcrypto } from "node:crypto";
import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  resolveCalendarConflict,
  syncCalendar,
} from "../src/google-calendar/engine";
import {
  normalizeLocalSnapshot,
  renderBlock,
} from "../src/google-calendar/markdown";
import { structuredDescription } from "../src/google-calendar/subtasks";
import type {
  CalendarApi,
  CalendarNotes,
  CalendarSnapshot,
  CalendarSyncState,
  GoogleEvent,
  LocalBlock,
} from "../src/google-calendar/types";
import { defaultSettingsForTests } from "../src/settings";

beforeEach(() => vi.stubGlobal("crypto", webcrypto));
const namespace = "b".repeat(32),
  uid = "a".repeat(32),
  path = "Daily/2026-11-14.md";
const start = window.moment("2026-11-14 09:00").toISOString(),
  end = window.moment("2026-11-14 10:00").toISOString();
const base: CalendarSnapshot = {
  title: "Original",
  start,
  end,
  tags: ["work"],
  subtasks: "- [ ] Child",
  description: "",
  colorId: "1",
};
const id = `dp${namespace}${uid}`;
function event(snapshot: CalendarSnapshot, etag = "v1"): GoogleEvent {
  return {
    id,
    etag,
    summary: snapshot.title,
    start: { dateTime: snapshot.start },
    end: { dateTime: snapshot.end },
    colorId: snapshot.colorId ?? undefined,
    description: structuredDescription(
      snapshot.description ?? "",
      snapshot.tags ?? [],
      snapshot.subtasks ?? "",
    ),
    extendedProperties: {
      private: { dayPlannerVault: namespace, dayPlannerBlock: uid },
    },
  };
}
function block(snapshot: CalendarSnapshot): LocalBlock {
  const raw = renderBlock(uid, snapshot, defaultSettingsForTests);
  return {
    uid,
    path,
    raw,
    snapshot: {
      title: snapshot.title,
      start: snapshot.start,
      end: snapshot.end,
    },
    from: 0,
  };
}
function harness(local = block(base), remote = event(base)) {
  let current = local,
    currentEvent = remote;
  const state: CalendarSyncState = {
    version: 2,
    namespace,
    calendarId: "managed",
    records: { [uid]: { eventId: id, path, base: structuredClone(base) } },
  };
  const api: CalendarApi = {
    list: vi.fn(async () => [currentEvent]),
    get: vi.fn(async () => currentEvent),
    create: vi.fn(async (_id, _uid, value) => event(value)),
    update: vi.fn(async (_event, value) => {
      currentEvent = event(value, "updated");
      return currentEvent;
    }),
    remove: vi.fn(async () => {}),
  };
  const notes: CalendarNotes = {
    scan: vi.fn(async () => [current]),
    canSync: vi.fn(async () => true),
    isUnchanged: vi.fn(async () => true),
    canDelete: vi.fn(async () => false),
    write: vi.fn(async (_uid, value, previous) => {
      current = {
        ...block(value),
        raw: renderBlock(uid, value, defaultSettingsForTests, previous?.raw),
      };
      return current;
    }),
    cancel: vi.fn(async () => {}),
  };
  const save = vi.fn(async () => {});
  const run = () =>
    syncCalendar({
      state,
      api,
      notes,
      save,
      timeMin: window.moment("2026-11-13").toISOString(),
      timeMax: window.moment("2026-11-20").toISOString(),
      importEvents: true,
      canonical: true,
    });
  return {
    state,
    api,
    notes,
    save,
    run,
    current: () => current,
    remote: () => currentEvent,
    setRemote: (value: GoogleEvent) => {
      currentEvent = value;
    },
  };
}

describe("canonical calendar engine", () => {
  test("merges disjoint note title and Google child/color edits", async () => {
    const h = harness(
      block({ ...base, title: "Mine" }),
      event({ ...base, subtasks: "- [x] Google child", colorId: "2" }),
    );
    const result = await h.run();
    expect(result.conflicts).toEqual([]);
    expect(h.api.update).toHaveBeenCalledOnce();
    expect(h.state.records[uid]?.base).toMatchObject({
      title: "Mine",
      subtasks: "- [x] Google child",
      colorId: "2",
    });
    expect(normalizeLocalSnapshot(h.current())).toMatchObject({
      title: "Mine",
      subtasks: "- [x] Google child",
    });
  });
  test("Google child and color edits are cached without being pushed back", async () => {
    const h = harness(
      block(base),
      event({ ...base, subtasks: "- [x] New child", colorId: "2" }),
    );
    const result = await h.run();
    expect(result.conflicts).toEqual([]);
    expect(h.api.update).toHaveBeenCalledOnce();
    expect(vi.mocked(h.api.update).mock.calls[0]?.[1]).toMatchObject({
      subtasks: "- [x] New child",
      colorId: "2",
    });
    expect(normalizeLocalSnapshot(h.current()).subtasks).toBe(
      "- [x] New child",
    );
    expect(h.state.records[uid]?.base.colorId).toBe("2");
  });
  test("Google rename retains the existing event identity across syncs", async () => {
    const h = harness(
      block(base),
      event({ ...base, title: "Renamed in Google" }),
    );
    expect((await h.run()).conflicts).toEqual([]);
    expect(h.state.records[uid]?.eventId).toBe(id);
    expect(normalizeLocalSnapshot(h.current()).title).toBe("Renamed in Google");
    await h.run();
    expect(h.state.records[uid]?.eventId).toBe(id);
    expect(h.api.create).not.toHaveBeenCalled();
    expect(h.api.update).toHaveBeenCalledTimes(2);
  });
  test("competing edits cache Google, persist mine and survive another sync", async () => {
    const h = harness(
      block({ ...base, title: "Mine" }),
      event({ ...base, title: "Theirs" }),
    );
    const first = await h.run();
    expect(first.reviewable).toHaveLength(1);
    expect(h.state.records[uid]?.pendingConflict?.mine.title).toBe("Mine");
    expect(normalizeLocalSnapshot(h.current()).title).toBe("Theirs");
    const saved = JSON.parse(JSON.stringify(h.state)) as CalendarSyncState;
    Object.assign(h.state, saved);
    const again = await h.run();
    expect(again.reviewable[0]?.mine?.title).toBe("Mine");
    expect(h.state.records[uid]?.pendingConflict?.mine.title).toBe("Mine");
  });
  test("an interrupted cache write retains the saved local draft on retry", async () => {
    const h = harness(
      block({ ...base, title: "Mine" }),
      event({ ...base, title: "Theirs" }),
    );
    const write = vi.mocked(h.notes.write).getMockImplementation()!;
    vi.mocked(h.notes.write).mockImplementationOnce(async (...args) => {
      const result = await write(...args);
      throw new Error(`interrupted after writing ${result.uid}`);
    });
    const interrupted = await h.run();
    expect(interrupted.conflicts).toHaveLength(1);
    expect(h.state.records[uid]?.base.title).toBe("Original");
    expect(normalizeLocalSnapshot(h.current()).title).toBe("Theirs");
    const retry = await h.run();
    expect(retry.reviewable[0]?.mine?.title).toBe("Mine");
    expect(h.state.records[uid]?.pendingConflict?.mine.title).toBe("Mine");
  });
  test.each(["note", "google"] as const)(
    "explicit %s selection uses the saved draft with scope and ETag checks",
    async (choice) => {
      const h = harness(
        block({ ...base, title: "Mine" }),
        event({ ...base, title: "Theirs" }),
      );
      const result = await h.run(),
        review = result.reviewable[0]!;
      await resolveCalendarConflict(
        review,
        choice,
        h.state,
        h.api,
        h.notes,
        h.save,
      );
      expect(h.state.records[uid]?.base.title).toBe(
        choice === "note" ? "Mine" : "Theirs",
      );
      expect(h.state.records[uid]?.pendingConflict).toBeUndefined();
    },
  );
  test("rejects a stale ETag or opted-out note before applying a decision", async () => {
    const h = harness(
      block({ ...base, title: "Mine" }),
      event({ ...base, title: "Theirs" }),
    );
    const review = (await h.run()).reviewable[0]!;
    h.setRemote({ ...h.remote(), etag: "changed" });
    vi.mocked(h.api.update).mockClear();
    await expect(
      resolveCalendarConflict(review, "note", h.state, h.api, h.notes, h.save),
    ).rejects.toThrow("Google changed");
    vi.mocked(h.notes.canSync!).mockResolvedValue(false);
    await expect(
      resolveCalendarConflict(
        review,
        "google",
        h.state,
        h.api,
        h.notes,
        h.save,
      ),
    ).rejects.toThrow("scope");
  });
  test("rejects a review when only the canonical baseline metadata changed", async () => {
    const h = harness(
      block({ ...base, title: "Mine" }),
      event({ ...base, title: "Theirs" }),
    );
    const review = (await h.run()).reviewable[0]!;
    vi.mocked(h.api.update).mockClear();
    h.state.records[uid]!.base = {
      ...h.state.records[uid]!.base,
      tags: ["changed"],
    };
    await expect(
      resolveCalendarConflict(review, "note", h.state, h.api, h.notes, h.save),
    ).rejects.toThrow("conflict changed");
    expect(h.api.update).not.toHaveBeenCalled();
  });
  test("scope excludes record reads and new creations/imports", async () => {
    const h = harness();
    vi.mocked(h.notes.canSync!).mockResolvedValue(false);
    const original = JSON.stringify(h.state);
    await h.run();
    expect(h.api.get).not.toHaveBeenCalled();
    expect(h.api.update).not.toHaveBeenCalled();
    expect(h.api.create).not.toHaveBeenCalled();
    expect(h.api.remove).not.toHaveBeenCalled();
    expect(h.notes.write).not.toHaveBeenCalled();
    expect(JSON.stringify(h.state)).toBe(original);
  });
  test("an archived record stays excluded even if its Google event moved after cutoff", async () => {
    const old = {
      ...base,
      start: window.moment("2026-11-13 09:00").toISOString(),
      end: window.moment("2026-11-13 10:00").toISOString(),
    };
    const h = harness(block(old), event(base));
    h.state.records[uid]!.base = old;
    vi.mocked(h.notes.canSync!).mockImplementation(
      async (_path, snapshot) =>
        window.moment(snapshot.start).format("YYYY-MM-DD") >= "2026-11-14",
    );
    await h.run();
    expect(h.api.get).not.toHaveBeenCalled();
    expect(h.api.update).not.toHaveBeenCalled();
    expect(h.api.remove).not.toHaveBeenCalled();
    expect(h.notes.write).not.toHaveBeenCalled();
    expect(h.state.records[uid]?.base).toEqual(old);
  });
  test("reuses deterministic event identity after a create response is lost", async () => {
    const h = harness();
    h.state.records = {};
    vi.mocked(h.api.list).mockResolvedValue([]);
    vi.mocked(h.api.get)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(event(base));
    vi.mocked(h.api.create).mockRejectedValueOnce(new Error("response lost"));
    await expect(h.run()).rejects.toThrow("response lost");
    expect(h.state.pendingCreate?.uid).toBe(uid);
    await h.run();
    expect(h.state.records[uid]?.eventId).toBe(id);
    expect(h.api.create).toHaveBeenCalledOnce();
  });
});
