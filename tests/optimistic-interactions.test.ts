import { get } from "svelte/store";
import { describe, expect, test } from "vitest";

import { makeStore } from "../src/redux/store";
import { DailyNoteExtensionService } from "../src/service/index/extensions/daily-note-extension-service";
import { ListItemIndexService } from "../src/service/index/list-item-index-service";
import type { PeriodicNotes } from "../src/service/periodic-notes";
import { defaultSettings } from "../src/settings";
import { OptimisticNoteEdits } from "../src/service/optimistic-note-edits";
import {
  TaskDropFeedback,
  withPendingDrops,
  type PendingDrop,
} from "../src/tasks/drop-feedback";
import type { PlanTimeBlock } from "../src/time-block-types";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const interval = { start: "2030-01-01T09:00:00Z", end: "2030-01-01T09:30:00Z" };
function drop(id: string): PendingDrop {
  return {
    id,
    raw: `- [ ] ${id}\n  A description\n  - [ ] Child`,
    taskIds: [id],
    destination: { interval },
    targetPath: "2030-01-01.md",
  };
}
function persisted(id: string): PlanTimeBlock {
  return {
    id: "real-" + id,
    source: "dailyNoteDate",
    path: "2030-01-01.md",
    text: `09:00 - 09:30 ${id}`,
    symbol: "-",
    task: " ",
    position: {
      start: { line: 0, col: 0, offset: 0 },
      end: { line: 0, col: 20, offset: 20 },
    },
    startTime: window.moment(interval.start),
    durationMinutes: 30,
  };
}

describe("optimistic drops", () => {
  test("appears synchronously, retains descriptions and children, and rolls back only the failed drop", async () => {
    const feedback = new TaskDropFeedback();
    const first = deferred<void>(),
      second = deferred<void>();
    const savingFirst = feedback.run(drop("First"), () => first.promise);
    const savingSecond = feedback.run(drop("Second"), () => second.promise);
    expect(
      withPendingDrops([], get(feedback.state)).map((block) => block.text),
    ).toEqual([
      "First\nA description\n- [ ] Child",
      "Second\nA description\n- [ ] Child",
    ]);
    expect(
      withPendingDrops([], get(feedback.state))[0]!.children?.[0]?.text,
    ).toBe("Child");
    first.reject(new Error("Disk full"));
    await expect(savingFirst).rejects.toThrow("Disk full");
    expect(get(feedback.state).map((item) => item.id)).toEqual(["Second"]);
    second.resolve();
    await savingSecond;
  });

  test("keeps the preview through metadata lag and removes it after the saved source is indexed", async () => {
    const feedback = new TaskDropFeedback();
    const source = {
      path: "2030-01-01.md",
      from: 0,
      raw: "- [ ] 09:00 - 09:30 Work",
      title: "Work",
    };
    await feedback.run(drop("Work"), async () => source);
    expect(get(feedback.state)).toHaveLength(1);
    expect(
      withPendingDrops([persisted("Work")], get(feedback.state)),
    ).toHaveLength(1);
    feedback.reconcile([persisted("Work")]);
    expect(get(feedback.state)).toEqual([]);
  });

  test("handles indexing before the delivery receipt arrives", async () => {
    const feedback = new TaskDropFeedback();
    const source = {
      path: "2030-01-01.md",
      from: 0,
      raw: "- [ ] 09:00 - 09:30 Work",
      title: "Work",
    };
    const pending = deferred<typeof source>();
    const saving = feedback.run(drop("Work"), () => pending.promise);
    feedback.reconcile([persisted("Work")]);
    pending.resolve(source);
    await saving;
    expect(get(feedback.state)).toEqual([]);
  });

  test("nesting updates the parent immediately and failure restores its original children", async () => {
    const feedback = new TaskDropFeedback();
    const parent = persisted("Frame #frame"),
      pending = deferred<void>();
    const intent = {
      ...drop("Child"),
      destination: {
        parent: { path: parent.path, line: 0, text: parent.text },
      },
    };
    const saving = feedback.run(intent, () => pending.promise);
    expect(
      withPendingDrops([parent], get(feedback.state))[0]!.children?.[0]?.text,
    ).toContain("Child");
    pending.reject(new Error("Failed"));
    await expect(saving).rejects.toThrow("Failed");
    expect(withPendingDrops([parent], get(feedback.state))).toEqual([parent]);
  });
});

test("failed older note edits cannot remove a newer preview or mutate the canonical index", () => {
  const store = makeStore({});
  const feedback = new OptimisticNoteEdits([], store.getState);
  const before = store.getState();
  const settleFirst = feedback.begin("day.md", "- [ ] First");
  feedback.begin("day.md", "- [ ] Second");
  settleFirst(false);
  expect(get(feedback.state).map((item) => item.text)).toEqual([
    "- [ ] Second",
  ]);
  feedback.blocks(before, get(feedback.state));
  expect(store.getState()).toBe(before);
});

test("note previews use normal parsing for timestamps, descriptions and nested tasks", () => {
  const store = makeStore({
    preloadedState: { dateRanges: { ranges: { test: ["2030-01-01"] } } },
  });
  const daily = {
    getDateFromPath: () => window.moment("2030-01-01"),
  } as unknown as PeriodicNotes;
  const indexer = new ListItemIndexService([
    new DailyNoteExtensionService(daily, {
      ...defaultSettings,
      plannerHeading: "",
    }),
  ]);
  const feedback = new OptimisticNoteEdits([indexer], store.getState);
  const settle = feedback.begin(
    "2030-01-01.md",
    "- [x] 09:00 - 09:30 Frame #locked\n  Description\n  - [ ] Child",
  );
  const blocks = feedback.blocks(store.getState(), get(feedback.state));
  expect(blocks[0]?.startTime.format("HH:mm")).toBe("09:00");
  expect(blocks[0]?.task).toBe("x");
  expect(blocks[0]?.text).toBe("09:00 - 09:30 Frame #locked\nDescription");
  expect(blocks[0]?.position.end.line).toBe(1);
  expect(blocks[0]?.children?.[0]?.text).toBe("Child");
  settle(false);
  expect(feedback.blocks(store.getState(), get(feedback.state))).toEqual([]);
});
