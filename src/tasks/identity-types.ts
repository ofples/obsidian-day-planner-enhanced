import { z } from "zod";

import { taskDraftSchema, type TaskOperation } from "./operations";
import type { TaskRegistryState } from "./registry";
import { taskProjectionSchema } from "./schedule-types";
import { taskLinkSchema, taskSourceSchema } from "./source";

export const localTaskSourceSchema = z.object({
  provider: z.string(),
  accountId: z.string(),
  decisionId: z.uuid(),
  source: taskSourceSchema,
});

export const identityDecisionSchema = z
  .object({
    id: z.uuid(),
    fingerprint: z.string().min(1),
    provider: z.string(),
    accountId: z.string(),
    before: z.object({
      links: z.record(z.string(), taskLinkSchema),
      historical: z.record(z.string(), z.uuid()).optional(),
      projections: z.record(z.string(), taskProjectionSchema),
      localSources: z.record(z.string(), localTaskSourceSchema).default({}),
    }),
    assignments: z.array(
      z.object({
        uid: z.string().min(1),
        source: taskSourceSchema,
        kind: z.enum(["linked", "local", "create"]),
        draft: taskDraftSchema.optional(),
        effectiveDraft: taskDraftSchema.optional(),
        parentUid: z.string().optional(),
        completed: z.boolean().optional(),
        completionId: z.uuid().optional(),
      }),
    ),
    phase: z.enum(["creating", "complete", "cancelled"]),
    createdAt: z.iso.datetime(),
    error: z.string().optional(),
  })
  .refine(
    (record) => {
      const assignments = record.assignments;
      return (
        Object.keys(record.before.links).length > 0 &&
        Object.keys(record.before.historical ?? {}).every((uid) =>
          Boolean(record.before.links[uid]),
        ) &&
        new Set(
          assignments.flatMap((item) =>
            item.completionId ? [item.completionId] : [],
          ),
        ).size === assignments.filter((item) => item.completionId).length &&
        Object.values(record.before.localSources).every(
          (local) =>
            local.provider === record.provider &&
            local.accountId === record.accountId,
        ) &&
        new Set(assignments.map((item) => item.uid)).size ===
          assignments.length &&
        new Set(
          assignments.map((item) =>
            JSON.stringify([item.source.path, item.source.from]),
          ),
        ).size === assignments.length &&
        Object.entries(record.before.links).every(
          ([uid, link]) =>
            link.provider === record.provider &&
            link.accountId === record.accountId &&
            link.taskId &&
            assignments.some(
              (item) => item.uid === uid && item.kind === "linked",
            ),
        ) &&
        assignments.every(
          (item, index) =>
            (item.kind === "linked"
              ? Boolean(record.before.links[item.uid])
              : !record.before.links[item.uid]) &&
            (item.kind === "create"
              ? Boolean(item.draft)
              : !item.draft && !item.parentUid && !item.effectiveDraft) &&
            (!item.effectiveDraft ||
              (item.parentUid &&
                JSON.stringify(item.effectiveDraft) ===
                  JSON.stringify({
                    ...item.draft!,
                    projectId: item.effectiveDraft.projectId,
                  }))) &&
            Boolean(item.completed) === Boolean(item.completionId) &&
            (item.kind === "create" ||
              (!item.completed && !item.completionId)) &&
            (!item.parentUid ||
              assignments
                .slice(0, index)
                .some(
                  (parent) =>
                    parent.uid === item.parentUid && parent.kind === "create",
                )),
        ) &&
        Object.entries(record.before.projections).every(
          ([uid, projection]) =>
            projection.linkUid === uid &&
            projection.taskId === record.before.links[uid]?.taskId &&
            projection.provider === record.provider &&
            projection.accountId === record.accountId,
        )
      );
    },
    {
      message:
        "Identity decisions retain original owned links, distinct sources and ordered child creation.",
    },
  );
export type TaskIdentityDecision = z.infer<typeof identityDecisionSchema>;

export function pendingIdentityDecision(
  state: Pick<TaskRegistryState, "identityDecisions" | "links">,
  owner: { provider: string; accountId: string },
  taskId: string,
  exceptId?: string,
) {
  return Object.values(state.identityDecisions).find(
    (record) =>
      record.id !== exceptId &&
      record.phase === "creating" &&
      record.provider === owner.provider &&
      record.accountId === owner.accountId &&
      (Object.values(record.before.links).some(
        (link) => link.taskId === taskId,
      ) ||
        record.assignments.some(
          (item) =>
            item.kind === "create" && state.links[item.uid]?.taskId === taskId,
        )),
  );
}

export type TaskIdentityDecisionView = TaskIdentityDecision & {
  cancellable?: boolean;
};
export function identityDecisionCanCancel(
  state: Pick<TaskRegistryState, "operations" | "links">,
  record: TaskIdentityDecision,
) {
  const uids = new Set(
    record.assignments
      .filter((item) => item.kind === "create")
      .map((item) => item.uid),
  );
  const commands = state.operations.filter(
    (op) =>
      (op.sourceUid && uids.has(op.sourceUid)) ||
      record.assignments.some((item) => item.completionId === op.id),
  );
  return (
    record.phase === "creating" &&
    !commands.some(
      (op) =>
        op.remoteId ||
        op.sentAt ||
        !["pending", "conflict"].includes(op.status),
    ) &&
    !record.assignments.some(
      (item) => item.kind === "create" && state.links[item.uid]?.taskId,
    )
  );
}

export function historicalIdentityOwner(
  state: Pick<TaskRegistryState, "links" | "occurrences">,
  before: TaskIdentityDecision["before"],
  uid: string,
) {
  const id = before.historical?.[uid];
  const occurrence = id ? state.occurrences[id] : undefined;
  const original = before.links[uid];
  return occurrence &&
    original &&
    occurrence.phase === "complete" &&
    (!occurrence.undo || occurrence.undo.phase === "cancelled") &&
    occurrence.provider === original.provider &&
    occurrence.accountId === original.accountId &&
    !state.links[uid] &&
    occurrence.links[uid]?.taskId === original.taskId &&
    occurrence.before.links[uid]?.taskId === original.taskId
    ? occurrence
    : undefined;
}

export function matchingIdentityCommand(
  state: Pick<TaskRegistryState, "identityDecisions" | "links" | "occurrences">,
  operation: TaskOperation,
) {
  const record =
    operation.identityDecisionId &&
    state.identityDecisions[operation.identityDecisionId];
  if (
    !record ||
    record.phase !== "creating" ||
    record.provider !== operation.provider ||
    record.accountId !== operation.accountId
  )
    return undefined;
  if (
    Object.keys(record.before.historical ?? {}).some(
      (uid) => !historicalIdentityOwner(state, record.before, uid),
    )
  )
    return undefined;
  const assignment = record.assignments.find(
    (item) =>
      item.kind === "create" &&
      (operation.mutation.kind === "create"
        ? operation.sourceUid === item.uid
        : operation.id === item.completionId),
  );
  if (!assignment) return undefined;
  if (operation.mutation.kind === "create") {
    const parentId = assignment.parentUid
      ? state.links[assignment.parentUid]?.taskId
      : assignment.draft!.parentId;
    if (
      JSON.stringify(operation.mutation.task) !==
      JSON.stringify({
        ...(assignment.effectiveDraft ?? assignment.draft!),
        parentId,
      })
    )
      return undefined;
  } else if (
    operation.mutation.kind !== "complete" ||
    !assignment.completed ||
    state.links[assignment.uid]?.taskId !== operation.mutation.taskId
  )
    return undefined;
  return record;
}
