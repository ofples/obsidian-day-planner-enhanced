import { nativeSourceBlockId } from "../service/source-identity";

import type { CaptureCandidate } from "./capture-parser";
import type { TaskSource } from "./source";

export interface TaskSourceCopies {
  uids: string[];
  copies: CaptureCandidate[];
}

function contains(parent: TaskSource, child: TaskSource) {
  return (
    parent.path === child.path &&
    child.from >= parent.from &&
    child.from + child.raw.length <= parent.from + parent.raw.length
  );
}

function sourceKeys(source: TaskSource) {
  const keys = [JSON.stringify(["raw", source.raw.replace(/\r\n/g, "\n")])];
  const blockId = nativeSourceBlockId(source.raw);
  if (blockId) keys.push(JSON.stringify(["block", source.path, blockId]));
  return keys;
}

function indexSources<T extends TaskSource>(sources: T[]) {
  const index = new Map<string, T[]>();
  for (const source of sources)
    for (const key of sourceKeys(source)) {
      const values = index.get(key) ?? [];
      values.push(source);
      index.set(key, values);
    }
  return index;
}

function matchingSources<T extends TaskSource>(
  index: Map<string, T[]>,
  source: TaskSource,
) {
  return [
    ...new Set(sourceKeys(source).flatMap((key) => index.get(key) ?? [])),
  ];
}

/** A copied known block needs an explicit identity decision before capture. */
export function findTaskSourceCopies(
  candidates: CaptureCandidate[],
  previous: Record<string, TaskSource>,
): TaskSourceCopies[] {
  const entries = Object.entries(previous)
    .map(([uid, source]) => ({ ...source, uid }))
    .toSorted((a, b) => b.raw.length - a.raw.length);
  const candidateIndex = indexSources(candidates);
  const ownerIndex = indexSources(entries);
  const groups: TaskSourceCopies[] = [];
  const covered = new Set<CaptureCandidate>();
  for (const source of entries) {
    const copies = matchingSources(candidateIndex, source).filter(
      (candidate) => !covered.has(candidate),
    );
    if (
      !copies.some(
        (candidate) =>
          !candidate.uid &&
          candidate.tags.some((tag) => tag.name.toLowerCase() === "todoist"),
      )
    )
      continue;
    const owners = [
      ...new Set(
        copies.flatMap((candidate) => matchingSources(ownerIndex, candidate)),
      ),
    ];
    if (copies.length <= owners.length) continue;
    const nested = candidates.filter((candidate) =>
      copies.some((copy) => contains(copy, candidate)),
    );
    const uids = entries
      .filter(
        (old) =>
          owners.some(
            (parent) => old.uid === parent.uid || contains(parent, old),
          ) || nested.some((candidate) => candidate.uid === old.uid),
      )
      .map((source) => source.uid);
    groups.push({ uids, copies });
    for (const candidate of nested) covered.add(candidate);
  }
  return groups;
}
