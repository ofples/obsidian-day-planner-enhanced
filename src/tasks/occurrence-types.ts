import { z } from "zod";

import { deletionTaskTree } from "./deletion-types";
import type { TaskOperation } from "./operations";
import type { TaskRegistryState } from "./registry";
import { taskProjectionSchema } from "./schedule-types";
import { taskLinkSchema } from "./source";
import { taskSchema, type TaskSnapshot } from "./types";

const occurrenceSourcesSchema = z.object({
  links: z.record(z.string(), taskLinkSchema),
  projections: z.record(z.string(), taskProjectionSchema),
});
export const taskOccurrenceSchema = z
  .object({
    id: z.uuid(),
    provider: z.string().min(1),
    accountId: z.string().min(1),
    before: occurrenceSourcesSchema.extend({
      task: taskSchema,
      children: z.array(taskSchema),
    }),
    next: taskSchema.optional(),
    links: z.record(z.string(), taskLinkSchema),
    projections: z.record(z.string(), taskProjectionSchema),
    phase: z.enum(["pending", "freezing", "complete", "cancelled", "undone"]),
    recovered: z.boolean(),
    requestedAt: z.iso.datetime(),
    verifiedAt: z.iso.datetime().optional(),
    error: z.string().optional(),
  })
  .refine(
    (record) => {
      const task = record.before.task;
      const ids = new Set([
        task.id,
        ...record.before.children.map((child) => child.id),
      ]);
      const sources = [record.before, record];
      return (
        task.due?.recurring === true &&
        ids.size === record.before.children.length + 1 &&
        task.completionCount !== undefined &&
        (!record.next ||
          (record.next.id === task.id &&
            record.next.completionCount === task.completionCount + 1)) &&
        (!["freezing", "complete"].includes(record.phase) ||
          Boolean(record.next && record.verifiedAt)) &&
        sources.every(
          (source) =>
            Object.values(source.links).every(
              (link) =>
                link.provider === record.provider &&
                link.accountId === record.accountId &&
                link.taskId !== null &&
                ids.has(link.taskId) &&
                link.base?.id === link.taskId,
            ) &&
            Object.entries(source.projections).every(
              ([uid, projection]) =>
                projection.provider === record.provider &&
                projection.accountId === record.accountId &&
                projection.linkUid === uid &&
                projection.taskId === source.links[uid]?.taskId,
            ),
        )
      );
    },
    {
      message:
        "Occurrence history retains its original task, account and verified transition.",
    },
  );
export type TaskOccurrenceRecord = z.infer<typeof taskOccurrenceSchema>;

/** Save the pre-command task and note identities in the same transaction as its UUID. */
export function recordTaskOccurrence(
  state: TaskRegistryState,
  snapshot: TaskSnapshot,
  operation: TaskOperation,
  completed: import("./types").ProviderTask[],
  recovered = false,
) {
  const task = operation.base;
  if (
    operation.mutation.kind !== "complete" ||
    !task?.due?.recurring ||
    task.completionCount === undefined
  )
    return;
  if (state.occurrences[operation.id]) return;
  const known = Object.values(state.links).flatMap((link) =>
    link.provider === operation.provider &&
    link.accountId === operation.accountId &&
    link.base
      ? [link.base]
      : [],
  );
  const tree = deletionTaskTree(
    recovered ? { ...snapshot, tasks: known } : snapshot,
    task,
    recovered ? [] : completed,
  );
  const ids = new Set(tree.map((item) => item.id));
  const owned = Object.entries(state.links).filter(
    ([, link]) =>
      link.provider === operation.provider &&
      link.accountId === operation.accountId &&
      link.taskId !== null &&
      ids.has(link.taskId),
  );
  const roots = owned.filter(
    ([, link]) =>
      link.taskId === task.id &&
      (!recovered || link.base?.completionCount === task.completionCount),
  );
  const links = Object.fromEntries(
    owned.filter(([uid, link]) =>
      roots.some(
        ([rootUid, root]) =>
          uid === rootUid ||
          (link.source.path === root.source.path &&
            link.source.from > root.source.from &&
            link.source.from + link.source.raw.length <=
              root.source.from + root.source.raw.length),
      ),
    ),
  );
  state.occurrences[operation.id] = {
    id: operation.id,
    provider: operation.provider,
    accountId: operation.accountId,
    before: {
      task,
      children: tree.slice(1),
      links,
      projections: Object.fromEntries(
        Object.entries(state.projections).filter(([uid]) => links[uid]),
      ),
    },
    links: {},
    projections: {},
    phase: "pending",
    recovered,
    requestedAt: operation.createdAt,
  };
}

export function pendingTaskOccurrence(
  state: Pick<TaskRegistryState, "occurrences">,
  owner: { provider: string; accountId: string },
  taskId: string,
  exceptId?: string,
) {
  return Object.values(state.occurrences).find(
    (record) =>
      record.id !== exceptId &&
      record.provider === owner.provider &&
      record.accountId === owner.accountId &&
      ["pending", "freezing"].includes(record.phase) &&
      [record.before.task, ...record.before.children].some(
        (task) => task.id === taskId,
      ),
  );
}

export function verifyTaskOccurrence(
  state: TaskRegistryState,
  operation: TaskOperation,
) {
  const record = state.occurrences[operation.id];
  if (!record || record.phase !== "pending" || !operation.readback) return;
  record.next = operation.readback;
  record.verifiedAt = new Date().toISOString();
  record.phase = Object.keys(record.before.links).length
    ? "freezing"
    : "complete";
  record.error = undefined;
}

export function historicalTaskLinks(
  state: Pick<TaskRegistryState, "occurrences">,
) {
  return Object.values(state.occurrences)
    .filter((record) => !["cancelled", "undone"].includes(record.phase))
    .flatMap((record) =>
      Object.entries(record.links).map(([uid, link]) => ({
        uid,
        link,
        occurrenceId: record.id,
      })),
    );
}
