import { DateTime } from "luxon";
import type { Moment } from "moment";
import type { Plugin } from "obsidian";
import { writable } from "svelte/store";
import { beforeEach, expect, test, vi } from "vitest";

import { ObsidianPlanningHost } from "../src/ai-scheduling/obsidian";
import {
  PlanningUndoBlockedError,
  type PlanningDraft,
  type PlanningReceipt,
} from "../src/ai-scheduling/service";
import {
  planningProposalSchema,
  type PlanningContext,
} from "../src/ai-scheduling/types";
import { parseBlocks } from "../src/google-calendar/markdown";
import type { ObsidianCalendarNotes } from "../src/google-calendar/notes";
import type {
  CalendarNoteEditScope,
  GoogleCalendarSync,
} from "../src/google-calendar/service";
import type { LocalIdentity } from "../src/google-calendar/types";
import { configureTimestampRegExps } from "../src/regexp";
import type { PeriodicNotes } from "../src/service/periodic-notes";
import { defaultSettingsForTests } from "../src/settings";
import type { TaskScheduler } from "../src/tasks/schedule";
import type { TaskBrowserState, TaskService } from "../src/tasks/service";
import type { RemoteTimeBlock, WithDuration } from "../src/time-block-types";

const path = "Daily/2031-01-01.md";
const uid = "a".repeat(32);
const template = "# Plan\n\nTemplate journal prompt\n";
const settings = {
  ...defaultSettingsForTests,
  plannerHeading: "Plan",
  plannerHeadingLevel: 1,
  timestampFormat: "HH:mm",
};
beforeEach(() => configureTimestampRegExps("HH:mm"));

function fixture(
  existing = true,
  remoteBlocks: Array<WithDuration<RemoteTimeBlock>> = [],
) {
  const original =
    "# Plan\n\n- [ ] 09:00 - 09:30 Existing work #work\n\nJournal\n";
  const files = new Map<string, string>(existing ? [[path, original]] : []);
  const identities: Record<string, LocalIdentity> = {};
  if (existing) {
    const block = parseBlocks(original, "2031-01-01", settings)[0]!;
    identities[uid] = {
      path,
      raw: block.raw,
      from: block.from,
      snapshot: block.snapshot,
    };
  }
  const adapter = {
    exists: vi.fn(async (name: string) => files.has(name)),
    read: vi.fn(async (name: string) => files.get(name)!),
    write: vi.fn(async (name: string, text: string) => {
      files.set(name, text);
    }),
  };
  const remove = vi.fn(async (file: { path: string }) => {
    files.delete(file.path);
  });
  const vault = {
    configDir: ".obsidian",
    adapter,
    getFileByPath: (name: string) => (files.has(name) ? { path: name } : null),
    read: vi.fn(async (file: { path: string }) => files.get(file.path)!),
    delete: remove,
  };
  const plugin = {
    manifest: { id: "fixture", dir: ".obsidian/plugins/fixture" },
    app: { vault, workspace: { getLeavesOfType: () => [] } },
  } as unknown as Plugin;
  const daily = {
    createDailyNotePath: (day: Moment) =>
      `Daily/${day.format("YYYY-MM-DD")}.md`,
    createDailyNoteIfNeeded: vi.fn(async (day: Moment) => {
      const name = `Daily/${day.format("YYYY-MM-DD")}.md`;
      if (!files.has(name)) files.set(name, template);
      return { path: name };
    }),
  };
  const applyEdits = vi.fn(
    async (
      edits: Array<{ path: string; before: string; after: string }>,
      patch: Record<string, LocalIdentity | null>,
    ) => {
      for (const edit of edits) expect(files.get(edit.path)).toBe(edit.before);
      for (const edit of edits) files.set(edit.path, edit.after);
      for (const [id, identity] of Object.entries(patch)) {
        if (identity) identities[id] = identity;
        else delete identities[id];
      }
    },
  );
  const notes = {
    identitySnapshot: () => ({ ...identities }),
    applyEdits,
  } as unknown as ObsidianCalendarNotes;
  const removeProjection = vi.fn(async (_id: string) => {});
  const calendar = {
    identitySnapshot: () => ({ ...identities }),
    setPlanningUndoHold: vi.fn(),
    projectionNeedsCleanup: vi.fn(() => true),
    editNotes: vi.fn(
      async <T>(
        operation: (
          notes: ObsidianCalendarNotes,
          blocks: Array<LocalIdentity & { uid: string }>,
          scope: CalendarNoteEditScope,
        ) => Promise<T>,
        prepare?: () => Promise<void>,
      ) => {
        await prepare?.();
        return operation(
          notes,
          Object.entries(identities).map(([id, value]) => ({
            ...value,
            uid: id,
          })),
          { removeProjection },
        );
      },
    ),
  };
  const providerTask = {
    id: "task",
    title: "Water plants",
    description: "",
    projectId: "home",
    parentId: null,
    labels: ["home"],
    priority: 3,
    completed: false,
    order: 0,
    due: null,
  };
  const taskState = writable({
    snapshot: {
      provider: "todoist",
      account: { id: "account", name: "Fixture", timezone: "UTC" },
      projects: [{ id: "home", name: "Home", order: 0 }],
      tasks: [providerTask],
      fetchedAt: "2031-01-01T06:00:00Z",
    },
  } as unknown as TaskBrowserState);
  const providerWrite = vi.fn();
  const tasks = {
    state: taskState,
    refresh: providerWrite,
    complete: providerWrite,
    update: providerWrite,
  } as unknown as TaskService;
  const scheduler = {
    plainCachedTask: vi.fn(() => ({
      raw: "- [ ] Water plants [link](https://app.todoist.com/app/task/task)",
      taskIds: ["task"],
    })),
  } as unknown as TaskScheduler;
  const settle = vi.fn();
  const preview = { begin: vi.fn((_name: string, _text: string) => settle) };
  const readCommitments = vi.fn(
    async (_startDate: string, _dayCount: number) => remoteBlocks,
  );
  const host = new ObsidianPlanningHost({
    plugin,
    daily: daily as unknown as PeriodicNotes,
    calendar: calendar as unknown as GoogleCalendarSync,
    tasks,
    scheduler: () => scheduler,
    settings: () => settings,
    range: () => ({ startDate: "2031-01-01", dayCount: 1 }),
    sourcePaths: () => [],
    commitments: readCommitments,
    preview,
  });
  return {
    host,
    files,
    identities,
    applyEdits,
    providerWrite,
    daily,
    remove,
    removeProjection,
    preview,
    settle,
    readCommitments,
    original,
  };
}

