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
| New source checks | M3 coordinator verified | Task scheduling/input/migration/capture regression checks pass. Full-suite count and exact validation are recorded below. One inherited ICS timeout persists |
| Inherited ICS timeout | Known baseline issue | `tests/ical.test.ts`, last visible day inclusive case, independently reproduced on upstream previously |
| Synthetic desktop acceptance | M1 partial | Dockable pane, tree folding, cached/disconnected state, search and details inspected. Exhaustive keyboard/popout checks pending |
| Live Todoist acceptance | M2 editing and capture verified | Complete account reads, persisted credentials, native creation/edit/project move/subtask/completion/reopen, cursor-leave capture and explicit routing readbacks. All disposable task IDs returned 404 after cleanup. Recurring writes pending |
| Live Google acceptance | M3 scheduling verified | Stable event IDs across day/week moves, child description and planner color, explicit unschedule deletion and cleanup. Full reconciliation and exact live feed-policy acceptance pending |
| Working-vault installation | Pending | Matching backup, exact artifact hashes, reload and normal-entry readback |

A passing focused suite establishes its covered behavior. The release record must state the inherited full-suite failure separately from new regressions. Completion requires the product scenarios above and honest evidence for any remaining external limitation.

## M1 foundation evidence

Checked on 2026-11-11 in an isolated desktop profile using Obsidian 1.13.7. Synthetic task data exercised parent trees, inherited grouping, selection and cached disconnected browsing. The provider adapter loaded a complete real account snapshot. Search narrowed the live pane to one task in its correct project/date group. Details opened the same task and exposed its provider link. Reopening the pane preserved the search and grouping. Its measured content width was 276px with zero horizontal overflow. Credentials persisted through plugin reload. Private screenshots and task-cache data are kept in ignored local test output.

Automated M1 tests cover pagination, malformed/repeated/duplicate resources, omission of credentials from snapshots, rejected account switches, failed-refresh cache preservation, disconnect/unload races, refresh coalescing, rate limits, second-writer detection, timezone day grouping, ancestor context, orphans/cycles, tree folding and a 2,000-level tree.

The new worktree initially checked out CRLF text despite LF repository attributes. Normalizing those bytes restored the recorded fixture offsets and formatting checks. The resulting source diff is restricted to the feature files. Full validation still stops at the inherited ICS test. The strict scorecard was run separately and passed.

## M2 editing foundation evidence

The focused task suite has 34 passing cases. New cases cover narrow provider commands, saved UUID and temporary-ID replay, lost create responses across restart, readback failure after acknowledgment, failed intent persistence, account ownership, independent field edits, same-field conflicts and recurring completion targeting a changed occurrence.

Desktop acceptance created a disposable task through the pane's native dialog, edited its title/date/priority, moved it to another project and preserved its description. The same remote task ID was read back after editing. A child was created through Add subtask, completed through its row checkbox and reopened through Completed. Provider readback confirmed its parent relationship after reopening. The final snapshot had no pending operations or connection error. Deleting the disposable parent also removed its child, and both provider task endpoints returned 404. Private IDs and screenshots remain in ignored local output.

A long title exposed narrow-pane overflow during this check. Wrapping the task row corrected the measured horizontal overflow to zero. The parent tree and details remain independently scrollable. Exhaustive focus, popout, light-theme and recurrence acceptance remains scheduled for later milestones.

## M2 capture evidence

Seven capture regression cases cover parsed first-line tags, code/comments/escaped text/wikilinks/frontmatter exclusion, original CRLF source offsets, project/label routing, unavailable projects, ambiguity, complete initial indexing, cursor stability, repeated indexing, restart, concurrent manual/automatic capture, stale bytes and parent-before-child acknowledgment. A settings regression preserves account-scoped routing and migration defaults. Existing Google identity and canonical indexing tests pass after extracting the shared whole-block matcher.

Desktop acceptance used an actual Markdown editor in the isolated vault. No creation was queued while the tagged line held the cursor. Synthetic compositionstart/compositionend events verified the composition guard while moving the actual editor cursor to another line. After composition ended, provider readback showed one parent and one child in the parent's project. Two project tags paused the third task for review. Choose project opened the native routing dialog, and its Send to Todoist action created exactly one task in the selected project. A checked task and an inline-code example remained local. Reload and refresh preserved the three create operations and links. All three task endpoints returned 404 after cleanup, and the disposable note was removed.

This composition check exercises the editor integration and event guard. OS input-method acceptance remains pending. Source-side update propagation, schedule operations, conflict resolution and recurring completion remain in their dependent milestones.

