import { DateTime } from "luxon";
import { z } from "zod";

import { taskSchema, type ProviderTask } from "./types";

export const taskDraftSchema = taskSchema
  .pick({
    title: true,
    description: true,
    projectId: true,
    parentId: true,
    labels: true,
    priority: true,
    due: true,
    duration: true,
  })
  .extend({ title: z.string().trim().min(1, "Enter a task title.") });

export const taskPatchSchema = taskDraftSchema
  .pick({
    title: true,
    description: true,
    labels: true,
    priority: true,
    due: true,
    duration: true,
  })
  .partial();

export const taskMutationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("create"), task: taskDraftSchema }),
  z.object({
    kind: z.literal("update"),
    taskId: z.string().min(1),
    changes: taskPatchSchema,
  }),
  z.object({
    kind: z.literal("moveProject"),
    taskId: z.string().min(1),
    projectId: z.string().min(1),
  }),
  z.object({
    kind: z.literal("moveParent"),
    taskId: z.string().min(1),
    parentId: z.string().min(1),
  }),
  z.object({ kind: z.literal("complete"), taskId: z.string().min(1) }),
  z.object({ kind: z.literal("reopen"), taskId: z.string().min(1) }),
  z.object({ kind: z.literal("delete"), taskId: z.string().min(1) }),
]);

export const recurringUndoSchema = z.object({
  occurrenceId: z.uuid(),
  completionCount: z.number().int().nonnegative(),
  due: taskSchema.shape.due.unwrap().refine((due) => due.recurring),
});

export const taskOperationSchema = z
  .object({
    id: z.uuid(),
    tempId: z.uuid(),
    provider: z.string().min(1),
    accountId: z.string().min(1),
    mutation: taskMutationSchema,
    base: taskSchema.nullable(),
    status: z.enum([
      "pending",
      "sent",
      "acknowledged",
      "verified",
      "complete",
      "conflict",
      "failed",
      "cancelled",
    ]),
    remoteId: z.string().optional(),
    readback: taskSchema.optional(),
    recurringCompletion: z.object({ resetSubtasks: z.boolean() }).optional(),
    recurringUndo: recurringUndoSchema.optional(),
    deletionReadback: z.record(z.string(), taskSchema.nullable()).optional(),
    sourceUid: z.string().optional(),
    createdAt: z.iso.datetime(),
    attempts: z.number().int().nonnegative(),
    retryAt: z.number().optional(),
    error: z.string().optional(),
    resolutionIds: z.array(z.uuid()).optional(),
  })
  .refine(
    (operation) =>
      !operation.recurringUndo ||
      (operation.mutation.kind === "reopen" &&
        operation.base?.id === operation.mutation.taskId &&
        operation.base.due?.recurring === true &&
        operation.base.completionCount ===
          operation.recurringUndo.completionCount + 1 &&
        operation.base.due.text === operation.recurringUndo.due.text &&
        operation.base.due.timezone === operation.recurringUndo.due.timezone),
    {
      message:
        "Recurring undo retains the selected previous occurrence and current provider baseline.",
    },
  )
  .refine(
    (operation) =>
      !operation.recurringCompletion ||
      (operation.mutation.kind === "complete" &&
        operation.base?.due?.recurring === true &&
        operation.base.completionCount !== undefined),
    {
      message:
        "Recurring completion commands retain their occurrence baseline.",
    },
  )
  .refine(
    (operation) =>
      operation.status !== "verified" ||
      (operation.mutation.kind === "delete"
        ? operation.remoteId === operation.mutation.taskId &&
          operation.deletionReadback?.[operation.remoteId] === null
        : Boolean(operation.remoteId) &&
          operation.readback?.id === operation.remoteId),
    {
      message:
        "Verified task operations require their matching provider readback.",
    },
  );

export type TaskDraft = z.infer<typeof taskDraftSchema>;
export type TaskPatch = z.infer<typeof taskPatchSchema>;
export type TaskMutation = z.infer<typeof taskMutationSchema>;
export type TaskOperation = z.infer<typeof taskOperationSchema>;

