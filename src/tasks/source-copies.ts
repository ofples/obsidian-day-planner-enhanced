import { nativeSourceBlockId } from "../service/source-identity";

import type { CaptureCandidate } from "./capture-parser";
import { identitySourceKey, type TaskSource } from "./source";
import { TaskReadError } from "./types";

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
  historicalOwners?: ReadonlyMap<string, string>,
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
    const nestedUids = new Set(nested.map((candidate) => candidate.uid));
    const uids = entries
      .filter((old) =>
        owners.some(
          (parent) =>
            historicalOwners?.get(parent.uid) ===
              historicalOwners?.get(old.uid) &&
            (old.uid === parent.uid ||
              contains(parent, old) ||
              nestedUids.has(old.uid)),
        ),
      )
      .map((source) => source.uid);
    groups.push({ uids, copies });
    for (const candidate of nested) covered.add(candidate);
  }
  return groups;
}

export function suggestTaskSourceTree(
  candidates: CaptureCandidate[],
  links: Record<string, { source: TaskSource }>,
  uid: string,
  key: string,
) {
  const original = links[uid]?.source;
  const source = candidates.find(
    (candidate) => identitySourceKey(candidate) === key,
  );
  if (!original || !source)
    throw new TaskReadError("Choose a current source for this task.");
  const linked: Record<string, string> = { [uid]: key };
  for (const [childUid, link] of Object.entries(links)) {
    if (!contains(original, link.source) || original.from === link.source.from)
      continue;
    const blockId = nativeSourceBlockId(link.source.raw);
    const exact =
      original.raw === source.raw
        ? candidates.find(
            (candidate) =>
              contains(source, candidate) &&
              source.from !== candidate.from &&
              candidate.from - source.from ===
                link.source.from - original.from &&
              candidate.raw === link.source.raw,
          )
        : undefined;
    const matches = exact
      ? [exact]
      : candidates.filter(
          (candidate) =>
            contains(source, candidate) &&
            source.from !== candidate.from &&
            ((original.raw === source.raw &&
              candidate.from - source.from ===
                link.source.from - original.from) ||
              (blockId && nativeSourceBlockId(candidate.raw) === blockId) ||
              candidate.raw === link.source.raw),
        );
    if (matches.length === 1) linked[childUid] = identitySourceKey(matches[0]!);
  }
  return linked;
}
