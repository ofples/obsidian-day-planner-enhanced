import { webcrypto } from "node:crypto";
import { beforeEach, describe, expect, test, vi } from "vitest";

import {
  recoverCalendarProjection,
  syncCalendar,
} from "../src/google-calendar/engine";
import {
  addMarker,
  appendToPlanner,
  parseBlocks,
  renderBlock,
} from "../src/google-calendar/markdown";
import {
  snapshotOf,
  sameSnapshot,
  type CalendarApi,
  type CalendarNotes,
  type CalendarSnapshot,
  type CalendarSyncState,
  type GoogleEvent,
  type LocalBlock,
} from "../src/google-calendar/types";
import { configureTimestampRegExps } from "../src/regexp";
import { defaultSettings, mergeStoredSettings } from "../src/settings";

const uid = "a".repeat(32);
const base: CalendarSnapshot = {
  title: "Deep work #work",
  start: "2026-11-11T04:30:00.000Z",
  end: "2026-11-11T05:30:00.000Z",
};
const other = { ...base, title: "Changed title #work" };
const event = (snapshot = base): GoogleEvent => ({
  id: "event1",
  etag: '"v1"',
  summary: snapshot.title,
  start: { dateTime: snapshot.start },
  end: { dateTime: snapshot.end },
});
const local = (snapshot = base): LocalBlock => ({
  uid,
  path: "Daily/2026-11-11.md",
  raw: "original task and children",
  snapshot,
});

function harness(linked = true) {
  const state: CalendarSyncState = {
    version: 1,
    namespace: "b".repeat(32),
    calendarId: "test",
    records: linked
      ? { [uid]: { eventId: "event1", path: local().path, base: { ...base } } }
      : {},
  };
  let blocks = [local()];
  let events = linked ? [event()] : [];
  const api: CalendarApi = {
    list: vi.fn(async () => events),
    get: vi.fn(async (id) => events.find((item) => item.id === id) ?? null),
    create: vi.fn(async (id, _uid, snapshot) => ({ ...event(snapshot), id })),
    update: vi.fn(async (_event, snapshot) => event(snapshot)),
    remove: vi.fn(async () => {}),
  };
  const notes: CalendarNotes = {
    scan: vi.fn(async () => blocks),
    isUnchanged: vi.fn(async () => true),
    canDelete: vi.fn(async () => true),
    write: vi.fn(async (newUid, snapshot) => ({
      ...local(snapshot),
      uid: newUid,
    })),
    cancel: vi.fn(async () => {}),
  };
  const save = vi.fn(async () => {});
  return {
    state,
    api,
    notes,
    save,
    setBlocks: (value: LocalBlock[]) => {
      blocks = value;
    },
    setEvents: (value: GoogleEvent[]) => {
      events = value;
    },
    run: (importEvents = true) =>
      syncCalendar({
        state,
        api,
        notes,
        save,
        timeMin: "2026-11-01T00:00:00.000Z",
        timeMax: "2026-12-01T00:00:00.000Z",
        importEvents,
      }),
  };
}

beforeEach(() => {
  vi.stubGlobal("crypto", webcrypto);
  configureTimestampRegExps("HH:mm");
});

