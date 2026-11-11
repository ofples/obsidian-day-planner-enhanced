import { z } from "zod";

import { taskSubtree } from "./browser";
import type { TaskRegistryState } from "./registry";
import { taskProjectionSchema } from "./schedule-types";
import { taskLinkSchema } from "./source";
import { taskSchema, type ProviderTask, type TaskSnapshot } from "./types";

/** Include known completed ancestors while retaining the authoritative active task fields. */
export function deletionTaskTree(
  snapshot: TaskSnapshot,
  root: ProviderTask,
  completed: ProviderTask[],
) {
  const tasks = new Map(
    [...completed, ...snapshot.tasks, root].map((task) => [task.id, task]),
  );
  const tree = taskSubtree(
    {
      ...snapshot,
      tasks: [...tasks.values()].map((task) => ({ ...task, completed: false })),
    },
    root,
  );
  return [root, ...tree.map((item) => tasks.get(item.task.id)!)];
}

export const taskDeletionSchema = z
  .object({
    id: z.uuid(),
    provider: z.string().min(1),
    accountId: z.string().min(1),
    taskId: z.string().min(1),
    tasks: z.array(taskSchema).min(1),
    links: z.record(z.string(), taskLinkSchema),
    projections: z.record(z.string(), taskProjectionSchema),
    phase: z.enum(["pending", "queued", "unlinking", "complete", "cancelled"]),
    createdAt: z.iso.datetime(),
    completedAt: z.iso.datetime().optional(),
    error: z.string().optional(),
  })
  .refine(
    (item) =>
      item.tasks[0]!.id === item.taskId &&
      new Set(item.tasks.map((task) => task.id)).size === item.tasks.length &&
      Object.values(item.links).every(
        (link) =>
          link.provider === item.provider &&
          link.accountId === item.accountId &&
          link.base?.id === link.taskId &&
          item.tasks.some((task) => task.id === link.taskId),
      ) &&
      Object.entries(item.projections).every(
        ([uid, projection]) =>
          projection.linkUid === uid &&
          projection.provider === item.provider &&
          projection.accountId === item.accountId &&
          projection.taskId === item.links[uid]?.taskId,
      ),
    {
      message:
        "Task deletion recovery belongs to its original account and task tree.",
    },
  );
export type TaskDeletionRecord = z.infer<typeof taskDeletionSchema>;

export function pendingTaskDeletion(
  state: Pick<TaskRegistryState, "deletions">,
  owner: { provider: string; accountId: string },
  taskId: string,
  exceptId?: string,
) {
  return Object.values(state.deletions).find(
    (item) =>
      item.id !== exceptId &&
      item.provider === owner.provider &&
      item.accountId === owner.accountId &&
      !["complete", "cancelled"].includes(item.phase) &&
      item.tasks.some((task) => task.id === taskId),
  );
}
