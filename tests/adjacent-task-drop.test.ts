import { expect, test } from "vitest";

import { defaultSettingsForTests } from "../src/settings";
import {
  adjacentTaskDropInterval,
  taskDropBoundary,
} from "../src/tasks/schedule-markdown";

test("uses the adjacent timed block and leaves a distant drop untimed", () => {
  const day = window.moment("2026-11-14", "YYYY-MM-DD");
  const settings = { ...defaultSettingsForTests, plannerHeading: "Plan" };
  const before = "# Plan\n\n- 09:00 - 10:00 Work\n\nFree text\n";
  const offset = before.indexOf("\n\nFree") + 1;
  const interval = adjacentTaskDropInterval(before, offset, day, settings, 30);
  expect(window.moment(interval?.start).format("HH:mm")).toBe("10:00");
  expect(window.moment(interval?.end).format("HH:mm")).toBe("10:30");
  expect(
    adjacentTaskDropInterval(
      before,
      before.indexOf("Free") + 2,
      day,
      settings,
      30,
    ),
  ).toBeNull();
  expect(
    adjacentTaskDropInterval(before, before.indexOf("Work"), day, settings, 30),
  ).toBeNull();
});

test("clamps drops to subtree boundaries and picks the previous slot before a block", () => {
  const day = window.moment("2026-11-14", "YYYY-MM-DD");
  const settings = { ...defaultSettingsForTests, plannerHeading: "Plan" };
  const text = "# Plan\n- 10:00 - 11:00 Parent\n  - [ ] Child\n";
  const start = text.indexOf("- 10:00");
  expect(taskDropBoundary(text, start + 1)).toBe(start);
  expect(taskDropBoundary(text, text.indexOf("Child"))).toBe(
    text.trimEnd().length,
  );
  const interval = adjacentTaskDropInterval(text, start, day, settings, 30);
  expect(window.moment(interval?.start).format("HH:mm")).toBe("09:30");
  expect(window.moment(interval?.end).format("HH:mm")).toBe("10:00");
});

test("recognizes timed neighbors outside the configured planner heading", () => {
  const text = "# Project\n- [ ] 10:00 - 10:30 Work\n";
  const interval = adjacentTaskDropInterval(
    text,
    text.length,
    window.moment("2026-11-14"),
    { ...defaultSettingsForTests, plannerHeading: "Day planner" },
    30,
  );
  expect(window.moment(interval?.start).format("HH:mm")).toBe("10:30");
});
