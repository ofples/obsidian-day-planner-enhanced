export interface SourceIdentity {
  path: string;
  raw: string;
  from: number;
}

/** Conservative whole-block matching shared by note projections and calendar sync. */
export function resolveSourceIdentities<T extends SourceIdentity>(
  candidates: (T & { uid?: string })[],
  previous: Record<string, T>,
  options: {
    duplicate: string;
    ambiguous: (path: string) => string;
    matchers: ((old: T, next: T) => boolean)[];
  },
): void {
  const assigned = new Set<string>();
  for (const candidate of candidates) {
    if (!candidate.uid) continue;
    if (assigned.has(candidate.uid)) throw new Error(options.duplicate);
    assigned.add(candidate.uid);
  }
  const missing = () =>
    Object.entries(previous).filter(([uid]) => !assigned.has(uid));
  const available = () => candidates.filter((candidate) => !candidate.uid);
  const assign = (uid: string, candidate: T & { uid?: string }) => {
    candidate.uid = uid;
    assigned.add(uid);
  };
  for (const [, identity] of missing()) {
    const oldGroup = missing().filter(
      ([, old]) => old.path === identity.path && old.raw === identity.raw,
    );
    const newGroup = available().filter(
      (next) => next.path === identity.path && next.raw === identity.raw,
    );
    if (oldGroup.length !== newGroup.length) continue;
    oldGroup.sort((a, b) => a[1].from - b[1].from);
    newGroup.sort((a, b) => a.from - b.from);
    oldGroup.forEach(([uid], index) => assign(uid, newGroup[index]!));
  }
  const matchUnique = (matches: (old: T, next: T) => boolean) => {
    for (const [uid, identity] of missing()) {
      const here = available().filter((candidate) =>
        matches(identity, candidate),
      );
      if (here.length !== 1) continue;
      const candidate = here[0]!;
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
  matchUnique((old, next) => old.raw === next.raw);
  options.matchers.forEach(matchUnique);
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
      throw new Error(options.ambiguous(path));
  }
}
