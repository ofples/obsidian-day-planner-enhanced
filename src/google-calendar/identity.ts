import { resolveSourceIdentities } from "../service/source-identity";

import { sameSnapshot, type LocalIdentity } from "./types";

export interface IdentityCandidate extends LocalIdentity {
  uid?: string;
  eligible: boolean;
}

/** Keep calendar-specific title/time matching after the shared whole-block rules. */
export function resolveIdentities(
  candidates: IdentityCandidate[],
  previous: Record<string, LocalIdentity>,
): void {
  resolveSourceIdentities(candidates, previous, {
    duplicate:
      "Duplicate legacy calendar IDs. Restore one copy before syncing.",
    ambiguous: (path) =>
      `Calendar links are ambiguous in ${path}. Restore the previous titles/times and sync before making further edits.`,
    matchers: [
      (old, next) =>
        old.path === next.path && sameSnapshot(old.snapshot, next.snapshot),
      (old, next) =>
        old.path === next.path &&
        (old.snapshot.title === next.snapshot.title ||
          (old.snapshot.start === next.snapshot.start &&
            old.snapshot.end === next.snapshot.end)),
    ],
  });
}