export function mutationFields(mutation: TaskMutation) {
  switch (mutation.kind) {
    case "create":
      return mutation.task;
    case "update":
      return mutation.changes;
    case "moveProject":
      return { projectId: mutation.projectId, parentId: null };
    case "moveParent":
      return { parentId: mutation.parentId };
    case "complete":
      return { completed: true };
    case "reopen":
      return { completed: false };
    case "delete":
      return {};
  }
}

function sameTaskDate(
  expected: NonNullable<ProviderTask["due"]>,
  actual: NonNullable<ProviderTask["due"]>,
  timezone: string,
) {
  if (!expected.date.includes("T") || !actual.date.includes("T"))
    return expected.date === actual.date;
  const first = DateTime.fromISO(expected.date, {
    zone: expected.timezone ?? timezone,
  });
  const second = DateTime.fromISO(actual.date, {
    zone: actual.timezone ?? timezone,
  });
  return (
    first.isValid && second.isValid && first.toMillis() === second.toMillis()
  );
}

export function sameTaskField(
  a: unknown,
  b: unknown,
  field: string,
  timezone?: string,
) {
  if (field === "duration" && a == null && b == null) return true;
  if (field === "labels") {
    const first = z.array(z.string()).safeParse(a),
      second = z.array(z.string()).safeParse(b);
    if (first.success && second.success)
      return (
        JSON.stringify(first.data.toSorted()) ===
        JSON.stringify(second.data.toSorted())
      );
  }
  if (field === "due" && a && b) {
    const first = taskSchema.shape.due.parse(a),
      second = taskSchema.shape.due.parse(b);
    return (
      (first?.date === second?.date ||
        Boolean(
          first && second && timezone && sameTaskDate(first, second, timezone),
        )) &&
      first?.recurring === second?.recurring &&
      first?.timezone === second?.timezone &&
      (!first?.recurring || first.text === second?.text)
    );
  }
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Compare only fields the operation will change, so unrelated remote edits survive. */
export function preflightOperation(
  operation: TaskOperation,
  remote: ProviderTask | null,
  timezone?: string,
): "ready" | "already-applied" | "conflict" {
  const mutation = operation.mutation;
  if (mutation.kind === "create") return "ready";
  if (!remote || remote.id !== mutation.taskId) return "conflict";
  const base = operation.base;
  if (!base) return "conflict";
  if (operation.recurringUndo) {
    if (matchesOperationResult(operation, remote, timezone ?? "UTC"))
      return "already-applied";
    return remote.completionCount === base.completionCount &&
      remote.completed === base.completed &&
      sameTaskField(remote.due, base.due, "due", timezone)
      ? "ready"
      : "conflict";
  }
  if (mutation.kind === "delete")
    return sameDeletionTask(base, remote) ? "ready" : "conflict";
  if (
    mutation.kind === "update" &&
    mutation.changes.due !== undefined &&
    base.due?.recurring &&
    base.completionCount !== undefined &&
    remote.completionCount !== base.completionCount
  )
    return "conflict";
  if (
    (mutation.kind === "complete" || mutation.kind === "reopen") &&
    (base.due?.recurring || remote.due?.recurring)
  )
    if (
      mutation.kind === "reopen" ||
      base.completed ||
      remote.completed ||
      base.completionCount === undefined ||
      remote.completionCount !== base.completionCount ||
      !sameTaskField(base.due, remote.due, "due", timezone)
    )
      return "conflict";
  const changes = mutationFields(mutation);
  let changed = false;
  for (const [field, wanted] of Object.entries(changes)) {
    const current = remote[field as keyof ProviderTask];
    if (sameTaskField(current, wanted, field, timezone)) continue;
    if (
      !sameTaskField(
        current,
        base[field as keyof ProviderTask],
        field,
        timezone,
      )
    )
      return "conflict";
    changed = true;
  }
  return changed ? "ready" : "already-applied";
}

/** Confirm actual field values after acknowledgment, including provider-normalized dates. */
export function matchesOperationResult(
  operation: TaskOperation,
  remote: ProviderTask | null,
  timezone: string,
) {
  if (operation.mutation.kind === "delete") return remote === null;
  if (!remote || remote.id !== operationTaskId(operation)) return false;
  if (operation.recurringUndo)
    return (
      !remote.completed &&
      remote.completionCount === operation.recurringUndo.completionCount &&
      sameTaskField(remote.due, operation.recurringUndo.due, "due", timezone)
    );
  if (operation.mutation.kind === "complete" && operation.base?.due?.recurring)
    return (
      operation.base.completionCount !== undefined &&
      remote.completionCount === operation.base.completionCount + 1 &&
      (remote.completed ||
        (remote.due?.recurring === true &&
          remote.due.text === operation.base.due.text &&
          remote.due.timezone === operation.base.due.timezone))
    );
  return Object.entries(mutationFields(operation.mutation)).every(
    ([field, wanted]) => {
      if (field === "due" && wanted && remote.due) {
        const expected = taskSchema.shape.due.parse(wanted)!;
        const actual = remote.due;
        return (
          sameTaskDate(expected, actual, timezone) &&
          expected.recurring === actual.recurring &&
          (!expected.recurring ||
            (expected.text === actual.text &&
              (expected.timezone === null ||
                expected.timezone === actual.timezone)))
        );
      }
      return sameTaskField(remote[field as keyof ProviderTask], wanted, field);
    },
  );
}

export function operationTaskId(operation: TaskOperation) {
  return (
    operation.remoteId ??
    (operation.mutation.kind === "create"
      ? `local-${operation.id}`
      : operation.mutation.taskId)
  );
}

export function isOutstanding(operation: TaskOperation) {
  return !["complete", "cancelled"].includes(operation.status);
}

export function operationAffectsTasks(
  operation: TaskOperation,
  ids: Set<string>,
) {
  const mutation = operation.mutation;
  return (
    ids.has(operationTaskId(operation)) ||
    (mutation.kind === "create" &&
      mutation.task.parentId !== null &&
      ids.has(mutation.task.parentId)) ||
    (mutation.kind === "moveParent" && ids.has(mutation.parentId))
  );
}

export function sameDeletionTask(base: ProviderTask, current: ProviderTask) {
  return [...new Set([...Object.keys(base), ...Object.keys(current)])]
    .filter((key) => key !== "order")
    .every((key) =>
      sameTaskField(
        base[key as keyof ProviderTask],
        current[key as keyof ProviderTask],
        key,
      ),
    );
}

/** Follow replacement commands without replaying the superseded provider UUID. */
export function resolvedTaskOperation(
  operations: TaskOperation[],
  id: string,
):
  | { status: "complete"; task?: ProviderTask; operationId?: string }
  | { status: "pending" | "conflict" } {
  const byId = new Map(
    operations.map((operation) => [operation.id, operation]),
  );
  const root = byId.get(id);
  if (!root) return { status: "conflict" };
  const pending = [id];
  const visited = new Set<string>();
  let task: ProviderTask | undefined;
  let operationId: string | undefined;
  for (let index = 0; index < pending.length; index++) {
    const next = pending[index]!;
    const operation = byId.get(next);
    if (
      !operation ||
      visited.has(next) ||
      operation.provider !== root.provider ||
      operation.accountId !== root.accountId ||
      operationTaskId(operation) !== operationTaskId(root)
    )
      return { status: "conflict" };
    visited.add(next);
    if (operation.status === "cancelled" && operation.resolutionIds) {
      task = operation.readback ?? task;
      pending.splice(index + 1, 0, ...operation.resolutionIds);
    } else if (operation.status === "complete") {
      task = operation.readback ?? task;
      operationId = operation.id;
    } else if (["conflict", "failed", "cancelled"].includes(operation.status))
      return { status: "conflict" };
    else return { status: "pending" };
  }
  return { status: "complete", task, ...(operationId ? { operationId } : {}) };
}
