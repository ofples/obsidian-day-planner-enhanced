import { DateTime } from "luxon";
import { z } from "zod";

import type { ProviderTask, TaskSnapshot } from "./types";

export const taskViewStateSchema = z.object({
  groupBy: z.enum(["date", "project"]).default("date"),
  query: z.string().default(""),
  projectId: z.string().default(""),
  selectedId: z.string().nullable().default(null),
  collapsed: z.array(z.string()).default([]),
  source: z.enum(["todoist", "notes"]).optional(),
  showAdded: z.boolean().optional(),
  scannedNotePaths: z.array(z.string()).optional(),
});
export type TaskViewState = z.infer<typeof taskViewStateSchema>;

/** Shared iterative task forest for pane details and schedule export. */
export function taskSubtree(snapshot: TaskSnapshot, task: ProviderTask) {
  const rows =
    taskGroups(snapshot, {
      groupBy: "project",
      query: "",
      projectId: "",
      selectedId: null,
      collapsed: [],
    }).find((group) => group.id === task.projectId)?.rows ?? [];
  const root = rows.findIndex((row) => row.task.id === task.id);
  const depth = rows[root]?.depth ?? 0;
  const children: { task: ProviderTask; depth: number }[] = [];
  for (let index = root + 1; root >= 0 && index < rows.length; index++) {
    const row = rows[index]!;
    if (row.depth <= depth) break;
    children.push({ task: row.task, depth: row.depth - depth });
  }
  return children;
}

export interface TaskBrowserRow {
  task: ProviderTask;
  depth: number;
  context: boolean;
  hasChildren: boolean;
}
export interface TaskBrowserGroup {
  id: string;
  label: string;
  count: number;
  rows: TaskBrowserRow[];
}

export function taskDay(task: ProviderTask, timezone: string) {
  if (!task.due) return null;
  const value = task.due.date;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  return DateTime.fromISO(value, { zone: task.due.timezone ?? timezone })
    .setZone(timezone)
    .toISODate();
}

/** Build an iterative forest so bad parent data never causes recursion or hidden tasks. */
export function taskGroups(
  snapshot: TaskSnapshot,
  prefs: TaskViewState,
  now: DateTime = DateTime.now(),
  excludedIds: ReadonlySet<string> = new Set(),
): TaskBrowserGroup[] {
  const tasks = snapshot.tasks
    .filter((task) => !task.completed)
    .toSorted((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const projects = new Map(
    snapshot.projects.map((project) => [project.id, project]),
  );
  const query = prefs.query.toLocaleLowerCase().trim();
  const matching = new Set(
    tasks
      .filter(
        (task) =>
          !excludedIds.has(task.id) &&
          (!prefs.projectId || task.projectId === prefs.projectId) &&
          [
            task.title,
            task.description,
            projects.get(task.projectId)?.name ?? "",
            ...task.labels,
          ]
            .join(" ")
            .toLocaleLowerCase()
            .includes(query),
      )
      .map((task) => task.id),
  );
  const today = now.setZone(snapshot.account.timezone).toISODate() ?? "";
  const tomorrow = now
    .setZone(snapshot.account.timezone)
    .plus({ days: 1 })
    .toISODate();
  const dateGroups = ["Overdue", "Today", "Tomorrow", "Upcoming", "No date"];
  const datedGroups = new Map<string, string>();
  const groupFor = (task: ProviderTask) => {
    if (prefs.groupBy === "project") return task.projectId;
    const known = datedGroups.get(task.id);
    if (known) return known;
    const path: ProviderTask[] = [];
    const visited = new Set<string>();
    let dated: ProviderTask | undefined = task;
    while (
      dated &&
      !dated.due &&
      !datedGroups.has(dated.id) &&
      !visited.has(dated.id)
    ) {
      path.push(dated);
      visited.add(dated.id);
      dated = dated.parentId ? byId.get(dated.parentId) : undefined;
    }
    const day = dated ? taskDay(dated, snapshot.account.timezone) : null;
    const group =
      (dated && datedGroups.get(dated.id)) ||
      (!day
        ? "No date"
        : day < today
          ? "Overdue"
          : day === today
            ? "Today"
            : day === tomorrow
              ? "Tomorrow"
              : "Upcoming");
    for (const source of path) datedGroups.set(source.id, group);
    if (dated) datedGroups.set(dated.id, group);
    return group;
  };
  const groups = new Map<string, TaskBrowserGroup>();
  const children = new Map<string, ProviderTask[]>();
  for (const task of tasks) {
    if (task.parentId) {
      const siblings = children.get(task.parentId) ?? [];
      siblings.push(task);
      children.set(task.parentId, siblings);
    }
  }
  const matchingByGroup = new Map<string, Set<string>>();
  for (const task of tasks) {
    if (!matching.has(task.id)) continue;
    const groupId = groupFor(task);
    const ids = matchingByGroup.get(groupId) ?? new Set<string>();
    ids.add(task.id);
    matchingByGroup.set(groupId, ids);
  }
  for (const [groupId, ids] of matchingByGroup) {
    const visible = new Set(ids);
    for (const id of ids) {
      let task = byId.get(id);
      const visited = new Set([id]);
      while (task?.parentId && !visited.has(task.parentId)) {
        if (visible.has(task.parentId)) break;
        visited.add(task.parentId);
        task = byId.get(task.parentId);
        if (task) visible.add(task.id);
      }
    }
    const group: TaskBrowserGroup = {
      id: groupId,
      label:
        prefs.groupBy === "project"
          ? (projects.get(groupId)?.name ?? "Unavailable project")
          : groupId,
      count: 0,
      rows: [],
    };
    groups.set(groupId, group);
    const emitted = new Set<string>();
    const emit = (root: ProviderTask) => {
      const stack = [
        { task: root, depth: 0, hidden: false, countedAncestor: false },
      ];
      while (stack.length) {
        const entry = stack.pop()!;
        if (!visible.has(entry.task.id) || emitted.has(entry.task.id)) continue;
        emitted.add(entry.task.id);
        const matched = ids.has(entry.task.id);
        if (matched && !entry.countedAncestor) group.count++;
        const nested = (children.get(entry.task.id) ?? []).filter((task) =>
          visible.has(task.id),
        );
        if (!entry.hidden)
          group.rows.push({
            task: entry.task,
            depth: entry.depth,
            context: !matched,
            hasChildren: nested.length > 0,
          });
        const hidden =
          entry.hidden ||
          prefs.collapsed.includes(`task:${groupId}:${entry.task.id}`);
        for (const task of nested.toReversed())
          stack.push({
            task,
            depth: entry.depth + 1,
            hidden,
            countedAncestor: entry.countedAncestor || matched,
          });
      }
    };
    for (const task of tasks)
      if (!task.parentId || !byId.has(task.parentId)) emit(task);
    // Cycles have no natural root. Keep every remaining task accessible once.
    for (const task of tasks)
      if (!emitted.has(task.id) && visible.has(task.id)) emit(task);
  }
  return [...groups.values()]
    .filter((group) => group.rows.length)
    .toSorted((a, b) =>
      prefs.groupBy === "date"
        ? dateGroups.indexOf(a.id) - dateGroups.indexOf(b.id)
        : (projects.get(a.id)?.order ?? Infinity) -
            (projects.get(b.id)?.order ?? Infinity) ||
          a.label.localeCompare(b.label),
    );
}
