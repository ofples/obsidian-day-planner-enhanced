import { exportPlainText } from "../util/schedule-export";

import { taskSubtree } from "./browser";
import {
  captureTitle,
  parseCaptureCandidates,
  type CaptureCandidate,
} from "./capture-parser";
import type { ImportedTaskSource } from "./plain-import";
import { taskOccurrenceKey } from "./schedule-types";
import type { TaskSource } from "./source";
import type { TaskSnapshot } from "./types";

/** Verify saved import receipts against current note content and source identities. */
export function tasksAddedToNote({
  snapshot,
  path,
  candidates,
  imports,
  resolve,
}: {
  snapshot: TaskSnapshot;
  path: string;
  candidates: CaptureCandidate[];
  imports:
    | Record<string, ImportedTaskSource>
    | ReadonlyArray<readonly [string, ImportedTaskSource]>;
  resolve?: (uid: string) => TaskSource | undefined;
}) {
  const added = new Set<string>();
  const byId = new Map(snapshot.tasks.map((task) => [task.id, task]));
  const inNote = candidates.filter((candidate) => candidate.path === path);
  const title = (candidate: CaptureCandidate) =>
    captureTitle(candidate, new Set(candidate.tags.map((tag) => tag.name)));
  const sources: ReadonlyArray<readonly [string, ImportedTaskSource]> =
    Array.isArray(imports)
      ? (imports as ReadonlyArray<readonly [string, ImportedTaskSource]>)
      : Object.entries(imports as Record<string, ImportedTaskSource>);
  const visited = new Set<string>();
  for (const [key, source] of sources) {
    const fingerprint = JSON.stringify([
      key,
      source.path,
      source.uid,
      source.from,
      source.raw,
    ]);
    if (visited.has(fingerprint)) continue;
    visited.add(fingerprint);
    let parts: unknown;
    try {
      parts = JSON.parse(key);
    } catch {
      continue;
    }
    if (
      !Array.isArray(parts) ||
      parts[0] !== snapshot.provider ||
      parts[1] !== snapshot.account.id
    )
      continue;
    const task = typeof parts[2] === "string" ? byId.get(parts[2]) : undefined;
    if (!task || taskOccurrenceKey(task) !== parts[3]) continue;
    const current = source.uid ? (resolve?.(source.uid) ?? source) : source;
    if (current.path !== path) continue;
    const originals = parseCaptureCandidates(source.path, source.raw);
    const verified = inNote.filter(
      (candidate) => candidate.raw === current.raw,
    );
    const root =
      verified.length === 1
        ? verified[0]
        : verified.find((candidate) => candidate.from === current.from);
    if (!root) continue;
    added.add(task.id);
    const children = inNote.filter(
      (candidate) => candidate.from > root.from && candidate.to <= root.to,
    );
    const originalChildren = originals.slice(1);
    const ids = source.taskIds;
    if (ids && root.raw === source.raw) {
      for (const id of ids) added.add(id);
      continue;
    }
    const descendants = ids ? [] : taskSubtree(snapshot, task);
    for (const [index, child] of originalChildren.entries()) {
      const name = title(child);
      if (
        originalChildren.filter((candidate) => title(candidate) === name)
          .length !== 1 ||
        children.filter((candidate) => title(candidate) === name).length !== 1
      )
        continue;
      if (ids?.[index + 1]) added.add(ids[index + 1]!);
      else {
        const matching = descendants.filter(
          (row) => exportPlainText(row.task.title).trim() === name,
        );
        if (matching.length === 1) added.add(matching[0]!.task.id);
      }
    }
  }
  return added;
}
