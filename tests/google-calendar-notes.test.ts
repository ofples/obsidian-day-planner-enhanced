import { webcrypto } from "node:crypto";
import { TFile, type App } from "obsidian";
import { beforeEach, describe, expect, test, vi } from "vitest";

import { ObsidianCalendarNotes } from "../src/google-calendar/notes";
import { syncCalendar } from "../src/google-calendar/engine";
import { structuredDescription } from "../src/google-calendar/subtasks";
import {
  canonicalSnapshotOf,
  type CalendarApi,
  type CalendarSyncState,
  type GoogleEvent,
} from "../src/google-calendar/types";
import type { PeriodicNotes } from "../src/service/periodic-notes";
import { defaultSettings } from "../src/settings";

const uid = "a".repeat(32);
const marker = `<!-- dp-gcal:${uid} -->`;
const original = `- [x] 09:00 - 10:00 Work #work ${marker} ^anchor\r\n    - [ ] Nested [[Other]] ^child`;
const sourcePath = "Daily/2026-11-11.md";

function harness(
  edits?: { isWriting: boolean; revision: number },
  localWrites = false,
) {
  const texts = new Map([
    [
      sourcePath,
      `# Day planner\r\n\r\n${original}\r\n\r\n# Journal\r\nUntouched.\r\n`,
    ],
  ]);
  const files = new Map<string, TFile>();
  const file = (path: string) => {
    let value = files.get(path);
    if (!value) {
      value = Object.assign(new TFile(), { path });
      files.set(path, value);
    }
    return value;
  };
  file(sourcePath);
  let failSource = false;
  const process = vi.fn(
    async (value: TFile, update: (text: string) => string) => {
      if (failSource && value.path === sourcePath)
        throw new Error("Simulated interrupted move");
      const next = update(texts.get(value.path) ?? "");
      texts.set(value.path, next);
      return next;
    },
  );
  const app = {
    vault: {
      getAbstractFileByPath: (path: string) => files.get(path),
      getMarkdownFiles: () => Array.from(files.values()),
      read: async (value: TFile) => texts.get(value.path) ?? "",
      process,
    },
  } as unknown as App;
  const daily = {
    getAllDailyNotes: () =>
      Object.fromEntries(
        Array.from(files.entries()).filter(([path]) =>
          path.startsWith("Daily/"),
        ),
      ),
    getDateFromFile: (value: TFile) =>
      window.moment(value.path.slice(6, -3), "YYYY-MM-DD", true),
    createDailyNoteIfNeeded: async (date: ReturnType<typeof window.moment>) => {
      const path = `Daily/${date.format("YYYY-MM-DD")}.md`;
      if (!texts.has(path))
        texts.set(path, "# Day planner\n\n# Journal\nTarget journal.\n");
      return file(path);
    },
  } as unknown as PeriodicNotes;
  const state: CalendarSyncState = {
    version: 1,
    namespace: "b".repeat(32),
    calendarId: "test",
    records: {},
  };
  const settings = {
    ...defaultSettings,
    googleCalendar: { ...defaultSettings.googleCalendar, syncDeletions: true },
  };
  const save = vi.fn(async () => {});
  const notes = new ObsidianCalendarNotes(
    app,
    daily,
    settings,
    window.moment("2026-11-01").toISOString(),
    window.moment("2026-12-01").toISOString(),
    state,
    save,
    edits,
    localWrites,
  );
  return {
    app,
    daily,
    texts,
    files,
    file,
    state,
    settings,
    notes,
    save,
    process,
    interrupt: (value: boolean) => {
      failSource = value;
    },
  };
}

beforeEach(() => vi.stubGlobal("crypto", webcrypto));

