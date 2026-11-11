export interface SourceIdentity {
  path: string;
  raw: string;
  from: number;
}

function containsSource(parent: SourceIdentity, child: SourceIdentity) {
  return (
    child.path === parent.path &&
    child.from > parent.from &&
    child.from + child.raw.length <= parent.from + parent.raw.length
  );
}

function sourceParentUid(
  source: SourceIdentity,
  identities: [string | undefined, SourceIdentity][],
) {
  return identities
    .filter(([uid, parent]) => uid && containsSource(parent, source))
    .toSorted((a, b) => a[1].raw.length - b[1].raw.length)[0]?.[0];
}

export function nativeSourceBlockId(raw: string) {
  return raw.split(/\r?\n/)[0]?.match(/\s\^([\w-]+)\s*$/)?.[1];
}

export function locateSource(
  text: string,
  source: { raw: string; from?: number },
) {
  if (!source.raw) return -1;
  if (
    source.from !== undefined &&
    text.slice(source.from, source.from + source.raw.length) === source.raw
  )
    return source.from;
  const index = text.indexOf(source.raw);
  return index >= 0 && text.indexOf(source.raw, index + 1) < 0 ? index : -1;
}

/** Conservative whole-block matching shared by note projections and calendar sync. */
export function resolveSourceIdentities<T extends SourceIdentity>(
  candidates: (T & { uid?: string })[],
  previous: Record<string, T>,
  options: {
    duplicate: string;
    ambiguous: (path: string) => string;
    matchers: ((old: T, next: T) => boolean)[];
    allowReplacement?: boolean;
    preserveNested?: boolean;
    onAmbiguous?: (path: string, uids: string[]) => void;
  },
): void {
  const assigned = new Set<string>();
  for (const candidate of candidates) {
    if (!candidate.uid) continue;
    if (assigned.has(candidate.uid)) throw new Error(options.duplicate);
    assigned.add(candidate.uid);
  }
  const previousEntries = Object.entries(previous);
  const missing = () => previousEntries.filter(([uid]) => !assigned.has(uid));
  const containersFirst = () =>
    options.preserveNested
      ? missing().toSorted((a, b) => b[1].raw.length - a[1].raw.length)
      : missing();
  const available = () => candidates.filter((candidate) => !candidate.uid);
  const assign = (uid: string, candidate: T & { uid?: string }) => {
    candidate.uid = uid;
    assigned.add(uid);
    const identity = previous[uid];
    if (!options.preserveNested || identity?.raw !== candidate.raw) return;
    // An exact whole-block match also proves every contained source offset.
    for (const [nestedUid, nested] of missing()) {
      if (!containsSource(identity, nested)) continue;
      const child = candidates.find(
        (next) =>
          next.path === candidate.path &&
          next.from === candidate.from + nested.from - identity.from &&
          next.raw === nested.raw,
      );
      if (!child) continue;
      if (child.uid && child.uid !== nestedUid)
        throw new Error(options.duplicate);
      child.uid = nestedUid;
      assigned.add(nestedUid);
    }
  };
  const matchUnique = (matches: (old: T, next: T) => boolean) => {
    for (const [uid, identity] of containersFirst()) {
      if (assigned.has(uid)) continue;
      const here = available().filter((candidate) =>
        matches(identity, candidate),
      );
      if (here.length !== 1) continue;
      const candidate = here[0]!;
      if (missing().filter(([, old]) => matches(old, candidate)).length === 1)
        assign(uid, candidate);
    }
  };
  if (options.preserveNested) {
    for (const candidate of candidates)
      if (candidate.uid) assign(candidate.uid, candidate);
    // Resolve unique containers before equal child text can match by list order.
    matchUnique((old, next) => old.path === next.path && old.raw === next.raw);
    matchUnique((old, next) => old.raw === next.raw);
    matchUnique(
      (old, next) =>
        old.path === next.path &&
        Boolean(nativeSourceBlockId(old.raw)) &&
        nativeSourceBlockId(old.raw) === nativeSourceBlockId(next.raw),
    );
    options.matchers.forEach(matchUnique);
  }
  for (const [, identity] of containersFirst()) {
    const parentUid = options.preserveNested
      ? sourceParentUid(identity, previousEntries)
      : undefined;
    const oldGroup = missing().filter(
      ([, old]) =>
        old.path === identity.path &&
        old.raw === identity.raw &&
        (!options.preserveNested ||
          sourceParentUid(old, previousEntries) === parentUid),
    );
    const newGroup = available().filter(
      (next) =>
        next.path === identity.path &&
        next.raw === identity.raw &&
        (!options.preserveNested ||
          sourceParentUid(
            next,
            candidates.map((candidate) => [candidate.uid, candidate]),
          ) === parentUid),
    );
    if (!options.allowReplacement && oldGroup.length !== newGroup.length)
      continue;
    oldGroup.sort((a, b) => a[1].from - b[1].from);
    newGroup.sort((a, b) => a.from - b.from);
    newGroup
      .slice(0, oldGroup.length)
      .forEach((candidate, index) => assign(oldGroup[index]![0], candidate));
  }
  matchUnique(
    (old, next) =>
      old.path === next.path &&
      Boolean(nativeSourceBlockId(old.raw)) &&
      nativeSourceBlockId(old.raw) === nativeSourceBlockId(next.raw),
  );
  matchUnique((old, next) => old.raw === next.raw);
  options.matchers.forEach(matchUnique);
  if (options.allowReplacement) return;
  for (const path of new Set(missing().map(([, identity]) => identity.path))) {
    const old = missing().filter(([, identity]) => identity.path === path);
    const next = available().filter((candidate) => candidate.path === path);
    if (
      old.length === 1 &&
      next.length === 1 &&
      old[0]![1].from === next[0]!.from
    )
      assign(old[0]![0], next[0]!);
    else if (old.length && next.length) {
      if (options.onAmbiguous)
        options.onAmbiguous(
          path,
          old.map(([uid]) => uid),
        );
      else throw new Error(options.ambiguous(path));
    }
  }
}
