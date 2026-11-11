# Acceptance and edge cases

Each case starts as planned. Mark a case passed only with the check date, exact commit, test or UI procedure and observed result. Automated checks, synthetic desktop acceptance, live provider acceptance and working-vault installation are separate evidence.

## Connection, data and browsing

| Case | Story | Scenario and required result | Milestone |
| --- | --- | --- | --- |
| A01 | US-01 | Valid token loads the correct account, all task/project pages and a complete cache | M1 |
| A02 | US-01 | Invalid token preserves the previous credential and cache and shows an actionable error | M1 |
| A03 | US-10 | Failure on page two keeps the entire previous snapshot and creates no deletion signal | M1 |
| A04 | US-10 | Repeated cursor or malformed required fields stop the refresh with the previous snapshot intact | M1 |
| A05 | US-01 | Reload without network displays cached tasks and a stale-data indicator | M1 |
| A06 | US-13 | Disconnect during an outstanding request leaves the pane disconnected after the response arrives | M1 |
| A07 | US-13 | Switching accounts requires an explicit account choice and keeps the old account links separate | M1/M4 |
| A08 | US-01 | Date groups use the user's calendar day, including near midnight and offset-aware times | M1 |
| A09 | US-01 | Project grouping, title/description/project/label search and stable task order work together | M1 |
| A10 | US-09 | Nested, orphaned and cyclic parent data remain searchable without recursion errors or duplicate rows | M1 |
| A11 | US-01 | Empty account, no filter matches and missing project each show the correct actionable state | M1 |
| A12 | US-01 | A 320px pane, theme switch, popout and keyboard navigation keep controls readable and accessible | M1/M6 |

## Capture, edits and identity

| Case | Story | Scenario and required result | Milestone |
| --- | --- | --- | --- |
| A13 | US-05 | A committed nonempty #todoist task creates exactly once despite duplicate index events and restart | M2 |
| A14 | US-05 | Active line, IME composition, code block, comment, bare tag and initially completed task create nothing | M2 |
| A15 | US-05 | One project tag routes correctly, two different project mappings require a choice, no match uses default | M2 |
| A16 | US-05 | Provider-only labels, local-only tags and readable routing tags survive a title update | M2/M4 |
| A17 | US-02 | Title, description, project, priority, label and child edits work independently through details | M2 |
| A18 | US-09 | Add/move/complete a child preserves parent identity and unrelated local child paragraphs | M2/M5 |
| A19 | US-12 | Reorder, cross-file move, CRLF, native block ID and rename preserve the same remote task | M3/M4 |
| A20 | US-12 | Copying a linked block pauses ambiguous writes and supports retaining a link or creating a separate task | M5 |
| A21 | US-12 | Identical text tasks remain distinct, and title similarity alone never adopts an existing task | M3/M5 |
| A22 | US-13 | Archived/deleted project, revoked collaborator access and account mismatch retain local content | M4 |
| A23 | US-07 | Removing #todoist offers unlink, and Cancel restores the routing tag without a remote mutation | M4 |

## Scheduling and calendar ownership

| Case | Story | Scenario and required result | Milestone |
| --- | --- | --- | --- |
| A24 | US-03 | Drop into day/week uses snapping and creates one local projection and one Google event | M3 |
| A25 | US-03 | Drop an already scheduled task moves its block and retains task and Google event identity | M3 |
| A26 | US-03 | Keyboard schedule, Escape cancel, invalid target and overlap follow the same scheduling semantics | M3 |
| A27 | US-04 | Drop at an editable Markdown caret links one untimed task and preserves surrounding note bytes | M3 |
| A28 | US-03 | Resize and overnight move propagate the correct timezone-aware start and duration | M3/M4 |
| A29 | US-06 | Remote date-only change moves a linked schedule while preserving its clock time and duration | M4 |
| A30 | US-06 | Unscheduled remote date/time changes follow import policy and avoid silently scheduling every task | M4 |
| A31 | US-11 | Existing Google-linked note adoption retains its event ID, color and other description text | M3 |
| A32 | US-11 | Exact Todoist Google/ICS feed exclusion prevents duplicates on date change, refresh and restart | M3 |
| A33 | US-11 | Unrelated Google events, shared calendars and other ICS sources remain visible | M3/M6 |
| A34 | US-11 | Native Todoist Google exporter collision is detected before a second exporter is enabled | M3 |
| A35 | US-07 | Unschedule retains remote task and task date, converts note to untimed and removes only its owned event | M3/M4 |
| A36 | US-07 | Local block deletion unlinks by default, explicit remote delete has separate confirmation | M4 |
| A37 | US-09 | Independently scheduled child avoids overlapping duplicate rendering and remains linked to its parent | M5 |
| A38 | US-09 | PNG export, compact subtasks and generated Google description stay consistent after edits | M6 |

## Reconciliation, recurrence and failure recovery

