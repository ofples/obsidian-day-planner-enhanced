import type { TaskSourceReference } from "./source-types";
import type { ProviderTask, TaskSnapshot } from "./types";

/** Opaque IDs may contain separators; tuple encoding keeps identities unambiguous. */
export function taskSourceKey(ref: TaskSourceReference): string {
  return JSON.stringify([ref.provider, ref.accountId, ref.itemId]);
}

export function taskSourceReference(
  snapshot: TaskSnapshot,
  task: ProviderTask,
): TaskSourceReference {
  return {
    provider: snapshot.provider,
    accountId: snapshot.account.id,
    itemId: task.id,
  };
}

export function googleTaskId(listId: string, taskId: string): string {
  return JSON.stringify([listId, taskId]);
}

/** Project item identity survives draft conversion only while the cache knows it. */
export function resolveSourceTask(
  snapshots: readonly TaskSnapshot[],
  ref: TaskSourceReference,
): { snapshot: TaskSnapshot; task: ProviderTask } | null {
  const snapshot = snapshots.find(
    (item) =>
      item.provider === ref.provider && item.account.id === ref.accountId,
  );
  if (!snapshot) return null;
  const direct = snapshot.tasks.find((item) => item.id === ref.itemId);
  if (direct) return { snapshot, task: direct };
  if (ref.provider !== "github") return null;
  const matches = snapshot.tasks.filter((item) =>
    item.source?.memberships?.some(
      (membership) => membership.itemId === ref.itemId,
    ),
  );
  return matches.length === 1 ? { snapshot, task: matches[0]! } : null;
}