## M3 foundation evidence

Three calendar-policy tests cover exact Google IDs and internet-calendar URLs, colliding ID/URL prefixes, fresh overlay updates, explicit disable, disconnect restoration, account replacement and persisted settings reload. Applying the policy preserves the underlying account configuration. A new note-writer test checks that preparation exposes exact before/after bytes without processing the existing note, then applies the plan through the calendar journal with the same block UID. Existing cross-note crash recovery and child-preservation cases pass.

The native Task calendar feeds dialog was inspected in the isolated desktop vault. Its enabled toggle saved and reopened correctly, then was restored to disabled. Load calendars displayed connection guidance in that profile, which has no Google authorization. Live Google feed selection and integrated schedule readback remain pending.

### Duration capability and acknowledged-field verification

A disposable provider contract check saved an exact task start and preserved its description. The same acknowledged command requested a duration, but readback returned null. The account's duration capability was unavailable. The implementation now reads that entitlement, rejects unsupported duration intent before persistence, and retains full planned intervals in the local/Google scheduling design. A later live check confirmed that this guard adds no operation. The test task was deleted and its endpoint returned 404.

The outbox now persists a verified readback before another command edits the same task. Regression cases cover ignored provider fields, equivalent UTC/floating timezone representations, successive changes to one field, restart after verification with failed snapshot publication and detachment from mutable caller objects. A renewed desktop check created, completed and reopened a disposable task through native controls. Each operation retained its matching readback, including the archived completed task. Cleanup returned 404.

Registry v2 migration was checked in the isolated desktop profile. Namespace and operation count matched the original state, and the content-addressed v1 backup matched the original bytes. Automated cases also cover failed backups and unsupported future versions.

A28 must exercise both capability states. Accounts with duration support synchronize it to the provider. Accounts without that capability synchronize the start while retaining the planned interval in Markdown and Google. Paid-provider duration readback remains unverified.

### M3 scheduling coordinator evidence

The durable coordinator saves the task/account owner, drop nonce, source bytes, provider field patch, prepared note edits and independent provider/calendar phase before the corresponding side effects. Task and Google identities remain stable during moves. A prepared note reserves its capture identity before link acknowledgment, preventing a second automatic creation. Registry v3 migration preserves verified provider readbacks and backs up original v1/v2 bytes. Future formats remain untouched.

Focused regression cases cover repeated/concurrent drop delivery, existing Google block adoption, first-intent failure, cross-day interrupted note writes and restart, independent Google retry after verified task success, untimed Markdown relocation, changed-destination conflict, unschedule date preservation, child retention, protected Markdown regions, literal tag/block-ID/time-looking title handling, DST gaps/repeated offsets and drag ownership/expiry. The scheduling/input/registry/capture subset has 26 passing cases.

In an isolated desktop profile, the native Schedule dialog created a 45-minute interval and one managed Google event. Provider readback confirmed its scheduled start. The event retained the planner color and contained the child checklist text in its description. Synthetic HTML5 events exercised the actual Svelte day and week drop handlers. Moving to another day retained the same event ID and 45-minute duration. Remove from schedule opened its native confirmation, retained the provider date and checklist children, and deleted the owned event. The public Markdown editor-drop handler moved the same linked checklist into another note. Its internal link ID and child text remained intact. Readback then confirmed both disposable provider tasks returned 404 and the Google event was absent/cancelled. The disposable note was removed.

Selected-task controls initially overflowed a narrow pane. Wrapping those controls and placing schedule chips below the task title produced zero measured horizontal overflow in the pane, list and details. Native pointer input could not activate the isolated window and its native capture was black. Actual pointer drag and OS input-method acceptance remain pending. Synthetic DOM event acceptance is recorded separately from those checks.

Full source validation passed formatting, standard/style lint, TypeScript and Svelte with zero diagnostics. The full suite had 753 passes, one inherited ICS timeout, nine skips and 17 todo cases. Strict scorecard and production build also passed. Review additionally found and corrected task-view registration after failed registry initialization. An isolated desktop check loaded an unsupported future task schema, verified that calendar startup continued and the future bytes stayed untouched, then restored the original bytes and reloaded scheduling successfully.

Remaining M3/M4 acceptance includes timeline resize/direct-note edits, explicit native-exporter collision handling, exact live selected-feed exclusion, offline supersession and field conflict resolution. M5 recurrence/history and independent child scheduling remain pending. The feature build has not been installed into the working vault.