| Case | Story | Scenario and required result | Milestone |
| --- | --- | --- | --- |
| A39 | US-06 | Independent fields merge, same-field disagreements create unresolved field choices, equal edits converge | M4 |
| A40 | US-06 | Note, pane, Todoist and Google time/title edits converge without ping-pong writes | M4 |
| A41 | US-10 | Crash before/after provider acknowledgment retries the same command and creates no duplicate task | M2/M4 |
| A42 | US-10 | Crash between source/destination writes recovers a cross-day move and retains child text | M3/M4 |
| A43 | US-10 | Google failure after Todoist success retries only the calendar phase after restart | M4 |
| A44 | US-10 | 429 Retry-After, 5xx, network timeout and revoked token retain queued operations and offer retry | M2/M4 |
| A45 | US-12 | Another device/state writer stops mutation before overwriting the changed registry | M4 |
| A46 | US-12 | Missing note, ambiguous edit and unsupported future state schema preserve data and offer repair | M4/M5 |
| A47 | US-08 | Recurring completion freezes today's checked block and shows one fresh next occurrence | M5 |
| A48 | US-08 | Rescheduling one occurrence preserves repeat rule, timezone and later occurrence identity | M5 |
| A49 | US-08 | Repeated completion, offline completion and undo target the same occurrence across restart | M5 |
| A50 | US-09 | Parent completion respects actual provider child semantics and refreshes the tree | M5 |
| A51 | US-10 | Disconnect/reconnect preserves recoverable operations and never replays them into another account | M4 |
| A52 | US-02 | Untrusted HTML, unsafe URLs, huge text and Unicode content render safely without losing note text | M1/M6 |
| A53 | US-01 | 2,000 tasks and deep trees load, filter and scroll without UI stalls or request storms | M6 |
| A54 | US-13 | Matching plugin/state/note rollback restores the old baseline and flags unsupported newer schemas | M6 |
| A55 | US-06 | A remote edit during conflict resolution causes revalidation before the selected patch is applied | M4 |
| A56 | US-10 | Unloading during backoff cancels the retry and prevents stale UI/cache publication | M1/M4 |

## Failure-injection matrix

Exercise each mutation at the boundaries before intent save, after intent save, after local write, after remote success with a lost response, after remote acknowledgment save, after Google write and before operation completion. Restart after every injected failure. Required outcomes are one task per create operation, one event per occurrence, preserved source text and a retriable or explicitly conflicted operation.

Use deterministic provider responses for focused regression tests and a real disposable task for final provider semantics. Include a recurring parent and child and an account/project permission failure in live acceptance. Keep private task/calendar IDs in the local acceptance record and clean up test artifacts.

## Release evidence

| Evidence | State | Required record |
| --- | --- | --- |
| Baseline source | Confirmed | `82ae46ff` equals origin `feat/google-calendar-sync` |
| New source checks | M1 foundation verified | 17 focused passes, 695 full-suite passes, one inherited ICS timeout, TypeScript/Svelte, formatting/style lint, strict scorecard and build pass |
| Inherited ICS timeout | Known baseline issue | `tests/ical.test.ts`, last visible day inclusive case, independently reproduced on upstream previously |
| Synthetic desktop acceptance | M1 partial | Dockable pane, tree folding, cached/disconnected state, search and details inspected. Exhaustive keyboard/popout checks pending |
| Live Todoist acceptance | M1 reads verified | Complete account snapshot fetched through the new adapter, SecretStorage connection persists across reload, project grouping/search/details work. Mutations pending |
| Live Google acceptance | Pending | Stable event IDs, one exporter, description/color preservation and cleanup |
| Working-vault installation | Pending | Matching backup, exact artifact hashes, reload and normal-entry readback |

A passing focused suite establishes its covered behavior. The release record must state the inherited full-suite failure separately from new regressions. Completion requires the product scenarios above and honest evidence for any remaining external limitation.

## M1 foundation evidence

Checked on 2026-11-11 in an isolated desktop profile using Obsidian 1.13.7. Synthetic task data exercised parent trees, inherited grouping, selection and cached disconnected browsing. The provider adapter loaded a complete real account snapshot. Search narrowed the live pane to one task in its correct project/date group. Details opened the same task and exposed its provider link. Reopening the pane preserved the search and grouping. Its measured content width was 276px with zero horizontal overflow. Credentials persisted through plugin reload. Private screenshots and task-cache data are kept in ignored local test output.

Automated M1 tests cover pagination, malformed/repeated/duplicate resources, omission of credentials from snapshots, rejected account switches, failed-refresh cache preservation, disconnect/unload races, refresh coalescing, rate limits, second-writer detection, timezone day grouping, ancestor context, orphans/cycles, tree folding and a 2,000-level tree.

The new worktree initially checked out CRLF text despite LF repository attributes. Normalizing those bytes restored the recorded fixture offsets and formatting checks. The resulting source diff is restricted to the feature files. Full validation still stops at the inherited ICS test. The strict scorecard was run separately and passed.
