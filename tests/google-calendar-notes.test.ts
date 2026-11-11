import { webcrypto } from "node:crypto";
import { TFile, type App } from "obsidian";
import { beforeEach, describe, expect, test, vi } from "vitest";

import { ObsidianCalendarNotes } from "../src/google-calendar/notes";
import type { CalendarSyncState } from "../src/google-calendar/types";
import type { PeriodicNotes } from "../src/service/periodic-notes";
import { defaultSettings } from "../src/settings";

const uid = "a".repeat(32);
const marker = `<!-- dp-gcal:${uid} -->`;
const original = `- [x] 09:00 - 10:00 Work #work ${marker} ^anchor\r\n    - [ ] Nested [[Other]] ^child`;
const sourcePath = "Daily/2026-11-11.md";

function harness() {
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
  );
  return {
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
      "- [-] Cancelled in Google Calendar:",
    );
    expect(h.texts.get(sourcePath)).toContain("Nested [[Other]] ^child");
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