describe("calendar reconciliation", () => {
  test("projection verification compares equivalent ISO timestamp representations", () => {
    expect(
      sameSnapshot(base, {
        ...base,
        start: "2026-11-11T10:00:00+05:30",
        end: "2026-11-11T05:30:00Z",
      }),
    ).toBe(true);
    expect(sameSnapshot(base, { ...base, start: "invalid" })).toBe(false);
    expect(sameSnapshot(base, { ...base, end: "2026-11-11T06:30:00Z" })).toBe(
      false,
    );
  });

  test("an uncertain owned create recovers its intended baseline while retaining a later Google edit", async () => {
    const h = harness(false);
    h.setBlocks([local({ ...base, title: "Latest note" })]);
    const id = `dp${h.state.namespace}${uid}`;
    h.setEvents([
      {
        ...event(other),
        id,
        extendedProperties: { private: { dayPlannerVault: h.state.namespace } },
      },
    ]);
    await recoverCalendarProjection({
      ...h,
      uid,
      path: local().path,
      snapshot: base,
    });
    expect(h.state.records[uid]?.base).toEqual(base);
    expect((await h.run(false)).conflicts).toHaveLength(1);
    expect(h.api.update).not.toHaveBeenCalled();
    expect(h.api.create).not.toHaveBeenCalled();
    expect(h.notes.write).not.toHaveBeenCalled();
  });

  test("an unknown deterministic ID cannot adopt another vault's event", async () => {
    const h = harness(false);
    h.setEvents([
      {
        ...event(),
        id: `dp${h.state.namespace}${uid}`,
        extendedProperties: { private: { dayPlannerVault: "other" } },
      },
    ]);
    await expect(
      recoverCalendarProjection({
        ...h,
        uid,
        path: local().path,
        snapshot: base,
      }),
    ).rejects.toThrow("ownership");
    expect(h.state.records).toEqual({});
    expect(h.save).not.toHaveBeenCalled();
  });

  test("an older predecessor cannot overwrite a newer acknowledged calendar baseline", async () => {
    const h = harness();
    const newer = { ...base, title: "Newer acknowledged title" };
    h.state.records[uid]!.base = newer;
    // Google was subsequently edited back to the original title.
    await recoverCalendarProjection({
      ...h,
      uid,
      path: local().path,
      snapshot: base,
    });
    expect(h.state.records[uid]?.base).toEqual(newer);
    h.setBlocks([local({ ...base, title: "Newest note" })]);
    expect((await h.run(false)).conflicts).toHaveLength(1);
    expect(h.api.update).not.toHaveBeenCalled();
  });

  test("subtask-only edits backfill descriptions using the latest color version without note writes", async () => {
    const h = harness();
    const block = { ...local(), raw: "- [ ] Work\n  - [x] Completed child" };
    const colored = { ...event(), etag: '"v2"', colorId: "3" };
    h.setBlocks([block]);
    h.api.syncColor = vi.fn(async () => colored);
    h.api.syncSubtasks = vi.fn(async (remote) => ({
      ...remote,
      description: "children",
    }));
    expect((await h.run()).pushed).toBe(2);
    expect(h.api.syncSubtasks).toHaveBeenCalledWith(colored, block);
    expect(h.api.update).not.toHaveBeenCalled();
    expect(h.notes.write).not.toHaveBeenCalled();
  });
  test("a remote title change sends the rewritten block to description sync", async () => {
    const h = harness();
    const rewritten = {
      ...local(other),
      raw: "- [ ] Changed title\n  - [ ] Child",
    };
    h.setEvents([event(other)]);
    vi.mocked(h.notes.write).mockResolvedValue(rewritten);
    h.api.syncSubtasks = vi.fn(async (remote) => remote);
    await h.run();
    expect(h.api.syncSubtasks).toHaveBeenCalledWith(event(other), rewritten);
  });
  test("skips description writes if the note changes during color sync", async () => {
    const h = harness();
    h.api.syncColor = vi.fn(async (remote) => {
      vi.mocked(h.notes.isUnchanged).mockResolvedValue(false);
      return remote;
    });
    h.api.syncSubtasks = vi.fn(async (remote) => remote);
    expect((await h.run()).conflicts).toHaveLength(1);
    expect(h.api.syncSubtasks).not.toHaveBeenCalled();
  });
  test("display-only events are not written as note tasks", async () => {
    const h = harness(false);
    h.setBlocks([]);
    h.setEvents([event()]);
    expect((await h.run(false)).pulled).toBe(0);
    expect(h.notes.write).not.toHaveBeenCalled();
    expect(h.state.records).toEqual({});
  });
  test("color-only changes backfill existing linked events without note writes", async () => {
    const h = harness();
    h.api.syncColor = vi.fn(async (remote) => ({ ...remote, colorId: "3" }));
    expect((await h.run()).pushed).toBe(1);
    expect(h.api.update).not.toHaveBeenCalled();
    expect(h.notes.write).not.toHaveBeenCalled();
    expect(h.state.records[uid]?.base).toEqual(base);
  });
  test("unchanged entries produce no writes", async () => {
    const h = harness();
    expect(await h.run()).toMatchObject({
      pushed: 0,
      pulled: 0,
      conflicts: [],
    });
    expect(h.api.update).not.toHaveBeenCalled();
    expect(h.notes.write).not.toHaveBeenCalled();
  });
  test("a local edit patches Google", async () => {
    const h = harness();
    h.setBlocks([local(other)]);
    expect((await h.run()).pushed).toBe(1);
    expect(h.api.update).toHaveBeenCalledWith(event(), other);
    expect(h.state.records[uid]?.base).toEqual(other);
  });
  test("a Google edit updates the existing Markdown block", async () => {
    const h = harness();
    h.setEvents([event(other)]);
    expect((await h.run()).pulled).toBe(1);
    expect(h.notes.write).toHaveBeenCalledWith(uid, other, local());
  });
  test("different concurrent edits preserve both versions and the old baseline", async () => {
    const h = harness();
    h.setBlocks([local(other)]);
    h.setEvents([event({ ...base, title: "Remote edit" })]);
    expect((await h.run()).conflicts).toHaveLength(1);
    expect(h.api.update).not.toHaveBeenCalled();
    expect(h.notes.write).not.toHaveBeenCalled();
    expect(h.state.records[uid]?.base).toEqual(base);
  });
  test("identical concurrent edits resolve without overwriting", async () => {
    const h = harness();
    h.setBlocks([local(other)]);
    h.setEvents([event(other)]);
    expect((await h.run()).conflicts).toEqual([]);
    expect(h.api.update).not.toHaveBeenCalled();
    expect(h.notes.write).not.toHaveBeenCalled();
    expect(h.state.records[uid]?.base).toEqual(other);
  });
  test("a local block removal deletes its unchanged event", async () => {
    const h = harness();
    h.setBlocks([]);
    expect((await h.run()).deleted).toBe(1);
    expect(h.api.remove).toHaveBeenCalledWith(event());
    expect(h.state.records[uid]?.deleted).toBe(true);
  });
  test("missing files and ambiguous removals never delete Google events", async () => {
    const h = harness();
    h.setBlocks([]);
    vi.mocked(h.notes.canDelete).mockResolvedValue(false);
    expect((await h.run()).conflicts).toHaveLength(1);
    expect(h.api.remove).not.toHaveBeenCalled();
  });
  test("remote edits conflict with a local removal", async () => {
    const h = harness();
    h.setBlocks([]);
    h.setEvents([event(other)]);
    expect((await h.run()).conflicts).toHaveLength(1);
    expect(h.api.remove).not.toHaveBeenCalled();
  });
  test("Google cancellation preserves the local subtree through the cancellation writer", async () => {
    const h = harness();
    h.setEvents([{ ...event(), status: "cancelled" }]);
    expect((await h.run()).deleted).toBe(1);
    expect(h.notes.cancel).toHaveBeenCalledWith(local());
  });
  test("Google cancellation conflicts with a local edit", async () => {
    const h = harness();
    h.setBlocks([local(other)]);
    h.setEvents([{ ...event(), status: "cancelled" }]);
    expect((await h.run()).conflicts).toHaveLength(1);
    expect(h.notes.cancel).not.toHaveBeenCalled();
  });
  test("an event moved outside the list window is retrieved by ID", async () => {
    const h = harness();
    h.setEvents([]);
    vi.mocked(h.api.get).mockResolvedValue(event(other));
    expect((await h.run()).pulled).toBe(1);
    expect(h.notes.cancel).not.toHaveBeenCalled();
  });
  test("a note edited after the scan is skipped", async () => {
    const h = harness();
    h.setEvents([event(other)]);
    vi.mocked(h.notes.isUnchanged).mockResolvedValue(false);
    expect((await h.run()).conflicts).toHaveLength(1);
    expect(h.notes.write).not.toHaveBeenCalled();
  });
  test("duplicate copied IDs stop before remote writes", async () => {
    const h = harness();
    h.setBlocks([local(), { ...local(), path: "Daily/another.md" }]);
    await expect(h.run()).rejects.toThrow("Duplicate");
    expect(h.api.list).not.toHaveBeenCalled();
  });
  test("new local events use retry-safe deterministic IDs", async () => {
    const h = harness(false);
    await h.run();
    expect(h.api.create).toHaveBeenCalledWith(
      `dp${h.state.namespace}${uid}`,
      uid,
      base,
      local(),
    );
  });
  test("a successful POST followed by a crash is adopted rather than duplicated", async () => {
    const h = harness(false);
    h.setEvents([{ ...event(), id: `dp${h.state.namespace}${uid}` }]);
    await h.run();
    expect(h.api.create).not.toHaveBeenCalled();
    expect(h.state.records[uid]?.eventId).toBe(`dp${h.state.namespace}${uid}`);
  });
  test("no new exports are made outside the window", async () => {
    const h = harness(false);
    h.setBlocks([local({ ...base, start: "2026-10-01T00:00:00.000Z" })]);
    await h.run();
    expect(h.api.create).not.toHaveBeenCalled();
  });
  test("external timed events are imported once", async () => {
    const h = harness(false);
    h.setBlocks([]);
    h.setEvents([event()]);
    expect((await h.run()).pulled).toBe(1);
    expect(h.notes.write).toHaveBeenCalledTimes(1);
    const record = Object.values(h.state.records)[0];
    expect(record?.eventId).toBe("event1");
  });
  test("an import interrupted before mapping persistence is not exported as a duplicate", async () => {
    const h = harness(false);
    h.setBlocks([]);
    h.setEvents([event()]);
    await h.run();
    const importedUid = Object.keys(h.state.records)[0]!;
    const retry = harness(false);
    retry.setBlocks([{ ...local(), uid: importedUid }]);
    retry.setEvents([event()]);
    await retry.run();
    expect(retry.api.create).not.toHaveBeenCalled();
    expect(retry.notes.write).not.toHaveBeenCalled();
  });
  test("all-day, special, and >24 hour events are not imported", async () => {
    const h = harness(false);
    h.setBlocks([]);
    h.setEvents([
      {
        ...event(),
        id: "all",
        start: { date: "2026-11-11" },
        end: { date: "2026-11-12" },
      },
      { ...event(), id: "special", eventType: "workingLocation" },
      { ...event(), id: "long", end: { dateTime: "2026-11-13T05:30:00Z" } },
    ]);
    await h.run();
    expect(h.notes.write).not.toHaveBeenCalled();
  });
  test("failed Google writes never advance the baseline", async () => {
    const h = harness();
    h.setBlocks([local(other)]);
    vi.mocked(h.api.update).mockRejectedValue(new Error("412"));
    await expect(h.run()).rejects.toThrow("412");
    expect(h.state.records[uid]?.base).toEqual(base);
  });
  test("failed remote listings never trigger deletion", async () => {
    const h = harness();
    h.setBlocks([]);
    vi.mocked(h.api.list).mockRejectedValue(new Error("offline"));
    await expect(h.run()).rejects.toThrow("offline");
    expect(h.api.remove).not.toHaveBeenCalled();
  });
  test("an interrupted import is journaled before any note write", async () => {
    const h = harness(false);
    h.setBlocks([]);
    h.setEvents([event()]);
    vi.mocked(h.notes.write).mockImplementation(async () => {
      expect(h.save).toHaveBeenCalled();
      expect(h.state.pendingImport?.eventId).toBe("event1");
      throw new Error("Interrupted import");
    });
    await expect(h.run()).rejects.toThrow("Interrupted import");
    expect(h.state.pendingImport).toBeDefined();
    expect(h.state.records).toEqual({});
  });
  test("a pending import recovers after its event moves outside the discovery window", async () => {
    const h = harness(false);
    h.setBlocks([]);
    h.setEvents([]);
    h.state.pendingImport = { uid, eventId: "event1", snapshot: base };
    vi.mocked(h.api.get).mockResolvedValue(event(other));
    await h.run();
    expect(h.state.pendingImport).toBeUndefined();
    expect(h.state.records[uid]?.eventId).toBe("event1");
    expect(h.state.records[uid]?.base).toEqual(other);
    expect(h.api.create).not.toHaveBeenCalled();
  });
});