describe("vault calendar adapter", () => {
  test("explicit local writes work in excluded notes while calendar writes stay blocked", async () => {
    const h = harness(undefined, true);
    h.settings.googleCalendar.syncStartDate = "2026-11-14";
    const previous =
      "---\r\nsync: off\r\n---\r\n# Day planner\r\n\r\n# Journal\r\nKeep.\r\n";
    h.texts.set(sourcePath, previous);
    expect(await h.notes.scan()).toEqual([]);
    const snapshot = {
      title: "Imported",
      start: window.moment("2026-11-11 09:00").toISOString(),
      end: window.moment("2026-11-11 10:00").toISOString(),
    };
    await h.notes.write(uid, snapshot);
    const after = h.texts.get(sourcePath)!;
    expect(after).toContain("09:00 - 10:00 Imported");
    expect(after).toContain("sync: off");
    expect(after).toContain("# Journal\r\nKeep.");
    expect(await h.notes.scan()).toEqual([]);
    expect(h.texts.get(sourcePath)).toBe(after);
    const regular = new ObsidianCalendarNotes(
      h.app,
      h.daily,
      h.settings,
      window.moment("2026-11-01").toISOString(),
      window.moment("2026-12-01").toISOString(),
      h.state,
      h.save,
    );
    await expect(regular.write(uid, snapshot)).rejects.toThrow(
      "outside Google Calendar sync scope",
    );
  });
  test("interrupted explicitly authorized note edits recover outside calendar scope", async () => {
    const h = harness(undefined, true);
    h.settings.googleCalendar.syncStartDate = "2026-11-14";
    const before = "---\nsync: false\n---\n# Day planner\n";
    h.texts.set(sourcePath, before);
    h.interrupt(true);
    await expect(
      h.notes.applyEdits([
        { path: sourcePath, before, after: before + "- [ ] Added\n" },
      ]),
    ).rejects.toThrow("interrupted");
    expect(h.state.pendingNoteChange?.localWrites).toBe(true);
    h.interrupt(false);
    await h.notes.scan();
    expect(h.texts.get(sourcePath)).toBe(before + "- [ ] Added\n");
    expect(h.state.pendingNoteChange).toBeUndefined();
  });
  test("canonical sync round trips through real note scanning and survives restart", async () => {
    const h = harness();
    h.settings.googleCalendar.syncStartDate = "2026-11-14";
    const futurePath = "Daily/2026-11-14.md";
    h.file(futurePath);
    h.texts.set(
      futurePath,
      "# Day planner\r\n\r\n- [ ] 09:00 - 10:00 Work #work ^kept\r\n    - [ ] Original child\r\n\r\n# Journal\r\nKeep my prose.\r\n",
    );
    const historical = h.texts.get(sourcePath);
    let remote: GoogleEvent | null = null;
    const api: CalendarApi = {
      list: async () => (remote ? [remote] : []),
      get: async () => remote,
      create: async (id, blockUid, snapshot) => {
        remote = {
          id,
          etag: "created",
          summary: snapshot.title,
          start: { dateTime: snapshot.start },
          end: { dateTime: snapshot.end },
          description: structuredDescription(
            snapshot.description ?? "",
            snapshot.tags ?? [],
            snapshot.subtasks ?? "",
          ),
          extendedProperties: {
            private: {
              dayPlannerVault: h.state.namespace,
              dayPlannerBlock: blockUid,
              dayPlannerTags: JSON.stringify(snapshot.tags ?? []),
            },
          },
        };
        return remote;
      },
      update: vi.fn(async (event, snapshot) => {
        expect(canonicalSnapshotOf(event, snapshot)).toEqual(snapshot);
        return event;
      }),
      remove: vi.fn(async () => {}),
    };
    const run = () =>
      syncCalendar({
        state: h.state,
        api,
        notes: h.notes,
        save: h.save,
        timeMin: window.moment("2026-11-01").toISOString(),
        timeMax: window.moment("2026-12-01").toISOString(),
        importEvents: true,
        canonical: true,
      });
    expect((await run()).conflicts).toEqual([]);
    const [identity] = Object.keys(h.state.records);
    const originalEventId = remote!.id;
    remote = {
      ...remote!,
      etag: "google-edited",
      summary: "Google renamed",
      colorId: "3",
      description: structuredDescription(
        "Google details\nsecond line",
        ["karma"],
        "- [x] Updated child\n  - [ ] Grandchild",
      ),
      extendedProperties: {
        private: {
          ...remote!.extendedProperties?.private,
          dayPlannerTags: '["karma"]',
        },
      },
    };
    Object.assign(
      h.state,
      JSON.parse(JSON.stringify(h.state)) as CalendarSyncState,
    );
    expect((await run()).conflicts).toEqual([]);
    const pulled = h.texts.get(futurePath)!;
    expect(pulled).toContain("Google renamed #karma ^kept");
    expect(pulled).toContain("Updated child");
    expect(pulled).toContain("Google details");
    expect(pulled).toContain("Keep my prose.");
    expect(pulled).not.toContain("dp-gcal");
    expect((await run()).conflicts).toEqual([]);
    expect(h.texts.get(futurePath)).toBe(pulled);
    expect(Object.keys(h.state.records)).toEqual([identity]);
    expect(h.state.records[identity!]?.eventId).toBe(originalEventId);
    expect(h.texts.get(sourcePath)).toBe(historical);
    expect(api.remove).not.toHaveBeenCalled();
  });
  test("archived identities cannot be reassigned to matching future tasks", async () => {
    const h = harness();
    h.settings.googleCalendar.syncStartDate = "2026-11-14";
    const oldSnapshot = {
      title: "Work #work",
      start: window.moment("2026-11-11 09:00").toISOString(),
      end: window.moment("2026-11-11 10:00").toISOString(),
    };
    const oldIdentity = {
      path: sourcePath,
      from: 15,
      raw: original.replace(` ${marker}`, ""),
      snapshot: oldSnapshot,
    };
    h.state.records[uid] = {
      eventId: "old-event",
      path: sourcePath,
      base: oldSnapshot,
    };
    h.state.identities = { [uid]: oldIdentity };
    const futurePath = "Daily/2026-11-14.md";
    h.file(futurePath);
    h.texts.set(futurePath, `# Day planner\r\n\r\n${oldIdentity.raw}\r\n`);
    const blocks = await h.notes.scan();
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.uid).not.toBe(uid);
    expect(h.state.identities[uid]).toEqual(oldIdentity);
    expect(h.texts.get(sourcePath)).toContain(marker);
  });
  test("never scans or rewrites pre-cutover and opted-out notes", async () => {
    const h = harness();
    h.settings.googleCalendar.syncStartDate = "2026-11-14";
    const historical = h.texts.get(sourcePath)!;
    const optedPath = "Daily/2026-11-14.md";
    const opted = `---\r\nsync: off\r\n---\r\n# Day planner\r\n- [ ] 09:00 - 10:00 Private ${marker}\r\n`;
    h.file(optedPath);
    h.texts.set(optedPath, opted);
    expect(await h.notes.scan()).toEqual([]);
    expect(h.texts.get(sourcePath)).toBe(historical);
    expect(h.texts.get(optedPath)).toBe(opted);
    const snapshot = {
      title: "Private",
      start: window.moment("2026-11-14 09:00").toISOString(),
      end: window.moment("2026-11-14 10:00").toISOString(),
    };
    expect(await h.notes.canSync(optedPath, snapshot)).toBe(false);
    expect(await h.notes.canSync("", snapshot)).toBe(false);
    await expect(
      h.notes.applyEdits([
        { path: sourcePath, before: historical, after: historical + "changed" },
      ]),
    ).rejects.toThrow("outside Google Calendar sync scope");
    await expect(
      h.notes.applyEdits([
        { path: optedPath, before: opted, after: opted + "changed" },
      ]),
    ).rejects.toThrow("outside Google Calendar sync scope");
    await expect(h.notes.write(uid, snapshot)).rejects.toThrow(
      "outside Google Calendar sync scope",
    );
    expect(h.texts.get(optedPath)).toBe(opted);
  });
  test("restoring a missing note retains the saved children while using Google title and time", async () => {
    const h = harness();
    h.texts.set(sourcePath, "# Day planner\r\n\r\n# Journal\r\nUntouched.\r\n");
    await h.notes.scan();
    const snapshot = {
      title: "Google title",
      start: window.moment("2026-11-11 11:00").toISOString(),
      end: window.moment("2026-11-11 12:00").toISOString(),
    };
    await h.notes.write(uid, snapshot, undefined, original);
    expect(h.texts.get(sourcePath)).toContain("11:00 - 12:00 Google title");
    expect(h.texts.get(sourcePath)).toContain("Nested [[Other]] ^child");
    expect(h.texts.get(sourcePath)).toContain("# Journal\r\nUntouched.");
  });
  test("native note writes invalidate calendar scan and mutation evidence", async () => {
    const edits = { isWriting: true, revision: 1 };
    const h = harness(edits);
    await expect(h.notes.scan()).rejects.toThrow("current note edit");
    expect(h.save).not.toHaveBeenCalled();
    edits.isWriting = false;
    edits.revision++;
    const [block] = await h.notes.scan();
    expect(await h.notes.isUnchanged(block!)).toBe(true);
    edits.isWriting = true;
    expect(await h.notes.isUnchanged(block!)).toBe(false);
    edits.isWriting = false;
    edits.revision++;
    expect(await h.notes.isUnchanged(block!)).toBe(false);
    expect(
      await h.notes.canDelete(
        { eventId: "event", path: sourcePath, base: block!.snapshot },
        uid,
        true,
      ),
    ).toBe(false);
    await h.notes.scan();
    expect(await h.notes.isUnchanged(block!)).toBe(true);
  });

  test("preparing a projection exposes exact before/after bytes before applying its note write", async () => {
    const h = harness();
    const [block] = await h.notes.scan();
    h.process.mockClear();
    const before = h.texts.get(sourcePath)!;
    const plan = await h.notes.prepareWrite(
      uid,
      { ...block!.snapshot, title: "Scheduled task #work" },
      block,
    );
    expect(h.process).not.toHaveBeenCalled();
    expect(h.texts.get(sourcePath)).toBe(before);
    expect(plan.edits).toHaveLength(1);
    expect(plan.edits[0]?.before).toBe(before);
    expect(plan.edits[0]?.after).toContain("Scheduled task #work");
    expect(plan.block.uid).toBe(uid);
    const applied = await h.notes.applyWrite(plan);
    expect(applied).toEqual(plan.block);
    expect(h.state.identities?.[uid]?.raw).toBe(applied.raw);
    expect(h.state.pendingNoteChange).toBeUndefined();
  });
  test("migration preserves IDs and only removes legacy comments", async () => {
    const h = harness();
    const before = h.texts.get(sourcePath)!;
    const [block] = await h.notes.scan();
    expect(block?.uid).toBe(uid);
    expect(h.texts.get(sourcePath)).toBe(before.replace(` ${marker}`, ""));
    expect(h.state.identities?.[uid]?.raw).toContain("^anchor");
    expect((await h.notes.scan())[0]?.uid).toBe(uid);
    expect(h.state.pendingNoteChange).toBeUndefined();
  });
  test("failed migration saves leave note text intact and recovery keeps identity", async () => {
    const h = harness();
    const before = h.texts.get(sourcePath);
    h.save.mockRejectedValueOnce(new Error("Disk unavailable"));
    await expect(h.notes.scan()).rejects.toThrow("Disk unavailable");
    expect(h.texts.get(sourcePath)).toBe(before);
    expect(h.state.pendingNoteChange).toBeDefined();
    await h.notes.recoverMove();
    expect((await h.notes.scan())[0]?.uid).toBe(uid);
    expect(h.texts.get(sourcePath)).not.toContain("dp-gcal");
  });
  test("local edits and checkbox changes keep the sidecar identity", async () => {
    const h = harness();
    await h.notes.scan();
    h.texts.set(
      sourcePath,
      h.texts
        .get(sourcePath)!
        .replace(
          "09:00 - 10:00 Work #work",
          "10:15 - 11:45 Different title #work",
        )
        .replace("- [x]", "- [ ]"),
    );
    const [edited] = await h.notes.scan();
    expect(edited?.uid).toBe(uid);
    expect(edited?.snapshot.title).toBe("Different title #work");
    expect(h.texts.get(sourcePath)).not.toContain("dp-gcal");
  });
  test("plain blocks moved to another daily note keep their existing link", async () => {
    const h = harness();
    const [block] = await h.notes.scan();
    h.texts.set(sourcePath, h.texts.get(sourcePath)!.replace(block!.raw, ""));
    h.file("Daily/2026-11-12.md");
    h.texts.set("Daily/2026-11-12.md", `# Day planner\n\n${block!.raw}\n`);
    const [moved] = await h.notes.scan();
    expect(moved?.uid).toBe(uid);
    expect(moved?.path).toBe("Daily/2026-11-12.md");
  });
  test("new imports recover after the note write but before the metadata commit", async () => {
    const h = harness();
    const [block] = await h.notes.scan();
    const snapshot = { ...block!.snapshot, title: "Imported event" };
    const newUid = "c".repeat(32);
    let savedJournal = "";
    h.save
      .mockImplementationOnce(async () => {
        savedJournal = JSON.stringify(h.state);
      })
      .mockRejectedValueOnce(new Error("Interrupted commit"));
    await expect(h.notes.write(newUid, snapshot)).rejects.toThrow(
      "Interrupted commit",
    );
    // Restore exactly the persisted state, as a restart after the failed commit would.
    for (const key of Object.keys(h.state))
      Reflect.deleteProperty(h.state, key);
    Object.assign(h.state, JSON.parse(savedJournal));
    expect(h.state.pendingNoteChange).toBeDefined();
    await h.notes.recoverMove();
    expect(
      (await h.notes.scan()).filter((item) => item.uid === newUid),
    ).toHaveLength(1);
    expect(h.texts.get(sourcePath)?.match(/Imported event/g)).toHaveLength(1);
  });
  test("legacy marker-based move journals recover before migration", async () => {
    const h = harness();
    const snapshot = {
      title: "Work #work",
      start: window.moment("2026-11-12T09:00").toISOString(),
      end: window.moment("2026-11-12T10:00").toISOString(),
    };
    h.file("Daily/2026-11-12.md");
    h.texts.set("Daily/2026-11-12.md", "# Day planner\n");
    h.state.pendingMove = {
      source: { uid, path: sourcePath, raw: original, snapshot },
      targetPath: "Daily/2026-11-12.md",
      raw: original,
      snapshot,
    };
    await h.notes.recoverMove();
    expect(h.state.pendingMove).toBeUndefined();
    const [moved] = await h.notes.scan();
    expect(moved?.uid).toBe(uid);
    expect(moved?.path).toBe("Daily/2026-11-12.md");
    expect(Array.from(h.texts.values()).join("\n")).not.toContain("dp-gcal");
  });
  test("scanning stores eligible block IDs outside the unchanged note", async () => {
    const h = harness();
    h.texts.set(
      sourcePath,
      "# Day planner\n- [ ] 09:00 Parent ^anchor\n    - [ ] 09:15 Child\n# Other\n- [ ] 11:00 Outside\n",
    );
    const blocks = await h.notes.scan();
    expect(blocks).toHaveLength(1);
    expect(h.texts.get(sourcePath)).not.toContain("dp-gcal");
    expect(Object.keys(h.state.identities!)).toHaveLength(1);
    expect(h.texts.get(sourcePath)).toContain(
      "Parent ^anchor\n    - [ ] 09:15 Child\n# Other\n- [ ] 11:00 Outside\n",
    );
  });
  test("Google edits preserve unrelated sections and exact child content", async () => {
    const h = harness();
    const [block] = await h.notes.scan();
    await h.notes.write(
      uid,
      { ...block!.snapshot, title: "New title #work" },
      block,
    );
    expect(h.texts.get(sourcePath)).toContain("New title #work");
    expect(h.texts.get(sourcePath)).toContain(
      "^anchor\r\n    - [ ] Nested [[Other]] ^child",
    );
    expect(h.texts.get(sourcePath)).toContain("# Journal\r\nUntouched.\r\n");
  });
  test("date changes move the complete subtree and clear the journal", async () => {
    const h = harness();
    const [block] = await h.notes.scan();
    const snapshot = {
      ...block!.snapshot,
      start: window.moment("2026-11-12T09:00").toISOString(),
      end: window.moment("2026-11-12T10:00").toISOString(),
    };
    const moved = await h.notes.write(uid, snapshot, block);
    expect(moved.path).toBe("Daily/2026-11-12.md");
    expect(h.texts.get(sourcePath)).not.toContain(marker);
    expect(h.texts.get(sourcePath)).toContain("# Journal\r\nUntouched.\r\n");
    expect(h.texts.get(moved.path)).toContain("Nested [[Other]] ^child");
    expect(h.texts.get(moved.path)).toContain("Target journal.");
    expect(h.state.pendingMove).toBeUndefined();
  });
  test("an interrupted cross-note move recovers without duplication or lost children", async () => {
    const h = harness();
    const [block] = await h.notes.scan();
    h.interrupt(true);
    const snapshot = {
      ...block!.snapshot,
      start: window.moment("2026-11-12T09:00").toISOString(),
      end: window.moment("2026-11-12T10:00").toISOString(),
    };
    await expect(h.notes.write(uid, snapshot, block)).rejects.toThrow(
      "interrupted",
    );
    expect(h.state.pendingNoteChange).toBeDefined();
    expect(h.texts.get(sourcePath)).toContain("Work #work");
    expect(h.texts.get("Daily/2026-11-12.md")).toContain("Work #work");
    h.interrupt(false);
    await h.notes.recoverMove();
    expect(h.state.pendingNoteChange).toBeUndefined();
    expect((await h.notes.scan()).map((block) => block.uid)).toEqual([uid]);
    expect(Array.from(h.texts.values()).join("\n")).not.toContain("dp-gcal");
    expect(h.texts.get("Daily/2026-11-12.md")).toContain(
      "Nested [[Other]] ^child",
    );
  });
  test("cancellation retains the task subtree and does not mark it completed", async () => {
    const h = harness();
    const [block] = await h.notes.scan();
    await h.notes.cancel(block!);
    expect(h.texts.get(sourcePath)).toContain(
      "- [-] ~~09:00 - 10:00 Work #work~~ ^anchor",
    );
    expect(h.texts.get(sourcePath)).toContain("Nested [[Other]] ^child");
    expect(await h.notes.scan()).toEqual([]);
  });
  test("migrates legacy cancelled lines without changing surrounding bytes or block IDs", async () => {
    const h = harness();
    const text =
      "# Day planner\r\n- [-] Cancelled in Google Calendar: 09:00 - 10:00 Old ^anchor\r\n  - [ ] Child\r\n# Journal\r\nKeep.\r\n";
    h.texts.set(sourcePath, text);
    expect(await h.notes.scan()).toEqual([]);
    expect(h.texts.get(sourcePath)).toBe(
      text.replace(
        "Cancelled in Google Calendar: 09:00 - 10:00 Old ^anchor",
        "~~09:00 - 10:00 Old~~ ^anchor",
      ),
    );
    expect(await h.notes.scan()).toEqual([]);
  });
  test("an ID moved to an unrelated note protects the Google event from deletion", async () => {
    const h = harness();
    const [block] = await h.notes.scan();
    h.texts.set(sourcePath, h.texts.get(sourcePath)!.replace(block!.raw, ""));
    h.file("Projects/Moved.md");
    h.texts.set(
      "Projects/Moved.md",
      original.replace("Work #work", "Completely different title"),
    );
    expect(
      await h.notes.canDelete(
        { eventId: "event1", path: sourcePath, base: block!.snapshot },
        uid,
      ),
    ).toBe(false);
  });
  test("local deletion is disabled by default and requires the source file to exist", async () => {
    const h = harness();
    const [block] = await h.notes.scan();
    h.texts.set(sourcePath, h.texts.get(sourcePath)!.replace(block!.raw, ""));
    const record = {
      eventId: "event1",
      path: sourcePath,
      base: block!.snapshot,
    };
    h.settings.googleCalendar.syncDeletions = false;
    expect(await h.notes.canDelete(record, uid)).toBe(false);
    h.settings.googleCalendar.syncDeletions = true;
    expect(await h.notes.canDelete(record, uid)).toBe(true);
    h.files.delete(sourcePath);
    expect(await h.notes.canDelete(record, uid)).toBe(false);
  });
  test("a removed owned block can be retired alongside additions and other edits", async () => {
    const h = harness();
    const journal = "# Journal\nUntouched.\n";
    h.texts.set(
      sourcePath,
      `# Day planner\n- [ ] 09:00 - 09:30 Old\n- [ ] 10:00 - 11:00 Keep\n\n${journal}`,
    );
    const [old, keep] = await h.notes.scan();
    const record = { eventId: "event1", path: sourcePath, base: old!.snapshot };
    h.state.records[old!.uid] = record;
    const revised = `New preamble.\n\n## Notes\n- An ordinary prose bullet.\n\n# Day planner\n- [ ] 15:00 - 16:00 New #work\n    - [ ] Child\n- [ ] 10:00 - 11:00 Renamed\n- [ ] 17:00 - 18:00 Added\n\n${journal}`;
    h.texts.set(sourcePath, revised);
    const next = await h.notes.scan();
    expect(next.map((block) => block.snapshot.title)).toEqual([
      "New #work",
      "Renamed",
      "Added",
    ]);
    expect(next[1]?.uid).toBe(keep?.uid);
    expect(next.some((block) => block.uid === old!.uid)).toBe(false);
    expect(next[0]?.raw).toContain("    - [ ] Child");
    expect(h.texts.get(sourcePath)).toBe(revised);
    expect((await h.notes.scan()).map((block) => block.uid)).toEqual(
      next.map((block) => block.uid),
    );
    expect(await h.notes.canDelete(record, old!.uid, true)).toBe(true);
    expect(await h.notes.canDelete(record, old!.uid, false)).toBe(false);
    h.texts.set(
      sourcePath,
      revised.replace(journal, `${old!.raw}\n\n${journal}`),
    );
    expect(await h.notes.canDelete(record, old!.uid, true)).toBe(false);
    h.texts.set(sourcePath, revised);
    h.settings.googleCalendar.syncDeletions = false;
    expect(await h.notes.canDelete(record, old!.uid, true)).toBe(false);
  });
  test.each(["verbatim", "untimed"])(
    "moving a %s block to another section protects even a plugin-owned event",
    async (mode) => {
      const h = harness();
      const [block] = await h.notes.scan();
      const record = {
        eventId: "event1",
        path: sourcePath,
        base: block!.snapshot,
      };
      h.state.records[uid] = record;
      h.texts.set(
        sourcePath,
        `# Day planner\r\n- [ ] 15:00 - 16:00 New\r\n\r\n# Journal\r\n${mode === "verbatim" ? block!.raw : "- [ ] Moved and made untimed"}\r\nUntouched.\r\n`,
      );
      expect((await h.notes.scan()).map((local) => local.uid)).not.toContain(
        uid,
      );
      expect(await h.notes.canDelete(record, uid, true)).toBe(false);
    },
  );
  test("removing the planner heading does not delete owned events", async () => {
    const h = harness();
    const [block] = await h.notes.scan();
    const record = {
      eventId: "event1",
      path: sourcePath,
      base: block!.snapshot,
    };
    h.state.records[uid] = record;
    h.texts.set(sourcePath, "# Journal\nNew prose.\n");
    expect(await h.notes.scan()).toEqual([]);
    expect(await h.notes.canDelete(record, uid, true)).toBe(false);
  });
  test("a later removal remains verifiable while an older removal holds the document baseline", async () => {
    const h = harness();
    const header = "# Day planner\n";
    h.texts.set(sourcePath, `${header}- [ ] 07:30 Earlier\n`);
    const [earlier] = await h.notes.scan();
    h.state.records[earlier!.uid] = {
      eventId: "event1",
      path: sourcePath,
      base: earlier!.snapshot,
    };
    h.texts.set(sourcePath, `${header}- [ ] 08:30 Later\n`);
    const [later] = await h.notes.scan();
    const record = {
      eventId: "event2",
      path: sourcePath,
      base: later!.snapshot,
    };
    h.state.records[later!.uid] = record;
    expect(h.state.documents?.[sourcePath]).not.toContain("Later");
    h.texts.set(sourcePath, header);
    expect(await h.notes.scan()).toEqual([]);
    expect(await h.notes.canDelete(record, later!.uid, true)).toBe(true);
  });
  test("only the surplus mapping is retired when an identical copy is removed", async () => {
    const h = harness();
    const raw = "- [ ] 09:00 - 09:30 Same";
    const header = "# Day planner\n";
    h.texts.set(sourcePath, `${header}${raw}\n${raw}\n`);
    const [first, second] = await h.notes.scan();
    const record = {
      eventId: "event2",
      path: sourcePath,
      base: second!.snapshot,
    };
    h.state.records[second!.uid] = record;
    h.texts.set(sourcePath, `${header}${raw}\n`);
    expect((await h.notes.scan()).map((block) => block.uid)).toEqual([
      first?.uid,
    ]);
    expect(await h.notes.canDelete(record, second!.uid, true)).toBe(true);
  });
  test("a titled task elsewhere does not protect a removed time-only block with the same prefix", async () => {
    const h = harness();
    const header = "# Day planner\n";
    const kept = "- [ ] 08:30 Keep\n";
    h.texts.set(sourcePath, `${header}- [ ] 07:30 \n${kept}`);
    const [old] = await h.notes.scan();
    const record = { eventId: "event1", path: sourcePath, base: old!.snapshot };
    h.state.records[old!.uid] = record;
    const elsewhere = "Projects/Other.md";
    h.file(elsewhere);
    h.texts.set(elsewhere, "- [ ] 07:30 Other task\n");
    h.texts.set(sourcePath, header + kept);
    await h.notes.scan();
    expect(await h.notes.canDelete(record, old!.uid, true)).toBe(true);
    h.texts.set(elsewhere, "    - [ ] 07:30\n");
    expect(await h.notes.canDelete(record, old!.uid, true)).toBe(false);
  });
  test("concurrent edits stop a pull rather than replacing changed text", async () => {
    const h = harness();
    const [block] = await h.notes.scan();
    h.texts.set(
      sourcePath,
      h.texts.get(sourcePath)!.replace("Work #work", "User edit"),
    );
    await expect(
      h.notes.write(uid, { ...block!.snapshot, title: "Remote edit" }, block),
    ).rejects.toThrow("changed");
    expect(h.texts.get(sourcePath)).toContain("User edit");
  });
});
