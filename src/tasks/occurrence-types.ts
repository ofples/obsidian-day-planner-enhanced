import { z } from "zod";

import { deletionTaskTree } from "./deletion-types";
import { pendingIdentityDecision } from "./identity-types";
import {
  isOutstanding,
  operationTaskId,
  type TaskOperation,
} from "./operations";
import type { TaskRegistryState } from "./registry";
import { scheduleBlocksTask, taskProjectionSchema } from "./schedule-types";
import { taskLinkSchema } from "./source";
import { taskSchema, type ProviderTask, type TaskSnapshot } from "./types";

const occurrenceSourcesSchema = z.object({
  links: z.record(z.string(), taskLinkSchema),
  projections: z.record(z.string(), taskProjectionSchema),
});
const occurrenceUndoSchema = z.object({
  id: z.uuid(),
  phase: z.enum(["provider-pending", "local-pending", "complete", "cancelled"]),
  current: taskSchema,
  children: z.array(taskSchema),
  historical: occurrenceSourcesSchema,
  following: occurrenceSourcesSchema,
  steps: z
    .object({
      following: z.record(z.string(), z.uuid()),
      historical: z.record(z.string(), z.uuid()),
    })
    .default({ following: {}, historical: {} }),
  requestedAt: z.iso.datetime(),
  readback: taskSchema.optional(),
  error: z.string().optional(),
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
    external: z.literal(true).optional(),
    undo: occurrenceUndoSchema.optional(),
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
            (record.external
              ? record.next.completionCount !== undefined &&
                record.next.completionCount > task.completionCount
              : record.next.completionCount === task.completionCount + 1))) &&
        (!record.external ||
          (record.phase !== "pending" &&
            Boolean(record.next && record.verifiedAt))) &&
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
  )
  .refine(
    (record) => {
      const undo = record.undo,
        task = record.before.task;
      if (!undo) return true;
      const ids = new Set([
        task.id,
        ...record.before.children.map((child) => child.id),
        ...undo.children.map((child) => child.id),
      ]);
      return (
        task.due?.recurring === true &&
        task.completionCount !== undefined &&
        record.next?.completionCount === task.completionCount + 1 &&
        undo.current.id === task.id &&
        undo.current.completionCount === task.completionCount + 1 &&
        undo.current.due?.recurring === true &&
        undo.current.due.text === task.due.text &&
        undo.current.due.timezone === task.due.timezone &&
        new Set(undo.children.map((child) => child.id)).size ===
          undo.children.length &&
        !undo.children.some((child) => child.id === task.id) &&
        (!undo.readback ||
          (undo.readback.id === task.id &&
            !undo.readback.completed &&
            undo.readback.completionCount === task.completionCount)) &&
        (!["local-pending", "complete"].includes(undo.phase) ||
          Boolean(undo.readback)) &&
        new Set([
          ...Object.values(undo.steps.following),
          ...Object.values(undo.steps.historical),
        ]).size ===
          Object.keys(undo.steps.following).length +
            Object.keys(undo.steps.historical).length &&
        Object.keys(undo.steps.following).every((uid) =>
          Boolean(undo.following.links[uid]),
        ) &&
        Object.keys(undo.steps.historical).every((uid) =>
          Boolean(undo.historical.links[uid]),
        ) &&
        Object.entries(undo.historical.links).every(
          ([uid, link]) => record.before.links[uid]?.taskId === link.taskId,
        ) &&
        Object.keys(undo.following.links).every(
          (uid) => !undo.historical.links[uid],
        ) &&
        [undo.historical, undo.following].every(
          (source) =>
            Object.values(source.links).every(
              (link) =>
                link.provider === record.provider &&
                link.accountId === record.accountId &&
                link.taskId !== null &&
                ids.has(link.taskId) &&
                link.taskId === link.base?.id,
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
        "Recurring undo recovery retains the selected occurrence, provider baseline and owned note projections.",
    },
  );
export type TaskOccurrenceRecord = z.infer<typeof taskOccurrenceSchema>;

export function matchingOccurrenceUndo(
  state: Pick<TaskRegistryState, "occurrences">,
  operation: TaskOperation,
  allowCompleted = false,
) {
  const undo = operation.recurringUndo;
  if (!undo) return undefined;
  const record = state.occurrences[undo.occurrenceId];
  if (
    !record ||
    record.undo?.id !== operation.id ||
    record.undo.phase === "cancelled" ||
    (!allowCompleted && record.undo.phase === "complete") ||
    record.provider !== operation.provider ||
    record.accountId !== operation.accountId ||
    operation.mutation.kind !== "reopen" ||
    operation.mutation.taskId !== record.before.task.id ||
    undo.completionCount !== record.before.task.completionCount ||
    JSON.stringify(undo.due) !== JSON.stringify(record.before.task.due) ||
    JSON.stringify(operation.base) !== JSON.stringify(record.undo.current)
  )
    return undefined;
  return record;
}

export function verifyTaskOccurrenceUndo(
  state: TaskRegistryState,
  operation: TaskOperation,
) {
  const record = matchingOccurrenceUndo(state, operation);
  if (
    record?.undo?.id !== operation.id ||
    !operation.readback ||
    record.undo.phase !== "provider-pending"
  )
    return;
  record.undo.readback = operation.readback;
  record.undo.phase = "local-pending";
  record.undo.error = undefined;
}

export function occurrenceCompletionVerified(
  state: Pick<TaskRegistryState, "operations">,
  record: TaskOccurrenceRecord,
) {
  return (
    ["freezing", "complete"].includes(record.phase) &&
    Boolean(record.next && record.verifiedAt) &&
    (record.external === true ||
      state.operations.some(
        (operation) =>
          operation.id === record.id && operation.status === "complete",
      ))
  );
}

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
    operation.provider !== snapshot.provider ||
    operation.accountId !== snapshot.account.id ||
    !task?.due?.recurring ||
    task.completionCount === undefined
  )
    return;
  if (state.occurrences[operation.id]) return;
  state.occurrences[operation.id] = captureTaskOccurrence(
    state,
    snapshot,
    task,
    completed,
    { id: operation.id, requestedAt: operation.createdAt, recovered },
  );
}

function captureTaskOccurrence(
  state: TaskRegistryState,
  snapshot: TaskSnapshot,
  task: ProviderTask,
  completed: ProviderTask[],
  origin: Pick<TaskOccurrenceRecord, "id" | "requestedAt" | "recovered">,
): TaskOccurrenceRecord {
  const known = Object.values(state.links).flatMap((link) =>
    link.provider === snapshot.provider &&
    link.accountId === snapshot.account.id &&
    link.base
      ? [link.base]
      : [],
  );
  const tree = deletionTaskTree(
    origin.recovered ? { ...snapshot, tasks: known } : snapshot,
    task,
    origin.recovered ? [] : completed,
  );
  const ids = new Set(tree.map((item) => item.id));
  const links = occurrenceSourceLinks(
    state,
    snapshot,
    task.id,
    ids,
    origin.recovered ? task.completionCount : undefined,
  );
  return {
    ...origin,
    provider: snapshot.provider,
    accountId: snapshot.account.id,
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
  };
}

export function occurrenceSourceLinks(
  state: Pick<TaskRegistryState, "links">,
  owner: { provider: string; account: { id: string } },
  taskId: string,
  ids: Set<string>,
  completionCount?: number,
) {
  const owned = Object.entries(state.links).filter(
    ([, link]) =>
      link.provider === owner.provider &&
      link.accountId === owner.account.id &&
      link.taskId !== null &&
      ids.has(link.taskId),
  );
  const roots = owned.filter(
    ([, link]) =>
      link.taskId === taskId &&
      (completionCount === undefined ||
        link.base?.completionCount === completionCount),
  );
  return Object.fromEntries(
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
}

/** A provider counter advance observes a past occurrence without issuing a command. */
export function recordExternalTaskOccurrence(
  state: TaskRegistryState,
  snapshot: TaskSnapshot,
  uid: string,
  next: ProviderTask,
) {
  const link = state.links[uid],
    task = link?.base;
  if (
    !link ||
    !task?.due?.recurring ||
    task.completionCount === undefined ||
    link.provider !== snapshot.provider ||
    link.accountId !== snapshot.account.id ||
    link.taskId !== next.id ||
    task.id !== next.id ||
    next.completionCount === undefined ||
    next.completionCount <= task.completionCount ||
    Object.values(state.occurrences).some(
      (record) =>
        record.provider === link.provider &&
        record.accountId === link.accountId &&
        record.before.task.id === task.id &&
        record.before.task.completionCount === task.completionCount &&
        !["cancelled", "undone"].includes(record.phase),
    )
  )
    return false;
  const record = captureTaskOccurrence(state, snapshot, task, [], {
    id: crypto.randomUUID(),
    requestedAt: snapshot.fetchedAt,
    recovered: true,
  });
  const ids = new Set([
    task.id,
    ...record.before.children.map((child) => child.id),
  ]);
  const owned = { provider: snapshot.provider, accountId: snapshot.account.id };
  if (
    [...ids].some((id) => pendingIdentityDecision(state, owned, id)) ||
    state.operations.some(
      (operation) =>
        operation.provider === owned.provider &&
        operation.accountId === owned.accountId &&
        ids.has(operationTaskId(operation)) &&
        isOutstanding(operation),
    ) ||
    state.schedules.some(
      (operation) =>
        operation.provider === owned.provider &&
        operation.accountId === owned.accountId &&
        ids.has(operation.task.id) &&
        scheduleBlocksTask(operation),
    ) ||
    Object.values(state.deletions).some(
      (deletion) =>
        deletion.provider === owned.provider &&
        deletion.accountId === owned.accountId &&
        !["complete", "cancelled"].includes(deletion.phase) &&
        deletion.tasks.some((item) => ids.has(item.id)),
    )
  )
    return false;
  record.external = true;
  record.next = next;
  record.verifiedAt = snapshot.fetchedAt;
  record.phase = Object.keys(record.before.links).length
    ? "freezing"
    : "complete";
  state.occurrences[record.id] = record;
  return true;
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
      (["pending", "freezing"].includes(record.phase) ||
        (record.undo &&
          !["complete", "cancelled"].includes(record.undo.phase))) &&
      [
        record.before.task,
        ...record.before.children,
        ...(record.undo?.children ?? []),
      ].some((task) => task.id === taskId),
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
  state: Pick<TaskRegistryState, "occurrences" | "links" | "schedules">,
) {
  return Object.values(state.occurrences)
    .filter((record) => !["cancelled", "undone"].includes(record.phase))
    .flatMap((record) =>
      Object.entries(record.links)
        .filter(
          ([uid]) =>
            !record.undo ||
            (!state.links[uid] &&
              !state.schedules.some(
                (operation) =>
                  operation.id === record.undo!.steps.historical[uid] &&
                  operation.taskAcknowledged,
              )),
        )
        .map(([uid, link]) => ({
          uid,
          link,
          occurrenceId: record.id,
        })),
    );
}
