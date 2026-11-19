import type { PlanningTask } from "../ai-scheduling/types";

import type { CaptureCandidate } from "./capture-parser";
import { taskSourceKey } from "./source-references";
import type { TaskSnapshot } from "./types";

/** Resolve a saved assistant view against current sources using their identities. */
export function planningTaskSelection(
  tasks: PlanningTask[],
  refs: ReadonlySet<string>,
  candidates: CaptureCandidate[],
  snapshot: TaskSnapshot | readonly TaskSnapshot[] | null,
) {
  const snapshots: readonly TaskSnapshot[] = snapshot
    ? Array.isArray(snapshot)
      ? snapshot
      : [snapshot as TaskSnapshot]
    : [];
  const selected = tasks.filter((task) => refs.has(task.ref));
  const activeRefs = new Set<string>();
  const providerIds = new Set<string>();
  const providerKeys = new Set<string>();
  for (const currentSnapshot of snapshots) {
    const selectedIds = new Set<string>();
    for (const task of selected) {
      if (
        task.kind !== "note" &&
        task.provider === currentSnapshot.provider &&
        task.accountId === currentSnapshot.account.id &&
        task.taskId
      ) {
        providerIds.add(task.taskId);
        selectedIds.add(task.taskId);
        if (
          currentSnapshot.tasks.some(
            (current) => current.id === task.taskId && !current.completed,
          )
        )
          activeRefs.add(task.ref);
      }
    }
    // Include current descendants. taskGroups supplies the necessary ancestors.
    const children = new Map<string, string[]>();
    for (const task of currentSnapshot.tasks) {
      if (!task.parentId) continue;
      const siblings = children.get(task.parentId) ?? [];
      siblings.push(task.id);
      children.set(task.parentId, siblings);
    }
    const pendingIds = [...selectedIds];
    for (let index = 0; index < pendingIds.length; index++) {
      for (const id of children.get(pendingIds[index]!) ?? []) {
        if (selectedIds.has(id)) continue;
        providerIds.add(id);
        selectedIds.add(id);
        pendingIds.push(id);
      }
    }
    for (const itemId of selectedIds)
      providerKeys.add(
        taskSourceKey({
          provider: currentSnapshot.provider,
          accountId: currentSnapshot.account.id,
          itemId,
        }),
      );
  }

  const selectedNotes = new Set<CaptureCandidate>();
  for (const task of selected) {
    if (task.kind !== "note") continue;
    const matches = candidates.filter(
      (candidate) => candidate.path === task.path && candidate.raw === task.raw,
    );
    const exact = matches.find((candidate) => candidate.from === task.from);
    const candidate = exact ?? (matches.length === 1 ? matches[0] : undefined);
    if (candidate) {
      selectedNotes.add(candidate);
      if (!candidate.completed && candidate.status === " ")
        activeRefs.add(task.ref);
    }
  }
  const noteChildren = new Map<CaptureCandidate, CaptureCandidate[]>();
  const byPosition = new Map(
    candidates.map((candidate) => [
      JSON.stringify([candidate.path, candidate.from]),
      candidate,
    ]),
  );
  for (const candidate of candidates) {
    const parent = byPosition.get(
      JSON.stringify([candidate.path, candidate.parentFrom]),
    );
    if (!parent) continue;
    const siblings = noteChildren.get(parent) ?? [];
    siblings.push(candidate);
    noteChildren.set(parent, siblings);
  }
  const pendingNotes = [...selectedNotes];
  for (let index = 0; index < pendingNotes.length; index++) {
    for (const child of noteChildren.get(pendingNotes[index]!) ?? []) {
      if (selectedNotes.has(child)) continue;
      selectedNotes.add(child);
      pendingNotes.push(child);
    }
  }
  // Ancestors are context only. Add them after walking selected descendants.
  for (const candidate of pendingNotes) {
    let parent = byPosition.get(
      JSON.stringify([candidate.path, candidate.parentFrom]),
    );
    while (parent && !selectedNotes.has(parent)) {
      selectedNotes.add(parent);
      parent = byPosition.get(JSON.stringify([parent.path, parent.parentFrom]));
    }
  }
  return {
    activeRefs,
    noteKeys: new Set(
      pendingNotes.map((candidate) =>
        JSON.stringify([candidate.path, candidate.from]),
      ),
    ),
    providerIds,
    providerKeys,
    notes: candidates.filter((candidate) => selectedNotes.has(candidate)),
  };
}
