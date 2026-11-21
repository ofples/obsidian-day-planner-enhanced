import { expect, test } from "vitest";

import type { PlanTimeBlock } from "../src/time-block-types";
import { TimelineRenderKeys } from "../src/ui/timeline-render-keys";

function block(title: string, line: number, hour = 9): PlanTimeBlock {
  return {
    id: `daily:${line}`,
    source: "dailyNoteDate",
    path: "Daily/test.md",
    text: `${hour}:00 - ${hour}:30 ${title}`,
    symbol: "-",
    task: " ",
    position: {
      start: { line, col: 0, offset: 0 },
      end: { line, col: 20, offset: 20 },
    },
    startTime: window.moment().startOf("day").hour(hour),
    durationMinutes: 30,
  };
}

test("inserting a child does not remount the frame or later line-shifted blocks", () => {
  const keys = new TimelineRenderKeys<PlanTimeBlock>();
  const before = keys.project([
    block("Frame #frame", 1),
    block("Later", 2, 10),
  ]);
  const after = keys.project([block("Frame #frame", 1), block("Later", 3, 10)]);
  expect(after.map((row) => row.key)).toEqual(before.map((row) => row.key));
});

test("a new block cannot steal the view belonging to a shifted existing block", () => {
  const keys = new TimelineRenderKeys<PlanTimeBlock>();
  const [old] = keys.project([block("Existing", 1, 10)]);
  const [created, shifted] = keys.project([
    block("New", 1),
    block("Existing", 2, 10),
  ]);
  expect(shifted!.key).toBe(old!.key);
  expect(created!.key).not.toBe(old!.key);
});

test("optimistic and indexed blocks keep their painted view; equal titles remain separate", () => {
  const keys = new TimelineRenderKeys<PlanTimeBlock>();
  const first = block("Same", 1);
  const second = { ...block("Same", 2), id: "optimistic:drop" };
  const before = keys.project([first, second]);
  const after = keys.project([first, block("Same", 8)]);
  expect(after.map((row) => row.key)).toEqual(before.map((row) => row.key));
  expect(new Set(after.map((row) => row.key)).size).toBe(2);
});