function draft(
  context: PlanningContext,
  kind: "move" | "schedule",
): PlanningDraft {
  const sourceRef =
    kind === "move"
      ? context.blocks[0]!.ref
      : context.tasks.find((task) => task.kind === "todoist")!.ref;
  const proposal = planningProposalSchema.parse({
    version: 1,
    contextId: context.id,
    actions: [
      {
        id: "action",
        kind,
        sourceRef,
        start: DateTime.fromISO("2031-01-01T10:00", {
          zone: context.timezone,
        }).toISO(),
        end: DateTime.fromISO("2031-01-01T10:30", {
          zone: context.timezone,
        }).toISO(),
      },
    ],
  });
  return {
    context,
    proposal,
    selectedIds: ["action"],
    acceptedIds: [],
    rejectedIds: [],
  };
}

async function apply(h: ReturnType<typeof fixture>, kind: "move" | "schedule") {
  const context = await h.host.context({});
  const prepared = vi.fn(async (receipt: PlanningReceipt) => {
    expect(h.applyEdits).not.toHaveBeenCalled();
    expect(receipt.phase).toBe("prepared");
  });
  const receipt = await h.host.apply(
    draft(context, kind),
    ["action"],
    null,
    prepared,
  );
  expect(prepared).toHaveBeenCalledOnce();
  return { ...receipt, phase: "applied" as const };
}

function commitment(date: string): WithDuration<RemoteTimeBlock> {
  return {
    id: "external-meeting",
    source: "ical",
    summary: "External meeting",
    startTime: window.moment(`${date}T10:00`),
    durationMinutes: 30,
    rsvpStatus: "ACCEPTED",
    calendar: { name: "Work", email: "", url: "", color: "#123456" },
  };
}

test("planning preview reads the requested calendar range while retaining cached tasks and zero writes", async () => {
  const h = fixture(false, [commitment("2031-01-02")]);
  const context = await h.host.context({
    dayCount: 2,
    request: "Plan tomorrow",
  });
  expect(context.documents[path]?.text).toBeNull();
  expect(context.documents["Daily/2031-01-02.md"]?.text).toBeNull();
  expect(h.readCommitments).toHaveBeenCalledExactlyOnceWith("2031-01-01", 2);
  expect(context.commitments).toEqual([
    expect.objectContaining({
      ref: "external-meeting",
      title: "External meeting",
    }),
  ]);
  expect(context.tasks).toEqual([
    expect.objectContaining({
      kind: "todoist",
      taskId: "task",
      accountId: "account",
      labels: ["home"],
    }),
  ]);
  expect(h.files.size).toBe(0);
  expect(h.daily.createDailyNoteIfNeeded).not.toHaveBeenCalled();
  expect(h.applyEdits).not.toHaveBeenCalled();
  expect(h.preview.begin).not.toHaveBeenCalled();
  expect(h.providerWrite).not.toHaveBeenCalled();
});

