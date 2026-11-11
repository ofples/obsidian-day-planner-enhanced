import { deletionTaskTree, pendingTaskDeletion } from "./deletion-types";
import {
  occurrenceSourceLinks,
  pendingTaskOccurrence,
} from "./occurrence-types";
import { isOutstanding, operationAffectsTasks } from "./operations";
import type { TaskRegistryState } from "./registry";
import { scheduleBlocksTask } from "./schedule-types";
import {
  TaskReadError,
  taskSchema,
  type ProviderTask,
  type TaskSnapshot,
} from "./types";

export function buildOccurrenceUndoReview(
  state: TaskRegistryState,
  snapshot: TaskSnapshot,
  completed: ProviderTask[],
  id: string,
  displayed?: ProviderTask,
) {
  const record = state.occurrences[id];
  if (
    !record ||
    record.provider !== snapshot.provider ||
    record.accountId !== snapshot.account.id ||
    record.phase !== "complete"
  )
    throw new TaskReadError(
      "Review the completed occurrence under its original account before undoing it.",
    );
  if (record.undo && !["complete", "cancelled"].includes(record.undo.phase))
    throw new TaskReadError(
      "Finish this occurrence's saved undo before reviewing another one.",
    );
  const current = taskSchema.parse(
    displayed ??
      snapshot.tasks.find((task) => task.id === record.before.task.id) ??
      record.next,
  );
  const before = record.before.task;
  if (
    !before.due?.recurring ||
    before.completionCount === undefined ||
    record.next?.completionCount !== before.completionCount + 1 ||
    current.id !== before.id ||
    current.completionCount !== before.completionCount + 1 ||
    !current.due?.recurring ||
    current.due.text !== before.due.text ||
    current.due.timezone !== before.due.timezone
  )
    throw new TaskReadError(
      "This series advanced or its repeat rule changed. Review the selected occurrence and current Todoist task before restoring it.",
    );
  const children = deletionTaskTree(snapshot, current, [
    ...completed,
    ...Object.values(state.links).flatMap((link) =>
      link.provider === snapshot.provider &&
      link.accountId === snapshot.account.id &&
      link.base?.completed
        ? [link.base]
        : [],
    ),
  ]).slice(1);
  const ids = new Set([
    current.id,
    ...children.map((task) => task.id),
    ...record.before.children.map((task) => task.id),
  ]);
  if (
    [...ids].some(
      (taskId) =>
        pendingTaskOccurrence(state, record, taskId, id) ||
        pendingTaskDeletion(state, record, taskId),
    ) ||
    state.operations.some(
      (operation) =>
        operation.provider === record.provider &&
        operation.accountId === record.accountId &&
        operationAffectsTasks(operation, ids) &&
        isOutstanding(operation),
    ) ||
    state.schedules.some(
      (operation) =>
        operation.provider === record.provider &&
        operation.accountId === record.accountId &&
        ids.has(operation.task.id) &&
        scheduleBlocksTask(operation),
    )
  )
    throw new TaskReadError(
      "Finish this task tree's saved changes before undoing its occurrence.",
    );
  const links = occurrenceSourceLinks(state, snapshot, current.id, ids);
  const historical = { links: record.links, projections: record.projections };
  const following = {
    links,
    projections: Object.fromEntries(
      Object.entries(state.projections).filter(([uid]) => links[uid]),
    ),
  };
  const plan = {
    occurrenceId: id,
    provider: record.provider,
    accountId: record.accountId,
    current,
    children,
    historical,
    following,
  };
  return {
    ...plan,
    fingerprint: JSON.stringify({ ...plan, before: record.before }),
  };
}

export type TaskOccurrenceUndoReview = ReturnType<
  typeof buildOccurrenceUndoReview
> & { cached?: boolean };
