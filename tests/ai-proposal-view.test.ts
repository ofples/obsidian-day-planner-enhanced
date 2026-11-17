import { expect, test } from "vitest";

import type { PlanningDraft } from "../src/ai-scheduling/service";
import {
  planningContextSchema,
  planningProposalSchema,
} from "../src/ai-scheduling/types";
import { proposalOverlays } from "../src/ui/ai-proposal-view";

test("positions pending proposals by local day, clips the visible range and anchors frame children", () => {
  const context = planningContextSchema.parse({
    version: 1,
    id: "ctx",
    createdAt: "2031-01-01T00:00:00Z",
    timezone: "Asia/Kolkata",
    startDate: "2031-01-01",
    dayCount: 2,
    preferences: {},
    documents: {},
    commitments: [],
    freshness: {},
    tasks: [{ ref: "task", kind: "todoist", title: "Task", raw: "- [ ] Task" }],
    blocks: [
      {
        ref: "frame",
        uid: "a".repeat(32),
        path: "day.md",
        from: 0,
        raw: "- [ ] Frame #frame",
        title: "Frame",
        start: "2031-01-01T04:30:00Z",
        end: "2031-01-01T05:30:00Z",
      },
    ],
  });
  const proposal = planningProposalSchema.parse({
    version: 1,
    contextId: "ctx",
    actions: [
      {
        id: "move",
        kind: "move",
        sourceRef: "frame",
        start: "2031-01-01T02:00:00Z",
        end: "2031-01-01T03:00:00Z",
      },
      {
        id: "child",
        kind: "add-to-frame",
        sourceRef: "task",
        frameRef: "frame",
      },
      {
        id: "child2",
        kind: "add-to-frame",
        sourceRef: "task",
        frameRef: "frame",
      },
      {
        id: "later",
        kind: "schedule",
        sourceRef: "task",
        start: "2031-01-02T04:30:00Z",
        end: "2031-01-02T05:00:00Z",
      },
      {
        id: "done",
        kind: "schedule",
        sourceRef: "task",
        start: "2031-01-01T05:30:00Z",
        end: "2031-01-01T06:00:00Z",
      },
    ],
  });
  const draft: PlanningDraft = {
    context,
    proposal,
    selectedIds: ["move", "child"],
    acceptedIds: ["done"],
    rejectedIds: [],
  };
  expect(proposalOverlays(draft, "2031-01-01", 8, 12, 2)).toEqual([
    expect.objectContaining({ id: "move", top: 0, height: 60, selected: true }),
    expect.objectContaining({
      id: "child",
      top: 240,
      height: 120,
      selected: true,
    }),
    expect.objectContaining({ id: "child2", top: 264, selected: false }),
  ]);
  expect(
    proposalOverlays(draft, "2031-01-02", 8, 12, 2).map((item) => item.id),
  ).toEqual(["later"]);
  expect(proposalOverlays(null, "2031-01-01", 8, 12, 2)).toEqual([]);
});
