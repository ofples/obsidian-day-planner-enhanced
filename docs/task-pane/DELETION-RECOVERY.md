# Task deletion recovery and provider request bounds

Deleting a scheduled task tree could require checking every note for a moved task. Large cached inventories were parsed without giving the UI a turn, and plain child titles could be assigned to unrelated checklist lines in another note when their linked parent was missing.

## Result

- Current-note identity checks yield after each 25 files. They stop promptly after unload or a note revision/readiness change, before publishing stale evidence.
- Weak cross-note matches for children of a missing parent are held for review. A matched whole-parent move, an acknowledged independent child, and a unique native block ID remain supported. Completed operation history cannot override the current source.
- Both provider adapters share serial request gates across their connection instances: one-second start spacing, at most 64 outstanding requests, account-wide cooldowns, and numeric or HTTP-date Retry-After support.
- Transport errors, HTTP 429/5xx, and Google quota failures back off exponentially when no valid server deadline exists. Five repeated transient failures for an operation open the circuit. Successes on other endpoints cannot reset that failure streak. Rejected credentials stop automatic retries.
- Only explicit Refresh, Retry, or Connect actions reopen a circuit after its deadline. Unload prevents queued requests from starting. Google permits one token-refresh retry after HTTP 401; transport code does not automatically replay transiently failed mutations. Durable command identities are preserved.

## Evidence and limits

The final focused capture, gate, adapter, and lifecycle run passed 115 tests. Earlier combined validation passed formatting, ESLint, stylelint, TypeScript, Svelte checks, and 1,265 tests; the existing inclusive-last-day ICS fixture timed out. The strict lint scorecard passed separately. The final capture lifecycle change passed its focused suite, ESLint, and TypeScript. Production build passed.

Fixtures cover missing-parent children, stale history, whole-tree moves, independent children, native IDs, a 2,000-level dependency chain, UI yielding, unload cancellation, provider spacing, bounded queues, server cooldowns, authorization failures, and circuit reset rules.

The original whole-application hang and an actual API flood have not been reproduced. The identified synchronous scan and unsafe child reassignment are fixed, and request traffic is now bounded independently. An ambiguous deletion or rename may still require a source-link decision. A never-settling network call can still hold its serial queue; the queue size remains bounded. Gates are shared for the current plugin lifetime, not persisted across application restarts.
