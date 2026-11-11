import { describe, expect, test } from "vitest";

import { parseCaptureCandidates } from "../src/tasks/capture-parser";
import {
  taskCaptureSettingsSchema,
  taskAccountKey,
} from "../src/tasks/capture-settings";
import { planTaskReconciliation } from "../src/tasks/reconcile";
import {
  rewriteTaskNote,
  withoutTaskCaptureTag,
  withTaskCaptureTag,
} from "../src/tasks/reconcile-markdown";
import type { ProviderTask, TaskSnapshot } from "../src/tasks/types";

const task: ProviderTask = {
  id: "task",
  title: "Task",
  description: "Keep",
  projectId: "work",
  parentId: null,
  labels: [],
  priority: 1,
  completed: false,
  order: 1,
  due: null,
};
const snapshot: TaskSnapshot = {
  provider: "todoist",
  account: { id: "account", name: "Test", timezone: "UTC" },
  projects: [
    { id: "work", name: "Work", order: 1 },
    { id: "other", name: "Other", order: 2 },
  ],
  tasks: [task],
  fetchedAt: "2026-11-11T00:00:00Z",
};
const account = {
  defaultProjectId: "work",
  projectMappings: { work: "work", other: "other" },
  labelMappings: { errand: "Errand" },
};
function plan(before: string, after: string, remote = task) {
  const original = parseCaptureCandidates("Tasks.md", before)[0]!;
  const candidate = parseCaptureCandidates("Tasks.md", after)[0]!;
  const settings = taskCaptureSettingsSchema.parse({
    accounts: { [taskAccountKey(snapshot)]: account },
  });
  return planTaskReconciliation({
    link: {
      provider: "todoist",
      accountId: "account",
      taskId: task.id,
      base: task,
      source: candidate,
      noteBase: original,
    },
    candidate,
    remote,
    snapshot: { ...snapshot, tasks: [remote] },
    settings,
  });
}

