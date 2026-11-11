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
  })
  .extend({ title: z.string().trim().min(1, "Enter a task title.") });

export const taskPatchSchema = taskDraftSchema
  .pick({
    title: true,
    description: true,
    labels: true,
    priority: true,
    due: true,
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

export const taskOperationSchema = z.object({
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
    "complete",
    "conflict",
    "failed",
    "cancelled",
  ]),
  remoteId: z.string().optional(),
  sourceUid: z.string().optional(),
  createdAt: z.iso.datetime(),
  attempts: z.number().int().nonnegative(),
  retryAt: z.number().optional(),
  error: z.string().optional(),
});

export type TaskDraft = z.infer<typeof taskDraftSchema>;
export type TaskPatch = z.infer<typeof taskPatchSchema>;
export type TaskMutation = z.infer<typeof taskMutationSchema>;
export type TaskOperation = z.infer<typeof taskOperationSchema>;

export function sameTaskField(a: unknown, b: unknown, field: string) {
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
  if (!remote) return "conflict";
  const base = operation.base;
  if (!base) return "conflict";
  if (
    (mutation.kind === "complete" || mutation.kind === "reopen") &&
    base.due?.recurring &&
    !sameTaskField(base.due, remote.due, "due")
  )
    return "conflict";
  const changes =
    mutation.kind === "update"
      ? mutation.changes
      : mutation.kind === "moveProject"
        ? { projectId: mutation.projectId, parentId: null }
        : mutation.kind === "moveParent"
          ? { parentId: mutation.parentId }
          : { completed: mutation.kind === "complete" };
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