test("approved note move keeps its calendar identity and Undo restores the original", async () => {
  const h = fixture();
  const before = { ...h.identities[uid]! };
  const receipt = await apply(h, "move");
  expect(h.readCommitments).toHaveBeenCalledTimes(2);
  expect(h.readCommitments).toHaveBeenLastCalledWith("2031-01-01", 1);
  expect(receipt.batch.createdUids).toEqual([]);
  expect(Object.keys(receipt.batch.identities)).toEqual([uid]);
  expect(h.files.get(path)).toContain("10:00 - 10:30 Existing work");
  expect(h.identities[uid]?.raw).toContain("10:00 - 10:30");
  expect(h.settle).toHaveBeenLastCalledWith(true);
  const applied = h.files.get(path)!;
  h.files.set(path, applied + "\nManual edit");
  await expect(h.host.undo(receipt, async () => {})).rejects.toBeInstanceOf(
    PlanningUndoBlockedError,
  );
  expect(h.files.get(path)).toContain("Manual edit");
  expect(h.applyEdits).toHaveBeenCalledTimes(1);
  h.files.set(path, applied);
  const restored = vi.fn(async () => {});
  await h.host.undo(receipt, restored);
  expect(restored).toHaveBeenCalledOnce();
  expect(h.files.get(path)).toBe(h.original);
  expect(h.identities[uid]).toEqual(before);
  expect(h.providerWrite).not.toHaveBeenCalled();
});

test("applying refreshes requested-range commitments and rejects a newly occupied slot", async () => {
  const remote: Array<WithDuration<RemoteTimeBlock>> = [];
  const h = fixture(true, remote);
  const context = await h.host.context({});
  remote.push(commitment("2031-01-01"));
  await expect(
    h.host.apply(draft(context, "move"), ["action"], null, async () => {}),
  ).rejects.toThrow("overlaps");
  expect(h.readCommitments).toHaveBeenCalledTimes(2);
  expect(h.applyEdits).not.toHaveBeenCalled();
  expect(h.providerWrite).not.toHaveBeenCalled();
});

test("future daily notes use the normal template and Undo deletes the unchanged owned template", async () => {
  const h = fixture(false);
  const receipt = await apply(h, "schedule");
  expect(h.daily.createDailyNoteIfNeeded).toHaveBeenCalledOnce();
  expect(h.files.get(path)).toContain("Template journal prompt");
  expect(h.files.get(path)).toContain("10:00 - 10:30 Water plants");
  expect(receipt.createdTemplates).toEqual({ [path]: template });
  expect(receipt.batch.createdUids).toHaveLength(1);
  await h.host.undo(receipt, async () => {});
  expect(h.files.has(path)).toBe(false);
  expect(h.remove).toHaveBeenCalledWith({ path });
  expect(h.removeProjection).toHaveBeenCalledWith(
    receipt.batch.createdUids[0],
    expect.any(Object),
    path,
  );
  expect(h.providerWrite).not.toHaveBeenCalled();
});

test("cleanup retry preserves note edits made after notes were restored", async () => {
  const h = fixture(false);
  const receipt: PlanningReceipt = await apply(h, "schedule");
  h.removeProjection.mockRejectedValueOnce(
    new Error("Calendar temporarily unavailable"),
  );
  const onRestored = vi.fn(async () => {
    receipt.phase = "cleanup";
  });
  await expect(h.host.undo(receipt, onRestored)).rejects.toThrow(
    "Calendar temporarily unavailable",
  );
  expect(h.files.get(path)).toBe(template);
  const updated = template + "\nNew journal entry after Undo\n";
  h.files.set(path, updated);
  const writes = h.applyEdits.mock.calls.length;
  await h.host.undo(receipt, onRestored);
  expect(h.files.get(path)).toBe(updated);
  expect(h.applyEdits).toHaveBeenCalledTimes(writes);
  expect(h.remove).not.toHaveBeenCalled();
  expect(h.removeProjection).toHaveBeenCalledTimes(2);
  expect(h.providerWrite).not.toHaveBeenCalled();
});
