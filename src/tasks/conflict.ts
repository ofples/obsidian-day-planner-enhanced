import {
  mutationFields,
  sameTaskField,
  taskPatchSchema,
  type TaskMutation,
  type TaskOperation,
} from "./operations";
import type { ScheduleInterval } from "./schedule-types";
import { TaskReadError, type ProviderTask } from "./types";

export type TaskConflictValues = Partial<ProviderTask> & {
  interval?: ScheduleInterval | null;
};

export interface TaskConflictField {
  key: string;
  fields: (keyof TaskConflictValues)[];
  base: TaskConflictValues | null;
  local: TaskConflictValues;
  remote: TaskConflictValues | null;
  conflict: boolean;
  localAllowed: boolean;
  localUnavailableReason?: string;
}

export interface TaskConflictDisplay {
  title: string;
  localLabel?: string;
  current: ProviderTask | null;
  fields: TaskConflictField[];
}

export interface TaskConflictReview extends TaskConflictDisplay {
  operation: TaskOperation;
}

export interface TaskConflictController<Review extends TaskConflictDisplay> {
  inspectConflict(id: string): Promise<Review>;
  resolveConflict(
    review: Review,
    choices: TaskConflictChoices,
  ): Promise<{ kind: "changed"; review: Review } | { kind: "saved" }>;
}

export type TaskConflictChoices = Record<string, "local" | "remote">;

export function reviewTaskConflict(
  operation: TaskOperation,
  current: ProviderTask | null,
): TaskConflictReview {
  const wanted = mutationFields(operation.mutation);
  const groups = new Map<string, (keyof ProviderTask)[]>();
  for (const key of Object.keys(wanted) as (keyof ProviderTask)[]) {
    const group = ["due", "duration"].includes(key)
      ? "schedule"
      : ["projectId", "parentId"].includes(key)
        ? "placement"
        : key;
    groups.set(group, [...(groups.get(group) ?? []), key]);
  }
  const pick = (value: Partial<ProviderTask>, fields: (keyof ProviderTask)[]) =>
    Object.fromEntries(fields.map((field) => [field, value[field]]));
  const fields = [...groups].map(([key, fields]): TaskConflictField => {
    const differs = (
      first: Partial<ProviderTask>,
      second: Partial<ProviderTask>,
    ) =>
      fields.some(
        (field) => !sameTaskField(first[field], second[field], field),
      );
    return {
      key,
      fields,
      base: operation.base && pick(operation.base, fields),
      local: pick(wanted, fields),
      remote: current && pick(current, fields),
      conflict:
        !current ||
        (!operation.base && differs(wanted, current)) ||
        Boolean(
          operation.base &&
            differs(operation.base, current) &&
            differs(wanted, current),
        ),
      localAllowed:
        Boolean(current) &&
        !(
          key === "completed" &&
          operation.base?.due?.recurring &&
          !sameTaskField(operation.base.due, current?.due, "due")
        ),
    };
  });
  return {
    operation,
    current,
    fields,
    title: current?.title ?? operation.base?.title ?? "Saved task",
  };
}

/** Resolve into fresh commands so an acknowledged UUID is never reused with new fields. */
export function taskConflictMutations(
  review: TaskConflictReview,
  choices: TaskConflictChoices,
): { mutation: TaskMutation; base: ProviderTask }[] {
  if (
    Object.keys(choices).some(
      (key) => !review.fields.some((field) => field.key === key),
    )
  )
    throw new TaskReadError(
      "The conflict fields changed. Review the latest comparison.",
    );
  const local: Partial<ProviderTask> = {};
  for (const field of review.fields) {
    const choice = choices[field.key];
    if (choice !== "local" && choice !== "remote")
      throw new TaskReadError("Choose a value for every saved field.");
    if (choice === "local") {
      if (!field.localAllowed)
        throw new TaskReadError(
          "This task or recurring occurrence changed. Keep its current state and review the next occurrence.",
        );
      Object.assign(local, field.local);
    }
  }
  if (!review.current) return [];
  let base = structuredClone(review.current);
  const planned: { mutation: TaskMutation; base: ProviderTask }[] = [];
  const add = (mutation: TaskMutation) => {
    planned.push({ mutation, base });
    base = { ...base, ...mutationFields(mutation) };
  };
  const taskId = base.id;
  if (
    local.projectId !== undefined &&
    (local.projectId !== base.projectId ||
      (local.parentId === null && base.parentId !== null))
  )
    add({ kind: "moveProject", taskId, projectId: local.projectId });
  if (local.parentId && local.parentId !== base.parentId)
    add({ kind: "moveParent", taskId, parentId: local.parentId });
  const changes = taskPatchSchema.parse(local);
  const changed = Object.fromEntries(
    Object.entries(changes).filter(
      ([field, value]) =>
        !sameTaskField(value, base[field as keyof ProviderTask], field),
    ),
  );
  if (Object.keys(changed).length)
    add({ kind: "update", taskId, changes: changed });
  if (local.completed !== undefined && local.completed !== base.completed)
    add({ kind: local.completed ? "complete" : "reopen", taskId });
  return planned;
}
