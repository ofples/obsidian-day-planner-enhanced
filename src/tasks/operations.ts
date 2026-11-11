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
]);

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
    sourceUid: z.string().optional(),
    createdAt: z.iso.datetime(),
    attempts: z.number().int().nonnegative(),
    retryAt: z.number().optional(),
    error: z.string().optional(),
  })
  .refine(
    (operation) =>
      operation.status !== "verified" ||
      (Boolean(operation.remoteId) &&
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

function mutationFields(mutation: TaskMutation) {
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
  }
}

export function sameTaskField(a: unknown, b: unknown, field: string) {
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
      first?.date === second?.date &&
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
): "ready" | "already-applied" | "conflict" {
  const mutation = operation.mutation;
  if (mutation.kind === "create") return "ready";
  if (!remote || remote.id !== mutation.taskId) return "conflict";
  const base = operation.base;
  if (!base) return "conflict";
  if (
    (mutation.kind === "complete" || mutation.kind === "reopen") &&
    base.due?.recurring &&
    !sameTaskField(base.due, remote.due, "due")
  )
    return "conflict";
  const changes = mutationFields(mutation);
  let changed = false;
  for (const [field, wanted] of Object.entries(changes)) {
    const current = remote[field as keyof ProviderTask];
    if (sameTaskField(current, wanted, field)) continue;
    if (!sameTaskField(current, base[field as keyof ProviderTask], field))
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
  if (!remote || remote.id !== operationTaskId(operation)) return false;
  if (operation.mutation.kind === "complete" && operation.base?.due?.recurring)
    return (
      remote.completed || !sameTaskField(operation.base.due, remote.due, "due")
    );
  return Object.entries(mutationFields(operation.mutation)).every(
    ([field, wanted]) => {
      if (field === "due" && wanted && remote.due) {
        const expected = taskSchema.shape.due.parse(wanted)!;
        const actual = remote.due;
        const expectedInstant = DateTime.fromISO(expected.date, {
          zone: expected.timezone ?? timezone,
        });
        const actualInstant = DateTime.fromISO(actual.date, {
          zone: actual.timezone ?? timezone,
        });
        const datesMatch =
          expected.date.includes("T") && actual.date.includes("T")
            ? expectedInstant.isValid &&
              actualInstant.isValid &&
              expectedInstant.toMillis() === actualInstant.toMillis()
            : expected.date === actual.date;
        return (
          datesMatch &&
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
