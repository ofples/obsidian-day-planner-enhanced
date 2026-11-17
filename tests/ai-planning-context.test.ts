import { expect, test, vi } from "vitest";

import {
  buildPlanningContext,
  publicPlanningContext,
} from "../src/ai-scheduling/context";
import { defaultSettingsForTests } from "../src/settings";

function input() {
  return {
    id: "planning-request",
    createdAt: "2026-11-18T06:00:00Z",
    timezone: "UTC",
    startDate: "2026-11-18",
    dayCount: 2,
    request: "Prepare my day",
    preferences: {
      startHour: 8,
      endHour: 20,
      defaultDurationMinutes: 30,
      instructions: "Keep lunch free",
    },
    documents: {
      "Daily/2026-11-18.md": {
        date: "2026-11-18",
        text: "# Day planner\n\n- [ ] 09:00 - 10:00 Fixed work #locked\n  - [ ] Inside schedule\n- [ ] Prepare outline #work\n  - [ ] Read draft\n- [x] Completed task\n\nPersonal journal paragraph",
      },
      "Daily/2026-11-19.md": { date: "2026-11-19", text: null },
    },
    providerTasks: [
      {
        kind: "todoist" as const,
        title: "Water plants",
        raw: "- [ ] Water plants [link](https://app.todoist.com/app/task/abc)",
        taskId: "abc",
        accountId: "account",
        provider: "todoist",
        priority: 4,
        due: "2026-11-18",
        labels: ["home"],
      },
    ],
    commitments: [
      {
        ref: "calendar-1",
        title: "Appointment",
        start: "2026-11-18T12:00:00Z",
        end: "2026-11-18T13:00:00Z",
        allDay: false,
      },
    ],
    identities: {},
    settings: defaultSettingsForTests,
    allocateUid: vi.fn(() => "a".repeat(32)),
  };
}

test("context reuses note hierarchy, pending daily notes and cached provider metadata", () => {
  const context = buildPlanningContext(input());
  expect(context.blocks).toHaveLength(1);
  expect(context.blocks[0]?.raw).toContain("#locked");
  expect(context.tasks.map((task) => task.title)).toEqual([
    "Prepare outline",
    "Read draft",
    "Water plants",
  ]);
  expect(context.tasks.at(-1)).toMatchObject({
    priority: 4,
    due: "2026-11-18",
    taskId: "abc",
  });
  expect(context.documents["Daily/2026-11-19.md"]?.text).toBeNull();
  expect(context.commitments).toHaveLength(1);
  const publicContext = publicPlanningContext(context);
  expect(publicContext).not.toHaveProperty("documents");
  expect(JSON.stringify(publicContext)).not.toContain(
    "Personal journal paragraph",
  );
});

test("known calendar identity survives context generation without an allocation", () => {
  const first = buildPlanningContext(input()),
    block = first.blocks[0]!;
  const next = input();
  next.identities = {
    [block.uid]: {
      path: block.path,
      from: block.from,
      raw: block.raw,
      snapshot: { title: block.title, start: block.start, end: block.end },
    },
  };
  expect(buildPlanningContext(next).blocks[0]?.uid).toBe(block.uid);
  next.documents["Daily/2026-11-18.md"]!.text =
    "Updated introduction\n" + next.documents["Daily/2026-11-18.md"]!.text;
  expect(buildPlanningContext(next).blocks[0]?.uid).toBe(block.uid);
  expect(next.allocateUid).not.toHaveBeenCalled();
});

test("large cached task sets have a visible bounded snapshot", () => {
  const data = input();
  data.documents = {
    "Daily/2026-11-18.md": { date: "2026-11-18", text: "" },
    "Daily/2026-11-19.md": { date: "2026-11-19", text: null },
  };
  data.providerTasks = Array.from({ length: 510 }, (_, index) => ({
    ...data.providerTasks[0]!,
    taskId: String(index),
  }));
  const context = buildPlanningContext(data);
  expect(context.tasks).toHaveLength(500);
  expect(new Set(context.tasks.map((task) => task.ref)).size).toBe(500);
  expect(context.freshness).toMatchObject({ taskCount: 510, truncated: true });
});

test("locked ancestors and descendants remain protected in the task snapshot", () => {
  const data = input();
  data.documents["Daily/2026-11-18.md"]!.text =
    "- [ ] Parent #locked\n  - [ ] Child\n- [ ] Another parent\n  - [ ] Locked child #locked";
  const context = buildPlanningContext(data);
  expect(
    context.tasks
      .filter((task) => task.kind === "note")
      .every((task) => task.locked),
  ).toBe(true);
});