describe("planner Markdown preservation", () => {
  test("scopes to the planner heading and keeps children with their parent", () => {
    const text =
      "---\naliases: [Today]\n---\n# Day planner\n\n- [ ] 09:00 - 10:00 Parent #work ^anchor\n    - [ ] 09:15 - 09:30 Child\n    - Notes [[Other]]\n\n## Reflections\n- [ ] Untimed reflection\n# Other\n- [ ] 11:00 Other block\n";
    const blocks = parseBlocks(text, "2026-11-11", defaultSettings);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.snapshot.title).toBe("Parent #work");
    expect(blocks[0]?.raw).toContain("Child");
    expect(blocks[0]?.raw).toContain("[[Other]]");
    expect(text.slice(blocks[0]?.from, blocks[0]?.to)).toBe(blocks[0]?.raw);
  });
  test("rewriting a synced task retains checkbox, block ID and exact CRLF children", () => {
    const previous = `- [x] 09:00 - 10:00 Old <!-- dp-gcal:${uid} --> ^anchor\r\n    - [ ] Child [[Other]] ^child\r\n    - Note`;
    const rendered = renderBlock(uid, other, defaultSettings, previous);
    expect(rendered).toContain("- [x]");
    expect(rendered).toContain(
      "^anchor\r\n    - [ ] Child [[Other]] ^child\r\n    - Note",
    );
    expect(
      parseBlocks(
        `# Day planner\r\n${rendered}`,
        window.moment(other.start).format("YYYY-MM-DD"),
        defaultSettings,
      )[0]?.snapshot,
    ).toEqual(other);
  });
  test("adds hidden IDs before existing block IDs", () => {
    expect(addMarker("- [ ] 09:00 Work ^anchor", uid)).toBe(
      `- [ ] 09:00 Work <!-- dp-gcal:${uid} --> ^anchor`,
    );
  });
  test("overnight ranges retain their duration and original date", () => {
    const block = parseBlocks(
      "# Day planner\n- [ ] 23:00 - 00:30 Overnight",
      "2026-11-11",
      defaultSettings,
    )[0]!;
    expect(
      Date.parse(block.snapshot.end) - Date.parse(block.snapshot.start),
    ).toBe(90 * 60_000);
    expect(window.moment(block.snapshot.start).format("YYYY-MM-DD")).toBe(
      "2026-11-11",
    );
  });
  test("single-start lines use the configured default duration", () => {
    const block = parseBlocks(
      "# Day planner\n- [ ] 10:30 - Mop",
      "2026-11-11",
      defaultSettings,
    )[0]!;
    expect(block.snapshot.title).toBe("Mop");
    expect(
      Date.parse(block.snapshot.end) - Date.parse(block.snapshot.start),
    ).toBe(defaultSettings.defaultDurationMinutes * 60_000);
  });
  test("leading tags and alternative timestamp formats use the canonical parser", () => {
    configureTimestampRegExps("HHmm");
    const block = parseBlocks(
      "# Day planner\n- [ ] #work 0930 - 1030 Focus",
      "2026-11-11",
      { ...defaultSettings, timestampFormat: "HHmm" },
    )[0]!;
    expect(block.snapshot.title).toBe("#work Focus");
    expect(
      Date.parse(block.snapshot.end) - Date.parse(block.snapshot.start),
    ).toBe(60 * 60_000);
  });
  test("new imports stay in the planner section without altering unrelated content", () => {
    const text =
      "---\ntags: [daily]\n---\n# Day planner\n\n- [ ] 09:00 Existing\n\n# Journal\nKeep exactly this.\n";
    const result = appendToPlanner(
      text,
      "- [ ] 10:00 Imported",
      defaultSettings,
    );
    expect(result.startsWith("---\ntags: [daily]\n---\n# Day planner")).toBe(
      true,
    );
    expect(result.endsWith("# Journal\nKeep exactly this.\n")).toBe(true);
    expect(result.indexOf("Imported")).toBeLessThan(
      result.indexOf("# Journal"),
    );
  });
  test("cancelled entries and fenced examples are never re-exported", () => {
    const text = `# Day planner\n- [-] Cancelled in Google Calendar: 09:00 Old <!-- dp-gcal-cancelled:${uid} -->\n\n\x60\x60\x60md\n- [ ] 10:00 Example\n\x60\x60\x60\n`;
    expect(parseBlocks(text, "2026-11-11", defaultSettings)).toEqual([]);
  });
  test("existing installations get safe sync defaults", () => {
    expect(mergeStoredSettings(null).googleCalendar).toMatchObject({
      autoSync: false,
      syncDeletions: false,
      clientId: "",
      calendarId: "",
    });
  });
  test("Google timestamps with offsets are compared as instants", () => {
    expect(
      snapshotOf({
        ...event(),
        start: { dateTime: "2026-11-11T10:00:00+05:30" },
      }),
    ).toEqual(base);
  });
  test("sub-minute and invalid Google times are rejected rather than rounded", () => {
    expect(
      snapshotOf({ ...event(), start: { dateTime: "2026-11-11T04:30:30Z" } }),
    ).toBeNull();
    expect(snapshotOf({ ...event(), end: { dateTime: "invalid" } })).toBeNull();
  });
  test("Google titles normalize line breaks and cannot introduce tracking comments", () => {
    expect(
      snapshotOf({ ...event(), summary: "One\n  two <!-- hidden -->" })?.title,
    ).toBe("One two");
  });
});
