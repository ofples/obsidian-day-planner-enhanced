import { DateTime } from "luxon";
import { describe, expect, test } from "vitest";

import { taskDay, taskGroups, taskViewStateSchema } from "../src/tasks/browser";
import type { ProviderTask, TaskSnapshot } from "../src/tasks/types";

const task = (id: string, patch: Partial<ProviderTask> = {}): ProviderTask => ({
  id,
  title: id,
  description: "",
  projectId: "work",
  parentId: null,
  labels: [],
  priority: 1,
  completed: false,
  order: 1,
  due: null,
  ...patch,
});
const snapshot = (tasks: ProviderTask[]): TaskSnapshot => ({
  provider: "todoist",
  account: { id: "account", name: "Test account", timezone: "Asia/Kolkata" },
  projects: [{ id: "work", name: "Work", order: 1 }],
  tasks,
  fetchedAt: "2026-11-11T08:00:00Z",
});
const due = (date: string) => ({
  date,
  recurring: false,
  text: date,
  timezone: null,
});
const prefs = taskViewStateSchema.parse({});
const now = DateTime.fromISO("2026-11-10T20:00:00Z");

describe("task browser grouping", () => {
  test("date-only values and absolute instants use account day near midnight", () => {
    expect(
      taskDay(task("date", { due: due("2026-11-11") }), "America/Los_Angeles"),
    ).toBe("2026-11-11");
    expect(
      taskDay(
        task("time", { due: due("2026-11-10T20:00:00Z") }),
        "Asia/Kolkata",
      ),
    ).toBe("2026-11-11");
    const groups = taskGroups(
      snapshot([
        task("old", { due: due("2026-11-10") }),
        task("today", { due: due("2026-11-11") }),
        task("tomorrow", { due: due("2026-11-12") }),
        task("later", { due: due("2026-11-20") }),
        task("none"),
      ]),
      prefs,
      now,
    );
    expect(groups.map((group) => group.label)).toEqual([
      "Overdue",
      "Today",
      "Tomorrow",
      "Upcoming",
      "No date",
    ]);
  });
  test("a due child appears in its own day group with context, counted once", () => {
    const groups = taskGroups(
      snapshot([
        task("parent"),
        task("child", { parentId: "parent", due: due("2026-11-11") }),
      ]),
      prefs,
      now,
    );
    expect(groups.map((g) => [g.label, g.count])).toEqual([
      ["Today", 1],
      ["No date", 1],
    ]);
    expect(groups[0]?.rows.map((r) => [r.task.id, r.depth, r.context])).toEqual(
      [
        ["parent", 0, true],
        ["child", 1, false],
      ],
    );
    expect(groups[1]?.rows.map((r) => r.task.id)).toEqual(["parent"]);
  });
  test("search retains ancestor context and matches descriptions, projects and labels", () => {
    const data = snapshot([
      task("parent"),
      task("child", {
        parentId: "parent",
        labels: ["errands"],
        description: "Find screws",
      }),
    ]);
    for (const query of ["errands", "screws"]) {
      const groups = taskGroups(data, { ...prefs, query }, now);
      expect(groups[0]?.count).toBe(1);
      expect(groups[0]?.rows.map((r) => r.task.id)).toEqual([
        "parent",
        "child",
      ]);
    }
    expect(taskGroups(data, { ...prefs, query: "work" }, now)[0]?.count).toBe(
      1,
    );
    expect(taskGroups(data, { ...prefs, projectId: "missing" }, now)).toEqual(
      [],
    );
  });
  test("orphans and cycles remain accessible once and completed tasks are excluded", () => {
    const groups = taskGroups(
      snapshot([
        task("orphan", { parentId: "missing" }),
        task("a", { parentId: "b" }),
        task("b", { parentId: "a" }),
        task("done", { completed: true }),
      ]),
      prefs,
      now,
    );
    expect(groups[0]?.rows.map((r) => r.task.id).sort()).toEqual([
      "a",
      "b",
      "orphan",
    ]);
    expect(groups[0]?.count).toBe(2);
  });
  test("deep unfiltered trees resolve parent dates and visible ancestry with linear work", () => {
    const count = 2000;
    let reads = 0;
    const tasks = Array.from({ length: count }, (_, index) => {
      const value = task(String(index), { order: index });
      Object.defineProperty(value, "parentId", {
        get: () => {
          reads++;
          return index ? String(index - 1) : null;
        },
      });
      Object.defineProperty(value, "due", {
        get: () => {
          reads++;
          return index ? null : due("2026-11-11");
        },
      });
      return value;
    });
    const groups = taskGroups(snapshot(tasks), prefs, now);
    expect(
      groups.map((group) => [group.label, group.count, group.rows.length]),
    ).toEqual([["Today", 1, count]]);
    expect(reads).toBeLessThan(count * 20);
  });

  test("very deep trees use iterative traversal", () => {
    const tasks = Array.from({ length: 2000 }, (_, i) =>
      task(String(i), { parentId: i ? String(i - 1) : null, order: i }),
    );
    const groups = taskGroups(
      snapshot(tasks),
      { ...prefs, query: "1999" },
      now,
    );
    expect(groups[0]?.rows).toHaveLength(2000);
    expect(groups[0]?.count).toBe(1);
  });
  test("undated children stay with their dated parent and folding preserves the group count", () => {
    const data = snapshot([
      task("parent", { due: due("2026-11-11") }),
      task("child", { parentId: "parent" }),
    ]);
    const groups = taskGroups(data, prefs, now);
    expect(groups.map((g) => [g.label, g.count])).toEqual([["Today", 1]]);
    expect(groups[0]?.rows).toHaveLength(2);
    const folded = taskGroups(
      data,
      { ...prefs, collapsed: ["task:Today:parent"] },
      now,
    );
    expect(folded[0]?.count).toBe(1);
    expect(folded[0]?.rows.map((r) => r.task.id)).toEqual(["parent"]);
  });
});
