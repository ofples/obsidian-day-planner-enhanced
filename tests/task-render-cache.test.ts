import { describe, expect, test } from "vitest";

import { taskGroups, taskViewStateSchema } from "../src/tasks/browser";
import type { ProviderTask, TaskSnapshot } from "../src/tasks/types";
import { TaskRenderCache } from "../src/ui/task-render-cache";

const task = (
  id: string,
  parentId: string | null,
  order: number,
): ProviderTask => ({
  id,
  title: id,
  parentId,
  order,
  projectId: "p",
  description: "",
  labels: [],
  priority: 1,
  completed: false,
  due: null,
});
const snapshot = (tasks: ProviderTask[]): TaskSnapshot => ({
  provider: "test",
  account: { id: "a", name: "A", timezone: "UTC" },
  projects: [{ id: "p", name: "P", order: 1 }],
  tasks,
  fetchedAt: "2026-01-01T00:00:00Z",
});
const prefs = taskViewStateSchema.parse({ groupBy: "project" });
const logical = (data: TaskSnapshot, query = "", collapsed: string[] = []) =>
  taskGroups(data, { ...prefs, query, collapsed });

describe("task render cache", () => {
  test("starts with only shown rows and retains only previously mounted rows across filtering and folding", () => {
    const data = snapshot([
      task("parent", null, 0),
      task("child", "parent", 1),
      task("other", null, 2),
    ]);
    const complete = logical(data),
      cache = new TaskRenderCache();
    expect(
      cache
        .project("a", complete, logical(data, "child"), [])[0]
        ?.rows.map((r) => [r.row.task.id, r.hidden]),
    ).toEqual([
      ["parent", false],
      ["child", false],
    ]);
    expect(cache.project("a", complete, complete, [])[0]?.rows).toHaveLength(3);
    const folded = logical(data, "", ["task:p:parent"]);
    expect(
      cache
        .project("a", complete, folded, [])[0]
        ?.rows.map((r) => [r.row.task.id, r.hidden]),
    ).toEqual([
      ["parent", false],
      ["child", true],
      ["other", false],
    ]);
    expect(
      cache
        .project("a", complete, complete, [])[0]
        ?.rows.every((r) => !r.hidden),
    ).toBe(true);
  });

  test("uses canonical visible ordering and metadata even when cyclic roots change", () => {
    const data = snapshot([
      task("descendant", "a", 0),
      task("a", "b", 1),
      task("b", "a", 2),
    ]);
    const complete = logical(data),
      cache = new TaskRenderCache();
    cache.project("a", complete, complete, []);
    const filtered = logical(data, "b");
    const result = cache
      .project("a", complete, filtered, [])[0]!
      .rows.filter((r) => !r.hidden)
      .map((r) => r.row);
    expect(result).toEqual(filtered[0]!.rows);
  });

  test("falls back to visible canonical order if it differs from the complete forest", () => {
    const data = snapshot([
      task("a", null, 0),
      task("b", null, 1),
      task("c", null, 2),
    ]);
    const complete = logical(data),
      cache = new TaskRenderCache();
    cache.project("a", complete, complete, []);
    const group = complete[0]!;
    const reordered = [
      {
        ...group,
        rows: [group.rows[2]!, { ...group.rows[0]!, context: true }],
      },
    ];
    const rows = cache.project("a", complete, reordered, [])[0]!.rows;
    expect(rows.map((r) => [r.row.task.id, r.hidden])).toEqual([
      ["c", false],
      ["a", false],
      ["b", true],
    ]);
    expect(rows[1]?.row.context).toBe(true);
  });

  test("keeps duplicate ancestor keys separate across project groups and uses filtered context", () => {
    const data = snapshot([
      task("parent", null, 0),
      { ...task("child", "parent", 1), projectId: "q" },
    ]);
    data.projects.push({ id: "q", name: "Q", order: 2 });
    const complete = logical(data),
      cache = new TaskRenderCache();
    cache.project("a", complete, complete, []);
    const filtered = logical(data, "child");
    const result = cache.project("a", complete, filtered, []);
    expect(
      result
        .find((g) => g.id === "q")
        ?.rows.filter((r) => !r.hidden)
        .map((r) => r.row),
    ).toEqual(filtered[0]?.rows);
    expect(result.find((g) => g.id === "q")?.rows[0]?.row.context).toBe(true);
    expect(result.find((g) => g.id === "p")?.rows[0]?.hidden).toBe(true);
    const moved = snapshot([
      task("parent", null, 0),
      task("child", "parent", 1),
    ]);
    expect(
      cache
        .project("a", logical(moved), logical(moved), [])
        .some((g) => g.id === "q"),
    ).toBe(false);
  });

  test("prunes removed or moved rows and resets on account or grouping scope change", () => {
    const data = snapshot([task("a", null, 0), task("b", null, 1)]),
      cache = new TaskRenderCache();
    cache.project("account:project", logical(data), logical(data), []);
    const changed = snapshot([task("a", null, 0)]);
    expect(
      cache
        .project("account:project", logical(changed), [], [])[0]
        ?.rows.map((r) => r.row.task.id),
    ).toEqual(["a"]);
    expect(
      cache
        .project("other:project", logical(data), logical(data, "a"), [])[0]
        ?.rows.map((r) => r.row.task.id),
    ).toEqual(["a"]);
    expect(cache.project("other:date", logical(data), [], [])).toEqual([]);
  });
});
