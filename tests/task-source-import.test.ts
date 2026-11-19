import { TFile, type App } from "obsidian";
import { get } from "svelte/store";
import { describe, expect, test, vi } from "vitest";

import {
  normalizeLocalSnapshot,
  renderBlock,
} from "../src/google-calendar/markdown";
import { ObsidianCalendarNotes } from "../src/google-calendar/notes";
import type { GoogleCalendarSync } from "../src/google-calendar/service";
import { plainCalendarDescription } from "../src/google-calendar/subtasks";
import type { CalendarSyncState } from "../src/google-calendar/types";
import type { PeriodicNotes } from "../src/service/periodic-notes";
import { defaultSettings } from "../src/settings";
import { tasksAddedToNote } from "../src/tasks/added-to-note";
import { parseCaptureCandidates } from "../src/tasks/capture-parser";
import { TaskScheduler } from "../src/tasks/schedule";
import { serializeSourceTask } from "../src/tasks/serialize-source-task";
import {
  canonicalSourceUrl,
  formatSourceUrl,
  sourceTaskFromLink,
  stripSourceLinks,
} from "../src/tasks/source-links";
import { taskSourceReference } from "../src/tasks/source-references";
import { taskLinkIdentity } from "../src/tasks/weak-links";

import { taskSourcesFixture } from "./util/task-sources";

async function fixture() {
  const sources = await taskSourcesFixture();
  const files = new Map<string, TFile>();
  const texts = new Map<string, string>();
  const file = (path: string) => {
    let value = files.get(path);
    if (!value) {
      value = Object.assign(new TFile(), { path });
      files.set(path, value);
    }
    return value;
  };
  const app = {
    vault: {
      getAbstractFileByPath: (path: string) => files.get(path),
      getMarkdownFiles: () => [...files.values()],
      read: async (value: TFile) => texts.get(value.path) ?? "",
      process: async (value: TFile, update: (text: string) => string) => {
        const next = update(texts.get(value.path) ?? "");
        texts.set(value.path, next);
        return next;
      },
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
      if (!texts.has(path)) texts.set(path, "# Day planner\n");
      return file(path);
    },
  } as unknown as PeriodicNotes;
  const state: CalendarSyncState = {
    version: 2,
    namespace: "b".repeat(32),
    calendarId: "test",
    records: {},
  };
  const notes = new ObsidianCalendarNotes(
    app,
    daily,
    defaultSettings,
    "2026-11-01T00:00:00Z",
    "2026-12-01T00:00:00Z",
    state,
    async () => {},
  );
  const calendar = {
    editNotes: async (edit) =>
      edit(notes, await notes.scan(), {
        removeProjection: calendar.removeProjection,
      }),
    removeProjection: vi.fn(),
    syncProjection: vi.fn(),
    recoverProjection: vi.fn(),
  } as Pick<
    GoogleCalendarSync,
    "editNotes" | "removeProjection" | "syncProjection" | "recoverProjection"
  >;
  let imports: string | null = null;
  const scheduler = new TaskScheduler(
    sources.service,
    calendar,
    {
      read: async (path) => texts.get(path) ?? null,
      flush: async () => {},
      settings: () => defaultSettings.taskCapture,
      linkedSync: () => true,
      readImports: async () => imports,
      writeImports: async (value) => {
        imports = value;
      },
    },
    sources.sources,
  );
  function put(path: string, text: string) {
    file(path);
    texts.set(path, text);
  }
  return { ...sources, scheduler, calendar, notes, texts, put };
}