describe("linked note field reconciliation", () => {
  test("keeping a link restores its original capture-tag placement when other bytes match", () => {
    const original =
      "- [ ] Task #ToDoIsT #work <!-- keep --> ^native\r\n  - [ ] Child #todoist";
    expect(withTaskCaptureTag(withoutTaskCaptureTag(original), original)).toBe(
      original,
    );
  });

  test("capture-tag restoration preserves changed titles, native IDs and child bytes", () => {
    const raw =
      "- [ ] Edited **task** #work <!-- keep --> ^native\r\n  - [ ] Child #todoist";
    expect(withTaskCaptureTag(raw, "- [ ] Original #todoist #work")).toBe(
      raw.replace(" #work", " #todoist #work"),
    );
    expect(withTaskCaptureTag("- [ ] Task ^native  ")).toBe(
      "- [ ] Task #todoist ^native  ",
    );
    expect(withTaskCaptureTag("- [ ] Task `#todoist`  ")).toBe(
      "- [ ] Task `#todoist` #todoist  ",
    );
  });
  test("unlink removes the parsed parent opt-in and preserves comments, code and nested tags", () => {
    const raw =
      "- [ ] **Task** #ToDoIsT #keep <!-- #todoist --> `#todoist` ^native\r\n  - [ ] Child #todoist";
    expect(withoutTaskCaptureTag(raw)).toBe(raw.replace(" #ToDoIsT", ""));
  });

  test("unlink removes repeated capture tags while retaining longer project tags", () => {
    expect(
      withoutTaskCaptureTag("- [ ] Task #todoist #todoist/work #todoist"),
    ).toBe("- [ ] Task #todoist/work");
    expect(withoutTaskCaptureTag("- [ ] Task #work")).toBe("- [ ] Task #work");
    expect(() => withoutTaskCaptureTag("Changed paragraph")).toThrow(
      "checklist",
    );
  });
  test("a changed project tag uses a project move while preserving unmapped provider labels", () => {
    const result = plan(
      "- [ ] Task #todoist #work",
      "- [ ] Task #todoist #other #errand",
      { ...task, labels: ["Provider only"] },
    );
    expect(result.conflicts).toEqual([]);
    expect(result.mutations.map((step) => step.mutation)).toEqual([
      { kind: "moveProject", taskId: task.id, projectId: "other" },
      {
        kind: "update",
        taskId: task.id,
        changes: { labels: ["Provider only", "Errand"] },
      },
    ]);
    expect(result.mutations[1]?.base.projectId).toBe("other");
  });

  test("independent mapped label edits merge with provider-only label changes", () => {
    const result = plan(
      "- [ ] Task #todoist #work",
      "- [ ] Task #todoist #work #errand",
      { ...task, labels: ["Remote added"] },
    );
    expect(result.conflicts).toEqual([]);
    expect(result.mutations[0]?.mutation).toMatchObject({
      changes: { labels: ["Remote added", "Errand"] },
    });
  });

  test("routing configuration changes alone preserve note title and tags", () => {
    const raw = "- [ ] Task #errand #todoist #work";
    const result = plan(raw, raw, { ...task, title: "Task #errand" });
    // The provider baseline includes the previously literal tag.
    const candidate = parseCaptureCandidates("Tasks.md", raw)[0]!;
    const settings = taskCaptureSettingsSchema.parse({
      accounts: { [taskAccountKey(snapshot)]: account },
    });
    const stable = planTaskReconciliation({
      link: {
        provider: "todoist",
        accountId: "account",
        taskId: task.id,
        base: { ...task, title: "Task #errand" },
        source: candidate,
        noteBase: candidate,
      },
      candidate,
      remote: { ...task, title: "Task #errand" },
      snapshot,
      settings,
    });
    expect(stable.raw).toBe(raw);
    expect(stable.mutations).toEqual([]);
    expect(stable.changed).toBe(false);
    expect(result.conflicts).toEqual([]);
  });

  test("an unscheduled task's remote date remains metadata until scheduled explicitly", () => {
    const result = plan(
      "- [ ] Task #todoist #work",
      "- [ ] Task #todoist #work",
      {
        ...task,
        due: { date: "2026-11-13", text: "", recurring: false, timezone: null },
      },
    );
    expect(result.interval).toBeNull();
    expect(result.mutations).toEqual([]);
    expect(result.changed).toBe(false);
  });

  test("remote text changes retain local tags, comments, native IDs and CRLF child bytes", () => {
    const raw =
      "- [ ] 08:00 - 08:30 **Task** #todoist #work #local <!-- keep --> ^native\r\n  - [ ] [[Child]] ^child";
    const rewritten = rewriteTaskNote(
      raw,
      { ...task, title: "Remote #todoist", completed: true },
      account,
      ["title", "completed"],
    );
    expect(rewritten).toContain(
      "08:00 - 08:30 Remote \\#todoist #todoist #work #local <!-- keep --> ^native",
    );
    expect(rewritten).toContain("- [x]");
    expect(rewritten.split("\r\n").slice(1)).toEqual(
      raw.split("\r\n").slice(1),
    );
    expect(
      rewriteTaskNote(
        raw,
        { ...task, projectId: "other", labels: ["Errand"] },
        account,
        ["projectId", "labels"],
      ),
    ).toContain("**Task**");
  });

  test("recurring checkbox changes pause for occurrence-aware handling", () => {
    const result = plan(
      "- [ ] Task #todoist #work",
      "- [x] Task #todoist #work",
      {
        ...task,
        due: {
          date: "2026-11-12",
          text: "every day",
          recurring: true,
          timezone: null,
        },
      },
    );
    // A recurring baseline is checked separately from a newly added provider rule.
    const candidate = parseCaptureCandidates(
      "Tasks.md",
      "- [x] Task #todoist #work",
    )[0]!;
    const before = parseCaptureCandidates(
      "Tasks.md",
      "- [ ] Task #todoist #work",
    )[0]!;
    const recurring = {
      ...task,
      due: {
        date: "2026-11-12",
        text: "every day",
        recurring: true,
        timezone: null,
      },
    };
    const guarded = planTaskReconciliation({
      link: {
        provider: "todoist",
        accountId: "account",
        taskId: task.id,
        base: recurring,
        source: candidate,
        noteBase: before,
      },
      candidate,
      remote: recurring,
      snapshot,
      settings: taskCaptureSettingsSchema.parse({
        accounts: { [taskAccountKey(snapshot)]: account },
      }),
    });
    expect(guarded.conflicts).toContain("recurrence");
    expect(result.interval).toBeNull();
  });
});
