import { getTimeRangeMatch } from "../parser/parser";
import { hasTaskLock } from "../util/task-lock";

import type { CaptureCandidate } from "./capture-parser";

export interface NoteTaskRow {
  candidate: CaptureCandidate;
  locked: boolean;
  depth: number;
  context: boolean;
  hasChildren: boolean;
  scheduled: boolean;
}

const key = (path: string, from: number) => JSON.stringify([path, from]);

/** Project indexed note tasks without reading notes or changing their identities. */
export function noteTaskRows(
  candidates: CaptureCandidate[],
  query = "",
  includeScheduled = false,
): NoteTaskRow[] {
  const sorted = candidates.toSorted(
    (a, b) => a.path.localeCompare(b.path) || a.from - b.from,
  );
  const byKey = new Map(
    sorted.map((candidate) => [key(candidate.path, candidate.from), candidate]),
  );
  const timedTree = new Set<string>();
  const lockedTree = new Set<string>();
  const depthByKey = new Map<string, number>();
  for (const candidate of sorted) {
    const id = key(candidate.path, candidate.from);
    const parent =
      candidate.parentFrom === undefined
        ? ""
        : key(candidate.path, candidate.parentFrom);
    depthByKey.set(
      id,
      depthByKey.has(parent) ? depthByKey.get(parent)! + 1 : 0,
    );
    if (
      getTimeRangeMatch(candidate.raw.split(/\r?\n/, 1)[0] ?? "") ||
      timedTree.has(parent)
    )
      timedTree.add(id);
    if (hasTaskLock(candidate.raw)) lockedTree.add(id);
  }
  for (const candidate of sorted.toReversed()) {
    const id = key(candidate.path, candidate.from);
    if (!lockedTree.has(id) || candidate.parentFrom === undefined) continue;
    const parent = key(candidate.path, candidate.parentFrom);
    if (byKey.has(parent)) lockedTree.add(parent);
  }
  const needle = query.trim().toLocaleLowerCase();
  const matches = new Set(
    sorted
      .filter(
        (candidate) =>
          candidate.status === " " &&
          !candidate.completed &&
          (includeScheduled ||
            (!candidate.insideTimedBlock &&
              !timedTree.has(key(candidate.path, candidate.from)))) &&
          (!needle ||
            `${candidate.title} ${candidate.path}`
              .toLocaleLowerCase()
              .includes(needle)),
      )
      .map((candidate) => key(candidate.path, candidate.from)),
  );
  const visible = new Set(matches);
  for (const candidate of sorted.toReversed()) {
    if (
      !visible.has(key(candidate.path, candidate.from)) ||
      candidate.parentFrom === undefined
    )
      continue;
    visible.add(key(candidate.path, candidate.parentFrom));
  }
  const parents = new Set(
    sorted
      .filter(
        (candidate) =>
          visible.has(key(candidate.path, candidate.from)) &&
          candidate.parentFrom !== undefined,
      )
      .map((candidate) => key(candidate.path, candidate.parentFrom!)),
  );
  return sorted
    .filter((candidate) => visible.has(key(candidate.path, candidate.from)))
    .map((candidate) => {
      const id = key(candidate.path, candidate.from);
      return {
        candidate,
        locked: lockedTree.has(id),
        depth: depthByKey.get(id) ?? 0,
        context: !matches.has(id),
        hasChildren: parents.has(id),
        scheduled: timedTree.has(id),
      };
    });
}

export function noteTaskDragText(candidate: CaptureCandidate): string {
  return (candidate.raw.split(/\r?\n/, 1)[0] ?? "").replace(
    /^\s*(?:[-*+]|\d+[.)])\s+\[[^\]]\]\s*/,
    "",
  );
}