describe("ordinary imports from external task sources", () => {
  test("Google parent import keeps descriptions/children and consumes the inserted items in that note", async () => {
    const h = await fixture();
    h.put("Note.md", "# Notes\n");
    const ref = taskSourceReference(h.googleSnapshot, h.googleTask);
    const before = h.texts.get("Note.md")!;
    const id = crypto.randomUUID();
    await h.scheduler.insertFromPane(
      ref,
      { path: "Note.md", offset: before.length, before },
      id,
    );
    const raw = h.texts.get("Note.md")!;
    expect(raw).toContain("Google work #work [🔗]");
    expect(raw).toContain(
      "  Supporting details\n  - [ ] Child work\n    Child notes",
    );
    expect(raw).not.toContain("#todoist");
    await h.scheduler.insertFromPane(
      ref,
      { path: "Note.md", offset: before.length, before },
      id,
    );
    expect(h.texts.get("Note.md")).toBe(raw);
    expect(
      tasksAddedToNote({
        snapshot: h.googleSnapshot,
        path: "Note.md",
        candidates: parseCaptureCandidates("Note.md", raw),
        imports: h.scheduler.importer.sources(),
      }),
    ).toEqual(new Set([h.googleTask.id, h.child.id]));
    expect(h.mutate).not.toHaveBeenCalled();
    expect(h.calendar.syncProjection).not.toHaveBeenCalled();
  });

  test("GitHub schedules through the plain importer even when experimental Todoist ownership is enabled", async () => {
    const h = await fixture();
    const ref = taskSourceReference(h.githubSnapshot, h.githubTask);
    await h.scheduler.place(ref, {
      start: "2026-11-20T09:00:00Z",
      end: "2026-11-20T09:30:00Z",
    });
    const block = (await h.notes.scan())[0]!;
    const normalized = normalizeLocalSnapshot(block);
    expect(normalized.title).toBe("GitHub work");
    expect(normalized.taskUrl).toBe(h.githubTask.source.url);
    expect(normalized.description).toContain("Supporting details");
    const description = plainCalendarDescription(
      normalized.description ?? "",
      normalized.subtasks ?? "",
      normalized.taskUrl,
    );
    expect(description).toContain(`🔗 ${h.githubTask.source.url}`);
    expect(
      renderBlock(block.uid, normalized, defaultSettings, block.raw).match(
        /\[🔗\]/g,
      ),
    ).toHaveLength(1);
    expect(h.mutate).not.toHaveBeenCalled();
    expect(h.calendar.syncProjection).not.toHaveBeenCalled();
  });

  test("frame nesting uses the same note writer and preserves surrounding Markdown", async () => {
    const h = await fixture();
    h.put(
      "Daily/2026-11-20.md",
      "# Day planner\n- [ ] 09:00 - 10:00 Work #frame #work\n\n# Journal\nKeep this\n",
    );
    await h.scheduler.nestFromPane(
      taskSourceReference(h.githubSnapshot, h.githubTask),
      {
        path: "Daily/2026-11-20.md",
        line: 1,
        text: "09:00 - 10:00 Work #frame #work",
      },
    );
    const raw = h.texts.get("Daily/2026-11-20.md")!;
    expect(raw).toContain("  - [ ] GitHub work #work [🔗]");
    expect(raw).toContain("# Journal\nKeep this");
  });

  test("source links stay best effort and never enter Todoist weak sync", async () => {
    const h = await fixture();
    const url = "https://github.com/users/example/projects/1";
    const draft = {
      ...h.githubTask,
      id: "draft-item",
      source: { ...h.githubTask.source, kind: "draft" as const, url },
    };
    const snapshot = { ...h.githubSnapshot, tasks: [draft] };
    const raw = serializeSourceTask(
      snapshot,
      draft.id,
      defaultSettings.taskCapture,
    ).raw;
    expect(sourceTaskFromLink(snapshot, raw)?.id).toBe(draft.id);
    expect(taskLinkIdentity(raw)).toBeUndefined();
    expect(
      sourceTaskFromLink(
        {
          ...snapshot,
          account: { ...snapshot.account, id: "another-account" },
        },
        raw,
      ),
    ).toBeNull();
    expect(
      stripSourceLinks(
        "Review [issue](https://github.com/example/work/issues/7)",
      ),
    ).toContain("[issue]");
    expect(
      canonicalSourceUrl(
        "https://tasks.google.com/task/opaque?identity=kept#part",
      ),
    ).toBe("https://tasks.google.com/task/opaque?identity=kept#part");
    expect(formatSourceUrl("https://elsewhere.example/task")).toBe("");
    const reference = taskSourceReference(h.githubSnapshot, h.githubTask);
    const transferValues = new Map<string, string>();
    const transfer = {
      setData: (key: string, value: string) => transferValues.set(key, value),
      getData: (key: string) => transferValues.get(key) ?? "",
      effectAllowed: "",
    } as unknown as DataTransfer;
    h.scheduler.drag.start(h.githubTask, transfer, reference);
    expect(h.scheduler.drag.accept(transfer).reference).toEqual(reference);
    await h.sources.github.disconnect();
    expect(() => h.scheduler.drag.accept(transfer)).toThrow(
      /another vault, account or session/,
    );
    expect(get(h.sources.snapshots).map((item) => item.provider)).toEqual([
      "google-tasks",
    ]);
  });

  test("checklists in external descriptions cannot implicitly opt in to Todoist creation", async () => {
    const h = await fixture();
    const snapshot = {
      ...h.githubSnapshot,
      tasks: [
        {
          ...h.githubTask,
          description: "Example checklist\n- [ ] Explain #todoist routing",
        },
      ],
    };
    const raw = serializeSourceTask(
      snapshot,
      h.githubTask.id,
      defaultSettings.taskCapture,
    ).raw;
    expect(raw).toContain("Explain `#todoist` routing");
    expect(
      parseCaptureCandidates("Note.md", raw)
        .flatMap((candidate) => candidate.tags)
        .some((tag) => tag.name === "todoist"),
    ).toBe(false);
  });

  test("new sources do not invent frame labels from repository or list names", async () => {
    const h = await fixture();
    const snapshot = {
      ...h.githubSnapshot,
      projects: [{ id: "work", name: "example/work", order: 0 }],
      tasks: [{ ...h.githubTask, labels: [] }],
    };
    const raw = serializeSourceTask(
      snapshot,
      h.githubTask.id,
      defaultSettings.taskCapture,
    ).raw;
    expect(raw).not.toContain("#example/work");
    expect(parseCaptureCandidates("Note.md", raw)[0]?.tags).toEqual([]);
  });
});
