import { resolveSourceIdentities } from "../service/source-identity";

import { sameSnapshot, type LocalIdentity } from "./types";

export interface IdentityCandidate extends LocalIdentity {
  uid?: string;
  eligible: boolean;
}

/** Match stable content and unique edit evidence before allocating replacement IDs. */
export function resolveIdentities(
  candidates: IdentityCandidate[],
  previous: Record<string, LocalIdentity>,
): void {
  resolveSourceIdentities(candidates, previous, {
    duplicate:
      "Duplicate legacy calendar IDs. Restore one copy before syncing.",
    ambiguous: (path) => `Calendar links in ${path} require review.`,
    allowReplacement: true,
    matchers: [
      (old, next) =>
        old.path === next.path && sameSnapshot(old.snapshot, next.snapshot),
      (old, next) =>
        old.path === next.path && old.snapshot.title === next.snapshot.title,
      (old, next) =>
        old.path === next.path &&
        Date.parse(old.snapshot.start) === Date.parse(next.snapshot.start) &&
        Date.parse(old.snapshot.end) === Date.parse(next.snapshot.end),
      (old, next) =>
        old.path === next.path &&
        (Date.parse(old.snapshot.start) === Date.parse(next.snapshot.start) ||
          Date.parse(old.snapshot.end) === Date.parse(next.snapshot.end)),
    ],
  });
}
