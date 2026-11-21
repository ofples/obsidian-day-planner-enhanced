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
import {
  structuredDescription,
  plainCalendarDescription,
} from "../src/google-calendar/subtasks";
import { CalendarSyncInterrupted } from "../src/google-calendar/types";
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
    isDocumentUnchanged: vi.fn(async () => true),
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
  const run = (noteAuthority?: string) =>
    syncCalendar({
      state,
      api,
      notes,
      save,
      timeMin: window.moment("2026-11-13").toISOString(),
      timeMax: window.moment("2026-11-20").toISOString(),
      importEvents: true,
      canonical: true,
      noteAuthority,
    });
  return {
    state,
    api,
    notes,
    save,
    run,
    current: () => current,
    setLocal: (value: LocalBlock) => {
      current = value;
    },
    remote: () => currentEvent,
    setRemote: (value: GoogleEvent) => {
      currentEvent = value;
    },
  };
}

describe("canonical calendar engine", () => {
  test("the sync window does not fetch or conflict on hundreds of historical records", async () => {
    const h = harness();
    for (let index = 0; index < 500; index++)
      h.state.records[`past-${index}`] = {
        eventId: `past-event-${index}`,
        path: "Daily/2026-11-10.md",
        base: {
          ...base,
          start: window.moment("2026-11-10 09:00").toISOString(),
          end: window.moment("2026-11-10 10:00").toISOString(),
        },
      };
    const result = await h.run();
    expect(result.conflicts).toEqual([]);
    expect(h.api.get).not.toHaveBeenCalled();
    expect(h.api.remove).not.toHaveBeenCalled();
    expect(Object.keys(h.state.records)).toHaveLength(501);
  });
  test("a linked Google event moved from an old day into the active window is still pulled", async () => {
    const past = {
      ...base,
      start: window.moment("2026-11-10 09:00").toISOString(),
      end: window.moment("2026-11-10 10:00").toISOString(),
    };
    const h = harness(block(past), event(base));
    h.state.records[uid]!.base = past;
    const result = await h.run();
    expect(result.conflicts).toEqual([]);
    expect(result.pulled).toBe(1);
    expect(h.state.records[uid]!.base.start).toBe(base.start);
    expect(h.api.create).not.toHaveBeenCalled();
    expect(h.api.get).not.toHaveBeenCalled();
  });
  test("a missing block from a changing document defers the pass instead of raising a deletion conflict", async () => {
    const h = harness();
    vi.mocked(h.notes.scan).mockResolvedValue([]);
    vi.mocked(h.notes.isDocumentUnchanged!).mockResolvedValue(false);
    await expect(h.run()).rejects.toBeInstanceOf(CalendarSyncInterrupted);
    expect(h.api.remove).not.toHaveBeenCalled();
    expect(h.state.records[uid]!.deleted).toBeUndefined();
  });
  test.each(["confirmed", "lost-response"] as const)(
    "%s uploads do not become competing Google edits when typing resumes",
    async (mode) => {
      const first = { ...base, title: "First edit" };
      const google = { ...base, subtasks: "- [x] Remote child" };
      const h = harness(block(first), event(google));
      let current = true;
      h.notes.assertCurrent = () => {
        if (!current) throw new CalendarSyncInterrupted();
      };
      const original = vi.mocked(h.api.update).getMockImplementation()!;
      vi.mocked(h.api.update).mockImplementationOnce(async (...args) => {
        const confirmed = await original(...args);
        if (mode === "lost-response")
          throw new Error("Response lost after PATCH");
        current = false;
        return confirmed;
      });
      if (mode === "confirmed")
        await expect(h.run()).rejects.toBeInstanceOf(CalendarSyncInterrupted);
      else expect((await h.run()).conflicts).toHaveLength(1);
      current = true;
      h.setLocal(block({ ...base, title: "Second edit" }));
      const result = await h.run();
      expect(result.conflicts).toEqual([]);
      expect(h.state.records[uid]!.base).toMatchObject({
        title: "Second edit",
        subtasks: google.subtasks,
      });
      expect(h.state.records[uid]!.pendingUpdate).toBeUndefined();
      expect(h.state.records[uid]!.pendingConflict).toBeUndefined();
    },
  );
  test("uncertain uploads still protect a genuinely newer competing Google edit", async () => {
    const h = harness(block({ ...base, title: "First edit" }));
    const original = vi.mocked(h.api.update).getMockImplementation()!;
    vi.mocked(h.api.update).mockImplementationOnce(async (...args) => {
      await original(...args);
      throw new Error("Response lost");
    });
    await h.run();
    h.setRemote(event({ ...base, title: "New Google edit" }, "new-version"));
    h.setLocal(block({ ...base, title: "Second local edit" }));
    const result = await h.run();
    expect(result.reviewable[0]!.fields).toContain("title");
    expect(h.state.records[uid]!.pendingConflict!.mine.title).toBe(
      "Second local edit",
    );
    expect(h.state.records[uid]!.base.title).toBe("New Google edit");
  });
  test("Calendar trimming an empty checkbox does not compete with a new local child", async () => {
    const previous = { ...base, subtasks: "- [ ]\n- [x] Already done" };
    const mine = {
      ...previous,
      subtasks: `${previous.subtasks}\n- [ ] Added locally`,
    };
    const remote = event(previous);
    remote.extendedProperties!.private!.dayPlannerTags = JSON.stringify(
      previous.tags,
    );
    remote.description = plainCalendarDescription("", previous.subtasks)
      .split("\n")
      .map((line) => line.trimEnd())
      .join("\n");
    const h = harness(block(mine), remote);
    h.state.records[uid]!.base = previous;
    const result = await h.run();
    expect(result.conflicts).toEqual([]);
    expect(h.state.records[uid]!.base.subtasks).toBe(mine.subtasks);
    expect(h.state.records[uid]!.base.description).toBe("");
    expect(h.notes.write).not.toHaveBeenCalled();
  });
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

describe("explicit note-authoritative sync", () => {
  test("keeps an unfinished export for another note pending without executing it", async () => {
    const h = harness();
    h.state.pendingCreate = {
      uid: "c".repeat(32),
      path: "Daily/2026-11-15.md",
      snapshot: base,
    };
    await expect(h.run(path)).rejects.toThrow("other note");
    expect(h.api.list).not.toHaveBeenCalled();
    expect(h.api.create).not.toHaveBeenCalled();
    expect(h.state.pendingCreate.path).toBe("Daily/2026-11-15.md");
  });
  test("current Markdown wins over Google and a saved conflict draft without rewriting the note", async () => {
    const h = harness(
      block({
        ...base,
        title: "Current note",
        subtasks: "- [x] Current child",
        description: "Current description",
      }),
      event({ ...base, title: "Google version", colorId: "7" }),
    );
    h.state.records[uid]!.pendingConflict = {
      mine: { ...base, title: "Old saved draft" },
      raw: "old",
      fields: ["title"],
      detectedAt: "2030-01-01T00:00:00Z",
    };
    const result = await h.run(path);
    expect(result.conflicts).toEqual([]);
    expect(result.pulled).toBe(0);
    expect(h.state.records[uid]!.base).toMatchObject({
      title: "Current note",
      subtasks: "- [x] Current child",
      description: "Current description",
      colorId: "7",
    });
    expect(h.state.records[uid]!.pendingConflict).toBeUndefined();
    expect(h.api.update).toHaveBeenCalledOnce();
    expect(vi.mocked(h.api.update).mock.calls[0]?.[2]).toBe(true);
    expect(h.notes.write).not.toHaveBeenCalled();
    expect(h.notes.cancel).not.toHaveBeenCalled();
  });

  test("removes a missing linked event and exports replacement blocks in the same pass", async () => {
    const h = harness(
      block(base),
      event({ ...base, title: "Changed remotely" }),
    );
    const replacement = {
      ...block({ ...base, title: "Replacement" }),
      uid: "c".repeat(32),
    };
    vi.mocked(h.notes.scan).mockResolvedValue([replacement]);
    vi.mocked(h.api.get).mockResolvedValue(null);
    vi.mocked(h.api.create).mockImplementation(async (id, uid, snapshot) => ({
      ...event(snapshot),
      id,
      extendedProperties: {
        private: { dayPlannerVault: namespace, dayPlannerBlock: uid },
      },
    }));
    const result = await h.run(path);
    expect(result.conflicts).toEqual([]);
    expect(h.notes.canDelete).not.toHaveBeenCalled();
    expect(h.api.remove).toHaveBeenCalledOnce();
    expect(h.api.create).toHaveBeenCalledOnce();
    expect(h.api.update).not.toHaveBeenCalled();
    expect(h.state.records[uid]!.deleted).toBe(true);
    expect(h.state.records[replacement.uid]!.base.title).toBe("Replacement");
    expect(h.notes.write).not.toHaveBeenCalled();
  });

  test("one missing block produces one export-blocker message for many unmatched blocks", async () => {
    const h = harness();
    vi.mocked(h.notes.scan).mockResolvedValue(
      Array.from({ length: 8 }, (_, index) => ({
        ...block({ ...base, title: `New ${index}` }),
        uid: String(index).repeat(32),
      })),
    );
    const result = await h.run();
    expect(result.missingLocal).toHaveLength(1);
    expect(result.conflicts).toHaveLength(2);
    expect(
      result.conflicts.filter((message) =>
        message.includes("before exporting new blocks"),
      ),
    ).toHaveLength(1);
    expect(h.api.create).not.toHaveBeenCalled();
  });

  test("a successfully propagated deletion does not block new exports", async () => {
    const h = harness();
    const replacement = {
      ...block({ ...base, title: "New" }),
      uid: "c".repeat(32),
    };
    vi.mocked(h.notes.scan).mockResolvedValue([replacement]);
    vi.mocked(h.notes.canDelete).mockResolvedValue(true);
    vi.mocked(h.api.get).mockResolvedValue(null);
    vi.mocked(h.api.create).mockImplementation(async (id, uid, snapshot) => ({
      ...event(snapshot),
      id,
      extendedProperties: {
        private: { dayPlannerVault: namespace, dayPlannerBlock: uid },
      },
    }));
    expect((await h.run()).conflicts).toEqual([]);
    expect(h.api.remove).toHaveBeenCalledOnce();
    expect(h.api.create).toHaveBeenCalledOnce();
  });

  test("leaves other notes, moved-out blocks and unlinked Google events alone", async () => {
    const h = harness();
    const other = { ...block(base), path: "Daily/2026-11-15.md" };
    vi.mocked(h.notes.scan).mockResolvedValue([other]);
    const unlinked = { ...event(base), id: "outside", extendedProperties: {} };
    vi.mocked(h.api.list).mockResolvedValue([h.remote(), unlinked]);
    const result = await h.run(path);
    expect(result.conflicts).toEqual([]);
    expect(h.api.update).not.toHaveBeenCalled();
    expect(h.api.remove).not.toHaveBeenCalled();
    expect(h.notes.write).not.toHaveBeenCalled();
    expect(h.api.link).toBeUndefined();
  });

  test.each(["document", "scope"])(
    "requires a current enabled daily note for %s",
    async (reason) => {
      const h = harness();
      if (reason === "document") {
        vi.mocked(h.notes.isDocumentUnchanged!).mockResolvedValue(false);
        await expect(h.run(path)).rejects.toThrow(
          "selected daily note changed",
        );
        expect(h.api.list).not.toHaveBeenCalled();
      } else {
        vi.mocked(h.notes.canSync!).mockResolvedValue(false);
        expect((await h.run(path)).conflicts).toEqual([]);
      }
      expect(h.api.update).not.toHaveBeenCalled();
      expect(h.api.remove).not.toHaveBeenCalled();
    },
  );

  test("stops if the note changes while a force operation is running", async () => {
    const h = harness();
    vi.mocked(h.notes.isDocumentUnchanged!)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValue(false);
    const result = await h.run(path);
    expect(result.conflicts[0]).toContain("selected daily note changed");
    expect(h.api.update).not.toHaveBeenCalled();
    expect(h.state.records[uid]!.base).toEqual(base);
  });

  test("a failed conditional write is attempted once and keeps its conflict draft", async () => {
    const h = harness();
    const draft = {
      mine: base,
      raw: "saved",
      fields: ["title"],
      detectedAt: "2030-01-01T00:00:00Z",
    };
    h.state.records[uid]!.pendingConflict = draft;
    vi.mocked(h.api.update).mockRejectedValue(
      new Error("Google changed during sync"),
    );
    expect((await h.run(path)).conflicts[0]).toContain(
      "Google changed during sync",
    );
    expect(h.api.update).toHaveBeenCalledOnce();
    expect(h.state.records[uid]!.pendingConflict).toEqual(draft);
    expect(h.state.records[uid]!.base).toEqual(base);
    expect(h.notes.write).not.toHaveBeenCalled();
  });

  test("recovers an interrupted recreation with the same event ID and retains the current note", async () => {
    const h = harness(block({ ...base, title: "Keep this" }), {
      ...event(base),
      status: "cancelled",
    });
    let created: GoogleEvent | null = null;
    vi.mocked(h.api.get).mockImplementation(async (id) =>
      id === created?.id ? created : null,
    );
    vi.mocked(h.api.create).mockImplementation(async (id, uid, snapshot) => {
      created = {
        ...event(snapshot),
        id,
        extendedProperties: {
          private: { dayPlannerVault: namespace, dayPlannerBlock: uid },
        },
      };
      throw new Error("Lost create response");
    });
    await expect(h.run(path)).rejects.toThrow("Lost create response");
    const pending = structuredClone(h.state.pendingCreate)!;
    expect(pending.preserveNote).toBe(true);
    expect(pending.eventId).toBeTruthy();
    const result = await h.run(path);
    expect(result.conflicts).toEqual([]);
    expect(h.api.create).toHaveBeenCalledOnce();
    expect(h.state.pendingCreate).toBeUndefined();
    expect(h.state.records[uid]!.eventId).toBe(pending.eventId);
    expect(h.state.records[uid]!.base.title).toBe("Keep this");
    expect(h.notes.write).not.toHaveBeenCalled();
  });
});
