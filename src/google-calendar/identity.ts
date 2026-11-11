import { sameSnapshot, type LocalIdentity } from "./types";

export interface IdentityCandidate extends LocalIdentity {
  uid?: string;
  eligible: boolean;
}

/** Match blocks using stable content and unique edit evidence. Unmatched
 * blocks receive new identities in the note scanner. */
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
  // Byte-identical copies in the same note are interchangeable. Keep their
  // existing IDs in source order, and allocate only for surplus copies.
  for (const [uid, identity] of missing()) {
    if (assigned.has(uid) || !identity.raw) continue;
    const oldGroup = missing()
      .filter(
        ([, old]) => old.path === identity.path && old.raw === identity.raw,
      )
      .sort((a, b) => a[1].from - b[1].from);
    const newGroup = available()
      .filter(
        (next) => next.path === identity.path && next.raw === identity.raw,
      )
      .sort((a, b) => a.from - b.from);
    newGroup.slice(0, oldGroup.length).forEach((next, index) => {
      assign(oldGroup[index]![0], next);
    });
  }
  // A unique complete subtree also identifies moves across daily notes.
  matchUnique((old, next) => Boolean(old.raw) && old.raw === next.raw);
  matchUnique(
    (old, next) =>
      old.path === next.path && sameSnapshot(old.snapshot, next.snapshot),
  );
  matchUnique(
    (old, next) =>
      old.path === next.path && old.snapshot.title === next.snapshot.title,
  );
  matchUnique(
    (old, next) =>
      old.path === next.path &&
      old.snapshot.start === next.snapshot.start &&
      old.snapshot.end === next.snapshot.end,
  );
  // A rename and resize can leave only one endpoint of the range unchanged.
  matchUnique(
    (old, next) =>
      old.path === next.path &&
      (old.snapshot.start === next.snapshot.start ||
        old.snapshot.end === next.snapshot.end),
  );
}
