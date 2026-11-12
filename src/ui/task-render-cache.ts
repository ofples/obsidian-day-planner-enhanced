import type { TaskBrowserGroup, TaskBrowserRow } from "../tasks/browser";

export interface RenderedTaskRow {
  row: TaskBrowserRow;
  hidden: boolean;
}

export interface RenderedTaskGroup {
  id: string;
  group?: TaskBrowserGroup;
  rows: RenderedTaskRow[];
}

/** Retains only previously visible rows; canonical groups remain authoritative. */
export class TaskRenderCache {
  private scope = "";
  private readonly mounted = new Map<string, Set<string>>();

  project(
    scope: string,
    complete: TaskBrowserGroup[],
    visible: TaskBrowserGroup[],
    collapsed: string[],
  ): RenderedTaskGroup[] {
    if (scope !== this.scope) {
      this.scope = scope;
      this.mounted.clear();
    }
    const completeById = new Map(complete.map((group) => [group.id, group]));
    const visibleById = new Map(visible.map((group) => [group.id, group]));
    for (const [id, mounted] of this.mounted) {
      const available = new Set(
        completeById.get(id)?.rows.map((row) => row.task.id),
      );
      for (const taskId of mounted)
        if (!available.has(taskId)) mounted.delete(taskId);
      if (!mounted.size) this.mounted.delete(id);
    }
    const ids = [
      ...visible.map((group) => group.id),
      ...complete
        .map((group) => group.id)
        .filter((id) => !visibleById.has(id) && this.mounted.has(id)),
    ];
    return ids.map((id) => {
      const group = visibleById.get(id);
      const shown = group && !collapsed.includes(id) ? group.rows : [];
      let mounted = this.mounted.get(id);
      if (!mounted) this.mounted.set(id, (mounted = new Set()));
      for (const row of shown) mounted.add(row.task.id);
      const shownById = new Map(shown.map((row) => [row.task.id, row]));
      const retained =
        completeById.get(id)?.rows.filter((row) => mounted.has(row.task.id)) ??
        [];
      let nextShown = 0;
      for (const row of retained) {
        if (!shownById.has(row.task.id)) continue;
        if (shown[nextShown]?.task.id !== row.task.id) break;
        nextShown++;
      }
      if (nextShown === shown.length) {
        return {
          id,
          group,
          rows: retained.map((row) => ({
            row: shownById.get(row.task.id) ?? row,
            hidden: !shownById.has(row.task.id),
          })),
        };
      }
      const hidden = retained.filter((row) => !shownById.has(row.task.id));
      return {
        id,
        group,
        rows: [
          ...shown.map((row) => ({ row, hidden: false })),
          ...hidden.map((row) => ({ row, hidden: true })),
        ],
      };
    });
  }
}
