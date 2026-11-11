import { sameSnapshot, type LocalIdentity } from "./types";

export interface IdentityCandidate extends LocalIdentity {
  uid?: string;
  eligible: boolean;
}

/** Reconcile whole blocks first, then unique title/time edits. Ambiguous edits
 * stop before allocating IDs or writing Google events. */
export function resolveIdentities(
  candidates: IdentityCandidate[],
  previous: Record<string, LocalIdentity>,
): void {
  const assigned = new Set<string>();
  for (const candidate of candidates) {
    if (!candidate.uid) continue;
    if (assigned.has(candidate.uid))
      throw new Error(
        "Duplicate legacy calendar IDs. Restore one copy before syncing.",
      );
    assigned.add(candidate.uid);
  }
  const missing = () =>
    Object.entries(previous).filter(([uid]) => !assigned.has(uid));
  const available = () => candidates.filter((candidate) => !candidate.uid);
  const assign = (uid: string, candidate: IdentityCandidate) => {
    candidate.uid = uid;
    assigned.add(uid);
  };
  // Identical duplicate blocks keep their order only when their count agrees.
  for (const [uid, identity] of missing()) {
    if (assigned.has(uid)) continue;
    const oldGroup = missing().filter(
      ([, old]) => old.path === identity.path && old.raw === identity.raw,
    );
    const newGroup = available().filter(
      (next) => next.path === identity.path && next.raw === identity.raw,
    );
    if (oldGroup.length !== newGroup.length) continue;
    oldGroup.sort((a, b) => a[1].from - b[1].from);
    newGroup.sort((a, b) => a.from - b.from);
    oldGroup.forEach(([oldUid], index) => assign(oldUid, newGroup[index]!));
  }
  const matchUnique = (
    matches: (a: LocalIdentity, b: IdentityCandidate) => boolean,
  ) => {
    for (const [uid, identity] of missing()) {
      const matchesHere = available().filter((candidate) =>
        matches(identity, candidate),
      );
      if (matchesHere.length !== 1) continue;
      const candidate = matchesHere[0]!;
      if (missing().filter(([, old]) => matches(old, candidate)).length === 1)
        assign(uid, candidate);
    }
  };
  const blockId = (raw: string) =>
    raw.split(/\r?\n/)[0]?.match(/\s\^([\w-]+)\s*$/)?.[1];
  matchUnique(
    (old, next) =>
      old.path === next.path &&
      Boolean(blockId(old.raw)) &&
      blockId(old.raw) === blockId(next.raw),
  );
  // A unique complete subtree also identifies moves across daily notes.
  matchUnique((old, next) => old.raw === next.raw);
  matchUnique(
    (old, next) =>
      old.path === next.path && sameSnapshot(old.snapshot, next.snapshot),
  );
  matchUnique(
    (old, next) =>
      old.path === next.path &&
      (old.snapshot.title === next.snapshot.title ||
        (old.snapshot.start === next.snapshot.start &&
          old.snapshot.end === next.snapshot.end)),
  );
  // A single remaining block can be fully rewritten in place.
  for (const path of new Set(missing().map(([, identity]) => identity.path))) {
    const old = missing().filter(([, identity]) => identity.path === path);
    const next = available().filter((candidate) => candidate.path === path);
    if (
      old.length === 1 &&
      next.length === 1 &&
      old[0]![1].from === next[0]!.from
    )
      assign(old[0]![0], next[0]!);
    else if (old.length && next.length)
      throw new Error(
        `Calendar links are ambiguous in ${path}. Restore the previous titles/times and sync before making further edits.`,
      );
  }
}
