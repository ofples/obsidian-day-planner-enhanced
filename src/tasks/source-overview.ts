import { taskSourceKey, taskSourceReference } from "./source-references";
import type { TaskSourceReference } from "./source-types";
import type { ProviderTask, TaskSnapshot } from "./types";

export interface OverviewOrigin {
  snapshot: TaskSnapshot;
  task: ProviderTask;
  reference: TaskSourceReference;
}

/** Qualified render IDs only; actions always use the original cached task. */
export function taskSourceOverview(snapshots: readonly TaskSnapshot[]) {
  const origins = new Map<string, OverviewOrigin>();
  const tasks: ProviderTask[] = [];
  const projects: TaskSnapshot["projects"] = [];
  for (const snapshot of snapshots) {
    const projectKey = (id: string) =>
      JSON.stringify([snapshot.provider, snapshot.account.id, id]);
    projects.push(
      ...snapshot.projects.map((project) => ({
        ...project,
        id: projectKey(project.id),
      })),
    );
    const key = (itemId: string) =>
      taskSourceKey({
        provider: snapshot.provider,
        accountId: snapshot.account.id,
        itemId,
      });
    for (const task of snapshot.tasks) {
      const reference = taskSourceReference(snapshot, task);
      const id = taskSourceKey(reference);
      origins.set(id, { snapshot, task, reference });
      tasks.push({
        ...task,
        id,
        projectId: projectKey(task.projectId),
        parentId: task.parentId ? key(task.parentId) : null,
      });
    }
  }
  const snapshot: TaskSnapshot | null = snapshots.length
    ? {
        provider: "overview",
        account: {
          id: "overview",
          name: "Connected sources",
          timezone: snapshots[0]!.account.timezone,
        },
        tasks,
        projects,
        fetchedAt: snapshots.map((item) => item.fetchedAt).sort()[0]!,
      }
    : null;
  return { snapshot, origins };
}
