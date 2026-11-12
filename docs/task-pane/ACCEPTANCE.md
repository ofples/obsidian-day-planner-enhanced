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

## Recurring command groundwork

Registry v11 backs up original v10 bytes before retaining occurrence-aware command metadata. Focused adapter, service, queue, operation, conflict, registry and schedule checks cover completion counters, stable occurrence keys during rescheduling, immutable reset preferences, duplicate offline requests, reserved schedule identities, stale displayed rows, lost responses across restart, malformed provider data and refreshed legacy snapshots. Completion readback requires one counter increment and the preserved repeat rule/timezone. A changed date alone fails verification. A final completed task can end the series. The ten-file subset has 162 passes.

Disposable live free-account probes confirmed stable task IDs, advancing counters and an explicit provider undo restoring the earlier due value/counter. Activity evidence arrived after the immediate read. The tested completed-task endpoint interval contained no recurring fixture entry. The documented subtask-reset flag was accepted in both numeric and boolean forms, including an explicit next due value, while the checked child remained checked. Provider tree readback determines displayed child state. The parent and child were deleted and individually confirmed absent.

Full validation has 974 passes and the inherited inclusive-last-day ICS timeout, with nine skips and 17 todo cases. Formatting, standard/style lint, TypeScript, zero-warning Svelte diagnostics and production build pass. This verifies command groundwork for A48–A50. Full occurrence history, local/calendar freezing, exact occurrence undo, independent children and M6 release acceptance remain pending.

### Installed recurring-command verification

Matching bundle hashes and a full plugin backup preceded installation in the isolated vault. Migration preserved exact v10 registry bytes and loaded v11. Native search and checkbox input completed a disposable parent. Provider readback showed the same task ID, exactly one counter increment, the next date, the preserved repeat rule/description, original child relationship and one active next task. The native pane displayed the next task under Tomorrow. Replaying the original completion UUID retained the counter.

A stale displayed baseline produced an unsent conflict. Native review disabled the saved completion and applied the selected current Todoist state. The stale intent became cancelled while the counter stayed unchanged. Product deletion removed the fixture tree and retained recovery history. Final refresh/reload verified all contract/pane fixture tasks absent, zero active fixture native calendar echoes, preserved completion readback, zero pending operations/schedules, zero source/reconciliation issues, restored pane preferences and no task-service error. This is installed command-level evidence. A47–A50 retain their full occurrence/history and child-workflow requirements.

## Occurrence freezing and history

Integrated fixtures reuse the production note writer, calendar engine, task service, capture index, scheduler and reconciler. A pane-origin recurring completion checks the historical block and retains its children, original calendar UID/event and immutable captured baselines. The next occurrence receives fresh links/events. Restart retains both occurrences. An independently scheduled child keeps its own projection and parent relationship.

Calendar-only history retries remain durable while the next occurrence is scheduled and through restart. Interrupted note writes retain their saved plan and finish without another provider completion. Focused edits defer freezing and preserve their local text. Historical unchecks reserve the old identity for review. Moving a completed note updates current history navigation while preserving the original captured source and active next link. Older sent commands recover an occurrence journal with explicit provenance and their original UUID. Exact v11 bytes are backed up before v12 migration.

Custom-pane checks cover historical metadata and note navigation, distinct occurrence rows sharing one task ID and retry/error behavior. Full validation has 986 passes, the inherited inclusive-last-day ICS timeout, nine skips and 17 todo cases. Formatting, standard/style lint, TypeScript, zero-warning Svelte diagnostics and production build pass. Native installed/API acceptance, local-checkbox and external completion, exact occurrence undo and full child/copy repair remain pending.

### Installed occurrence-history verification

The isolated installed build matched its source bundle hash, retained a full plugin backup and preserved exact v11 bytes during migration. Native completion of a disposable scheduled parent automatically froze its checked 45-minute note and nested child link. Direct Google readback retained the original event ID, interval, mapped color and child description. The active provider task kept its ID and advanced one counter/date. Native history details and note navigation displayed the saved occurrence and checked note.

Scheduling the next occurrence produced fresh note/calendar identities and a separate event with the same mapped color. The past note/event retained its original time. Reload retained both mappings, immutable original baselines and exactly one completion command. Product deletion and fixture cleanup restored original note bytes/file absence and removed both managed events. Final readback confirmed all fixture tasks/events absent, zero native echoes, retained history/recovery records, zero pending operations/schedules, zero source/reconciliation issues and unchanged calendar settings.

This supplies installed pane-origin A47 evidence and recurrence identity/color evidence for A48. Local-checkbox and external completion, exact undo and full child/copy repair continue. Preference restoration reproduced the missing workspace-save callback. An explicit workspace save restored the original pane state. The automatic persistence source fix and lifecycle regression receive their own installed acceptance.

### Installed pane-preference verification

The matching source build was installed with a full plugin backup and equal bundle hashes. Native search entry and project grouping saved automatically to the actual workspace file and survived a full reload. Native controls restored the original search/grouping, which saved and survived another reload. Readback matched the entire serialized pane state. This verifies automatic preference persistence through the normal callback. The earlier history cleanup used an explicit workspace save before the fix.

Final refreshed API/state checks still found no disposable tasks/events, no native echoes, restored note bytes/file absence and original calendar/pane settings. History/recovery records remained intact with zero pending operations/schedules or source/reconciliation issues. Full source validation has 988 passes and the inherited ICS timeout, nine skips and 17 todo cases. Other source checks, the strict scorecard and production build pass. Timeline selection returned to today while the previous note stayed open after reload, leaving date/navigation restoration in M6.

### Markdown-origin recurring completion

Integrated cases verify source-checkbox completion with the original event/link retained in history, a fresh next task and one completion UUID. Title/time edits complete before the occurrence advances. Remote rescheduling within the same counter follows the existing link/event. A lost completion response retries its original UUID after restart. A stale completion can keep the current open task and reconcile its provider date. A reviewed replacement completion retains its own verified historical baseline, including earlier resolved title choices.

Completion-only commands acknowledge Todoist during a calendar outage and retry the calendar phase after restart. Simultaneously removing the source time retains an untimed checked history item and removes its owned event. Refreshed legacy counters work with their matching due value. Runtime checks reject mismatched combined-journal identities. Exact v12 bytes are backed up before v13 migration. Source stability defers a parent while a descendant line is focused.

Seven focused files have 154 passes. The full suite has 1,002 passes, one inherited inclusive-last-day ICS timeout, nine skips and 17 todo cases. Formatting, standard/style lint, TypeScript, zero-warning Svelte diagnostics, the separate strict scorecard and production build pass. Installed native/API acceptance, external completion, exact undo and remaining M5/M6 acceptance continue.

## Failure-injection matrix

Exercise each mutation at the boundaries before intent save, after intent save, after local write, after remote success with a lost response, after remote acknowledgment save, after Google write and before operation completion. Restart after every injected failure. Required outcomes are one task per create operation, one event per occurrence, preserved source text and a retriable or explicitly conflicted operation.

Use deterministic provider responses for focused regression tests and a real disposable task for final provider semantics. Include a recurring parent and child and an account/project permission failure in live acceptance. Keep private task/calendar IDs in the local acceptance record and clean up test artifacts.

## Release evidence

| Evidence | State | Required record |
| --- | --- | --- |
| Baseline source | Confirmed | `82ae46ff` equals origin `feat/google-calendar-sync` |
| New source checks | M4 automatic note/provider reconciliation verified | 792 full-suite passes and one inherited ICS timeout. Source formatting, standard/style lint, TypeScript, Svelte, strict scorecard and production build pass |
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

Remaining M3/M4 acceptance includes native timeline resize, explicit native-exporter collision handling, exact live selected-feed exclusion, offline supersession and note-field conflict resolution. Direct-note time edits are covered by the M4 evidence below. M5 recurrence/history and independent child scheduling remain pending. The feature build has not been installed into the working vault.

## M4 provider-command conflict foundation evidence

Twelve conflict regression cases cover narrow per-field choices, changed values while a comparison is open, failure before resolution persistence, concurrent submissions, disconnect during comparison, a missing task, acknowledged-create repair without recreating it, coupled placement/schedule values, advanced recurring completion rejection, preserved common note baseline, lost replacement response across restart and invalid replacement chains. Original command payloads stay intact. Replacement commands retain saved UUIDs across retries and keep their position before later queued edits.

A scheduling integration regression resolves a saved provider date conflict by accepting its date-only value. It moves the linked note with its child to that day, preserves clock time/duration and creates one Google event. It sends no superseded provider command. Input checks cover date-only and instant changes, unavailable/available duration, cleared provider date and a DST-gap rejection.

Live acceptance created a disposable task through Add task and applied a separate fixture-only provider edit. Saving a stale local title produced a real preflight conflict. Review opened the native comparison with original, saved and current values. A second provider edit while the dialog was open caused Apply choices to refresh the comparison and preserve the suspended command. Choosing the saved title again completed a fresh update on the same task ID. Provider readback confirmed the selected title and preserved description. The original command was cancelled with a recorded replacement UUID. Cleanup returned 404.

A further UI review compared this dialog to board six. It removed the duplicate whole-task commit action. The final dialog has Apply choices and Cancel, keeps contested values unselected and disables Apply choices until each choice is made. A renewed live fixture confirmed that a refreshed comparison disables it again and choosing a value enables it. Resolution retained the task identity and description, and cleanup returned 404. Its measured horizontal overflow was zero. Native pointer/OS input acceptance remains pending as recorded above.

Registry v4 adds explicit replacement command relationships and migrates earlier formats through original-byte backups. The isolated desktop migration retained the namespace and previous intents, and the v3 backup filename matched its content hash. At that checkpoint, the full suite had 767 passes, one inherited ICS timeout, nine skips and 17 todo cases. Required source checks and production build passed.

## M4 automatic note/provider reconciliation evidence

Registry v5 retains acknowledged note text separately from the source's current location and bytes. Ordered provider commands and source disagreement records share the existing registry. The schedule coordinator applies prepared note edits through the calendar journal and verifies each provider phase before calendar acknowledgment. Unchanged registry transactions still verify writer ownership and skip redundant disk writes. Migration preserves the last acknowledged projection and leaves legacy captured links eligible for comparison with their provider baseline.

New regressions cover local title edits with independent provider description edits, remote title/completion, local completion/reopen, manual timed-note changes, remote date-only moves, preserved event identity, mapped project and label changes, provider-only labels, changed routing configuration, unscheduled task dates, native IDs/comments/CRLF child content, active-source deferral, a provider race after the note intent and position refresh between adjacent blocks. A captured untimed task gains note navigation without creating a calendar interval. Same-field disagreements preserve both sources and can converge when edited to the same value. Recurring checkbox changes pause for occurrence handling. The scheduling/reconciliation/migration subset has 30 passing cases. Input regressions additionally preserve literal HTML/comment-like titles, percent signs, backslashes, routing-tag-like text and native-ID-like text through Markdown encoding.

Live acceptance used a new disposable parent and child created through the pane. The native Schedule dialog placed the parent in a daily note and created one managed event. Editing the title through the Markdown editor and leaving its line automatically updated Todoist and the same Google event. The task description and nested child survived. Separate fixture-only provider edits then renamed both tasks and changed the parent's date to a date-only value. Refresh moved the linked note to that day, kept 08:00–08:45, retained the same event ID and color value, and updated the generated Google child description. There were no pending fixture operations or source issues at readback.

Checking the child in Markdown completed that same provider task and checked its entry in the Google description. Reopen from the pane's Completed section cleared the note and calendar checkboxes. Explicit unschedule removed the event and retained the linked checklist. Cleanup then confirmed both provider task endpoints returned 404, the managed event was absent/cancelled and the fixture subtree was removed from the test note. Private IDs and readbacks stay in ignored local output.

At that checkpoint, the full suite had 784 passing cases, one inherited ICS timeout, nine skips and 17 todo cases. Required source checks, strict scorecard and production build passed. The native desktop inventory does not expose the isolated Obsidian test window, including after the desktop was unlocked, so actual pointer drag/resize and OS input-method acceptance remain pending. Missing-link/unlink/delete recovery, offline supersession, exact live feed/native exporter checks and M5/M6 acceptance remain open.

### Source conflict choices

The shared native dialog now handles note/provider disagreements. Current note and Current Todoist values are shown alongside their common baseline. Planned intervals include the task date and supported provider duration. Contested values start unselected. Revalidation checks current source bytes, canonical identity, common baseline, task/account values and routing settings. A newer comparison clears choices and requires fresh input. Selected changes enter the existing durable projection coordinator with an expected-link comparison in its intent transaction.

Eight added regression cases cover both title choices, independent provider edits, note/provider changes during review, selected provider intervals, concurrent submissions, failed intent writes, a blank local title and a simultaneous local move/provider date clear. Choosing the provider after a date clear keeps its date absent and restores the selected planned interval. A blank local title offers the valid provider title without sending an empty update. Existing provider-command conflict tests continue to use the same dialog/controller interface.

Live acceptance created a disposable task through Add task and inserted its linked checklist into a test note. Holding the editor cursor on its line deferred propagation while separate local/provider title edits were made. Leaving the line produced a source conflict. Review fields showed Original, Current note and Current Todoist with zero measured horizontal overflow and a disabled Apply choices button. Another provider title/description edit while the dialog was open refreshed the comparison and cleared the selection. Choosing Current note again updated the same task ID, retained the newer description and cleared the issue. The task endpoint returned 404 after cleanup, and the test note was removed.

The source-conflict checkpoint has 792 full-suite passes, one inherited ICS timeout, nine skips and 17 todo cases. Formatting, standard/style lint, TypeScript, Svelte diagnostics, strict scorecard and production build pass. The working-vault installation remains scheduled for M6.

### Independent calendar recovery and later edits

Task/note acknowledgment is saved before the calendar phase. A later edit can replace an acknowledged Calendar-only retry, preserving its original intent, successor UUID, uncertain export snapshots and explicit event removals. Source conflict review remains available during that retry. Schedule-only operations acknowledge their changed fields and preserve pending note/provider title edits for reconciliation. Capture reservations end after the corresponding note link is registered.

Regression cases cover Calendar outages, lost create/update responses, restart after supersession, explicit unschedule followed by an untimed edit and reschedule, uncertain-create cleanup, failed successor persistence, concurrent title changes during a schedule move, conflict choices during an outage and v5 migration backup. Calendar recovery checks preserve external Google disagreements and reject another vault's deterministic event. Equivalent supported ISO timestamps compare by instant. The focused scheduling/registry/capture/reconciliation/calendar subset has 100 passing cases.

Live acceptance created a disposable task through Add task and scheduled it through the native dialog. Fault injection called the real Calendar create, retained its returned event ID in the private fixture journal, then discarded that response before the mapping was acknowledged. Calendar retries were held offline. A Markdown editor title change still reached the same Todoist task, retained its description and superseded the old calendar intent with the same Google UID. Reloading the plugin removed the fault injection and recovered the uncertain event through the saved predecessors. Direct readback confirmed one active fixture event, the original event ID and Google UID, the edited title, the 45-minute interval, a complete final operation and no task issue. Explicit unschedule removed the event. The fixture text was removed and the provider endpoint returned 404 after cleanup.

This checkpoint has 806 full-suite passes, one inherited ICS timeout, nine skips and 17 todo cases. Formatting, standard/style lint, TypeScript, Svelte diagnostics, strict scorecard and production build pass. The feature remains in the isolated test vault. Unlink/delete recovery, recurrence/history, independent children, exact feed/exporter checks and integrated release acceptance remain pending. The separate baseline rename hotfix was installed and pushed independently at `4431a998`.

### Combined rename hotfix and recovery

The baseline rename repair is included in feature commit `7137427e`. Timed note writes always acknowledge canonical identity, including byte-identical recovery, and registered task projections retain their Google UID. The combined focused subset passed 131 cases. The full suite had 818 passes and the inherited ICS timeout, with required source checks, strict scorecard and production build passing.

A disposable fresh-note fixture verified combined title/time edits while Calendar was offline. Recovery retained one event with the same ID and UID, the selected 45-minute interval, the updated Todoist title/date and no source issue. Reusing an earlier test note exposed stale links left by deleted fixtures and a resulting ambiguous-source/native-calendar replacement collision. That failure remains part of the explicit unlink/stale-source recovery acceptance. All fixture tasks, notes and created events were cleaned, with provider 404 and absent/cancelled event readbacks. Native pointer drag remains unverified.

### Custom panel preview evidence

The custom UI was exercised in a hidden isolated browser using synthetic fixtures, real TaskService command/conflict controllers and an in-memory provider. Editing retained the selected task and restored row-menu focus. Subtask creation displayed the new child. Custom scheduling updated the complete interval chip. Explicit unschedule retained the checklist and displayed an unscheduled detail state. Capture settings rejected duplicate routing tags and saved valid mappings. Disconnect disabled writes, and token reconnect restored them. A provider preflight conflict showed unselected field choices and disabled Apply choices. Selecting the saved value resolved it through the real command controller and cleared the compact review summary.

Keyboard checks covered ArrowDown opening the custom menu, End focusing its last link, Escape closing it and returning focus, and form focus restoration. Narrow details, list, settings and long wrapped titles measured zero horizontal overflow at 320px. The light-theme list/details split measured zero horizontal overflow at 800px. Search clear and focus styling were refined after screenshot review. These browser checks use a simulated scheduling boundary. Actual Obsidian integration, native drag/resize, OS input-method composition and popout acceptance remain in M6.

Eight editor regression tests cover original recurrence metadata, date-only edits, explicit date clearing, label deduplication, parent project inheritance, frozen command baselines, ordered project moves, account changes and no-op saves. Four component regressions cover pane-scoped Escape, composition-safe Escape, inline capture settings, a late save finishing after a newer editor opens and a deduplicated collapsed review count. The current full-suite run has 830 passes, one inherited ICS timeout, nine skips and 17 todo cases. Formatting, standard/style lint, TypeScript, strict scorecard and Svelte checks pass with zero Svelte diagnostics. Production build succeeds. Synthetic preview screenshots are retained in ignored local verification output.

### Scoped ambiguity recovery foundation

Identity inspection reports ambiguous link IDs by note after completing safe matches. A capture regression rewrites two linked tasks simultaneously and adds a tagged task in another note. Only the independent task is created, original links remain byte-equivalent, a repeated scan creates nothing further and both unresolved IDs are available for review. Another regression retains an exact known link in the affected note. Shared matcher tests preserve strict rejection for existing callers and report several affected notes without claiming a missing link.

The scheduling integration fixture rewrites a parent and child while independently editing an untimed linked task in another note. Reconciliation creates two individual source issues, updates the independent Todoist task, preserves the original parent and calendar event and reports no global capture/reconciliation error. Explicit unlink/repair actions and native-calendar collision acceptance remain pending. The focused subset has 57 passing cases. Full validation has 836 passing tests, one inherited ICS timeout, nine skips and 17 todo cases. Source checks, strict scorecard and production build pass.

### Explicit unlink foundation

The custom details surface confirms Unlink note. Integration tests retain the exact timed note except its parent capture tag, nested links, Todoist task and existing event ID. Untimed Markdown formatting, comments, native IDs, nested tags and CRLF bytes remain byte-equivalent. Re-indexing creates no replacement task. The journal handles failed intent persistence, interrupted note writes and a successful note write followed by failed link acknowledgment, then resumes after restart.

Calendar-outage tests unlink after a real simulated lost-create response and after an already authorized event removal. The active task link detaches after note acknowledgment. A restart completes inherited recovery with the original event ID or finishes the earlier removal. Subsequent independent local edits survive. Schema tests reject task commands and new schedule targets in unlink journals. Component tests require confirmation, retain it while saving, scope Escape during the save and preserve actionable errors. Registry v6 bytes are backed up before v7 migration. Native/disposable-provider acceptance follows in the isolated vault. Tag-removal prompts, default missing-block behavior and copied-block recovery remain pending.

The unlink subset has 68 passing cases. Full validation has 850 passing tests, one inherited ICS timeout, nine skips and 17 todo cases. Formatting, standard/style lint, TypeScript, strict scorecard, zero-warning Svelte diagnostics and production build pass. Original acknowledged note bytes are retained in the unlink journal alongside its current source and task baseline.

### Native custom pane and drag entry

The local Windows helper activated the isolated Obsidian window after the desktop change. Native controls created a disposable parent through the custom form, selected its project, saved its description and created a child through keyboard submission. Authoritative Todoist reads confirmed the saved description, child parent ID and inherited project. The custom narrow pane displayed both rows. These fixture identities and screenshots remain in ignored local verification output.

The first native drag produced trusted pointer-down, drag-start, drag-enter and drag-end events with the correct task MIME payload, then ended before drag-over or drop. It created no task projection or calendar event. The timeline now accepts the payload on initial entry as well as drag-over. Three component regressions cover entry acceptance, immediate enter/drop scheduling and expired/foreign rejection. Full validation has 876 passing tests, the inherited ICS timeout, nine skips and 17 todo cases. TypeScript, zero-warning Svelte diagnostics, strict scorecard and production build pass.

Native retests included a full isolated-window reload. A bubble-phase observer confirmed that trusted drag-enter and drag-over were cancelled and the move effect was accepted. The helper still finished with drag-end and no drop. Four attempts created no scheduling intent or event. Native end-to-end drag acceptance remains pending. Capture-phase microtask observations ran before the delegated handlers and therefore could not determine final cancellation. The bubble-phase record is the relevant evidence.

Native controls opened the custom Schedule form, selected its date through the calendar picker, changed its duration and submitted the visible action. Authoritative readback confirmed one 45-minute event, the child checklist in its description, the saved Todoist description and no pending fixture operation. A fixture-only note edit removed the capture tag. Native Review link and Cancel restored the exact original note bytes, retained the task/event identities and cleared the fixture issue. Native details and confirmed Unlink note detached the active task link while retaining the task and calendar mapping. A subsequent fixture-only local title edit and ordinary calendar sync updated the same event ID while Todoist retained its original title and description. Cleanup returned 404 for both disposable tasks, confirmed the event absent/cancelled and removed the fixture subtree. Private identities, event traces and native screenshots remain in ignored local output.

The expanded review list consumed most of the narrow confirmation surface during native review. Opening a task workflow or details now collapses that list. Regression coverage also checks spacing between the unlink explanation and its conditional sentence. The focused custom-panel subset has 13 passing cases. Full validation retains 876 passes and the inherited ICS timeout. Formatting, standard/style lint, TypeScript, zero-warning Svelte diagnostics, the separately rerun strict scorecard and production build pass.

### Capture-tag removal decisions

Removing a previously acknowledged capture tag now creates an unresolved link decision before task or schedule fields propagate. Regression tests combine tag removal with a title edit, an interval edit and an independent provider description edit. Keeping the link restores the tag and then reconciles those fields using their original baseline. Tag-only removal restores the original note bytes and sends no task command. Confirming unlink detaches the original link and creates no replacement task.

Repair tests cover failed intent writes, interrupted note writes, successful note writing followed by failed acknowledgment, outstanding task conflicts and lost calendar responses. Restart keeps the same event identity and eventually exports the selected title/time. Schema validation rejects provider mutations, unlink and new scheduling in tag-repair journals. Registry v7 bytes are backed up before migration to v8.

Component tests exercise Cancel, Escape, close, switching forms, failed restoration and confirmed unlink. View lifecycle tests exercise pane close and persisted recovery after a failed close-to-restore. Contested tag decisions remain actionable while restoration is pending. The five-file subset has 91 passing cases. Full validation has 873 passing tests, one inherited ICS timeout, nine skips and 17 todo cases. Required source checks, strict scorecard and production build pass. Native acceptance is pending against the isolated build. The local Windows helper can now activate its window after the desktop change.

### Installed Markdown-origin recurring completion

The isolated installed source matched its bundle hash and preserved the exact original v12 registry bytes before migration to v13. Controlled vault API edits changed a disposable recurring parent's title/time while native source-editor focus deferred reconciliation. A real Markdown checkbox click and native focus change triggered the ordinary automatic path. Readback verified one ordered update/completion journal, its final completion UUID, one counter increment and the renamed next occurrence at the edited clock.

The checked historical note and child text remained at the original date. Google retained that event's ID, mapped color and child description at the edited historical time. Native history details showed the saved occurrence, next date and child and opened the saved note. Next-occurrence scheduling created fresh note/calendar identities. Full reload retained both mappings, the immutable captured completion baseline and exactly one completion command. No task/schedule operation or source/reconciliation issue remained pending.

Cleanup removed the fixture task tree and managed events and restored the original note bytes or file absence. Its first preference restoration reloaded before the debounced save completed. Native restoration was subsequently confirmed in the saved workspace and through another reload. Final provider/state readback found zero active native echoes, restored pane/calendar settings, retained history/recovery records and no task-service error. Title/time editing in this check used the vault API. Checkbox, focus, history and navigation input used the native desktop. External recurring completion, exact undo and remaining M5/M6 acceptance continue.

### Nested occurrence identity regression

Reordering checked historical and open current blocks in one note originally exchanged their identical child identities. The regression now retains both parent/child link pairs, their captured history baseline and the completion counter through restart, with no extra provider command. Shared matcher checks also cover moved notes, preassigned historical parents, partially edited containers, identical siblings beneath edited parents, unresolved parent edits and copied parent blocks. These cases preserve existing ambiguity diagnostics and reserve copies for review.

The three-file subset has 123 passes. Full validation has 1,010 passes, the inherited inclusive-last-day ICS timeout, nine skips and 17 todo cases. Required source checks, the separate strict scorecard and production build pass. Installed native/provider verification of the new nested matching remains pending. The preceding installed Markdown-completion evidence applies to its earlier source build.

### Installed nested occurrence verification

The isolated installed bundle matched the committed source hash and retained a full matching plugin/state backup. Controlled domain operations created historical and active recurring blocks in one note, and fixture-only vault API editing reversed their order. Automatic capture retained the historical/current child links under their respective parents and preserved the captured completion baseline.

Native source-checkbox input completed the active child. Authoritative readback verified that child completed once while the recurring root retained its one completion increment. Only the intended current-child note checkbox changed. The past child and past Google description stayed unchecked. The current event description became checked. Both event IDs, intervals and mapped colors remained correct. Reload retained both child scopes, original history, both calendar mappings and exact command counts, with zero pending operations or source/reconciliation issues.

Product deletion removed the root and its known completed child. Cleanup restored the original note bytes or file absence, removed both managed events and restored pane/calendar settings. Final refreshed/reloaded checks found fixture tasks/events absent or cancelled, zero native echoes, preserved recovery/history and no task-service error. The block move used the vault API. Checkbox and focus input used the native desktop. Full validation remains at 1,010 passes and the inherited ICS timeout. External recurrence, exact undo, complete copy/link repair and remaining M6 acceptance continue.

### External recurring completion regression

Counter evidence from the complete task snapshot or individual final-task read saves a durable external observation before historical note writes. Tests verify one advance, several advances, the original task/child/source baseline, preserved past event identity/time, fresh next-occurrence identities and no provider completion command. Repeated refresh/restart retains one observation. Focused edits, failed observation persistence, interrupted note writes and calendar failures recover through the existing journals.

Account disconnection, foreign identities, missing counters, pending child commands, blocking schedules and deletion recovery preserve their ownership/reservation boundaries. A removed capture tag retains its link decision, and keeping the link then allows historical freezing. A same-counter date move creates no completion history. Normal unchanged recurring tasks require no extra identity scan, provider read or registry transaction. Migration preserves exact original v13 bytes. Component checks distinguish external provenance, current-task observation timing and multiple counter advances.

The three-file subset has 153 passes. Full validation has 1,029 passes, the inherited inclusive-last-day ICS timeout, nine skips and 17 todo cases. Required source checks, the separate strict scorecard and production build pass. Installed external-completion acceptance remains pending at this source checkpoint. Exact undo and remaining M5/M6 acceptance continue.

### Installed external completion verification

The isolated bundle matched the committed build and had a full plugin/state backup. Migration retained exact original v13 bytes before v14. A controlled provider command completed a disposable scheduled recurring parent outside the plugin's outbox. Authoritative readback confirmed one increment and the next date. Native Refresh tasks triggered ordinary snapshot/reconciliation processing, which saved the external observation, checked the past note and archived its child link with no plugin completion command.

Native history details displayed the saved occurrence, description, child, external provenance and observed current date and opened the historical note. The pane/form had zero horizontal overflow at 300px. Google retained the past event's ID, interval, mapped color and child description. Scheduling the next occurrence created fresh links/calendar identities. Full reload retained both mappings, the captured baseline, the external observation and one counter increment. No task/schedule operation or source/reconciliation issue remained pending.

Product deletion removed both fixture tasks and preserved history/recovery. Cleanup restored original note bytes or file absence, removed both managed events and restored pane/calendar settings. Workspace storage was checked before reload. Final API/state readback confirmed fixture tasks/events absent or cancelled, zero native echoes, preserved history and no task-service error. This is live API evidence for a completion outside the plugin outbox, with native refresh/history/navigation acceptance. Exact undo, complete copy/link repair and remaining M6 acceptance continue. Full validation remains at 1,029 passes and the inherited ICS timeout.

### Exact undo command regression

The command/receipt transaction retains the original occurrence counter/date, current task/children and both historical/following source mappings. Tests complete a task, queue undo offline, repeat the request and restart with one saved UUID. Lost responses replay that UUID and restore the counter once. Failed intent persistence sends no command. Unsent cancellation races the preflight read safely. A claimed command requires verification. Later completions and reschedules reject stale payloads, while a fresh review of a rescheduled current occurrence can restore the selected prior completion.

Readback validation couples the task ID, previous counter, due value and unchecked state. An already applied provider undo verifies without another write. Unrelated title/description/label edits survive. Missing, foreign and altered undo receipts prevent replay. A verified readback survives a failed snapshot publication and restart. The integrated schedule fixture retains both note/event mappings and source bytes while its verified provider undo waits for local recovery. Tree edits, scheduling and deletion remain reserved.

Older cached account metadata can queue offline undo using the adapter's declared capability, while explicit denial still blocks it. Exact v14 registry bytes are backed up before v15 migration. The six-file subset has 191 passes. Full validation has 1,051 passes, the inherited inclusive-last-day ICS timeout, nine skips and 17 todo cases. Required source checks, the separate strict scorecard and production build pass.

These cases establish provider-command groundwork for A49. Custom confirmation, local note/calendar restoration and installed undo acceptance remain pending. The complete undo workflow is unfinished.

### Missing-source recovery foundation

Regression checks cover deleted timed parent/child blocks, a deleted note file, exact Undo after restart, provider edits while detached and a fresh export identity after ordinary calendar deletion. Missing-source intents issue no note or provider write. Tests interrupt intent, local acknowledgment and archive acknowledgment writes, then restart and restore the same Todoist link. An uncertain calendar create carries its original event identity through deletion, restart and restoration. An already restored document cancels a stale detachment intent.

Capture tests cover stale-index cross-note moves, an unavailable note preventing deletion proof, duplicate archived identities producing one review item, account replacement, an existing canonical link and restoration with automatic capture disabled. Schema checks reject provider fields and note edits in missing-source journals. The v8 migration backs up original bytes before writing v9. The six-file subset has 122 passing cases. Full validation has 901 passes, the inherited ICS timeout, nine skips and 17 todo cases. Native/disposable-provider acceptance is pending.

### Custom calendar configuration

The inline Task calendar feeds entry and full settings entry share one custom form. Regression checks retain exact selected IDs and URLs, saved unavailable sources and unrelated routing settings. Cancel preserves settings bytes. A changed task account blocks saving and rejects late calendar results. Failed loading preserves selections and permits retry. Internet-feed URLs stay out of visible form text. The focused calendar/pane/lifecycle/display subset has 24 passing cases. The full suite has 881 passes and the inherited ICS timeout, with nine skips and 17 todo cases. Formatting, standard/style lint, TypeScript, zero-warning Svelte diagnostics, strict scorecard and production build pass.

Native entry opened the inline form and loaded 11 actual Google calendars. The form and labels measured zero horizontal overflow. Saving exposed reactive selection arrays reaching Redux's freezing boundary. The save now copies them into ordinary arrays. The form regression runs its settings subscription through the real display policy and Redux store to cover that boundary. The isolated configuration was restored before the corrected build's retest.

The corrected native form selected the exact Todoist calendar, enabled hiding and saved successfully. Live Google display readback had two Todoist events and 32 other events with that policy disabled. Enabling it produced zero Todoist events and retained the other 32. A full isolated-window reload retained the exact selected ID and the same displayed counts. The original isolated configuration was then restored byte-equivalently for the affected settings. This check changed local display settings and read existing calendars. Exact live internet-feed selection and native Todoist exporter collision handling remain pending.

### Permanent deletion recovery regression

The custom confirmation, original account/task receipt, stable delete UUID, individual readbacks and local unlink recovery have regression coverage. Cases stop a pending deletion during its awaited preflight read, detect changed root/child fields and membership, resume lost acknowledgments, retain partial verification through permission/read failures and restart, and complete after a failed snapshot publication without repeating deletion. Missing or foreign receipts and providers without individual reads send no command.

Linked-note cases preserve timed parent/child text and calendar events, resume an interrupted note write, reserve descendants against competing edits, retain a surviving moved child's link and unlink independently scheduled children through their own notes. Known completed descendants remain in recovery and leave the reopen list. Restored original Markdown after deletion opens a saved-task review and creates no replacement task. Custom pane cases cover cancellation before confirmation, changed comparisons, pending confirmation Escape/close handling and history with an empty active list. Registry v9 bytes are backed up before v10 migration.

The seven-file subset has 149 passes. Full validation has 934 passes, one inherited ICS timeout, nine skips and 17 todo cases. Required source checks, the separate strict scorecard and production build pass. Full lint exits at the inherited test failure. Disposable live provider deletion, native confirmation/history and installed v10 migration remain pending at this source checkpoint.

### Live permanent deletion verification

Native controls in the isolated vault opened the custom deletion form for a disposable parent/child tree. The form and 300px pane measured zero horizontal overflow. Cancel retained both tasks and exact note bytes. Native confirmation saved the recovery record and completed Todoist's parent deletion. Individual reads verified root and child absence. The record preserved both descriptions and original task/link identities. Local timed checklist text and the same 45-minute Google event remained, with the child in its description.

Native history review displayed the saved description/subtask and navigated to the retained note. A tagless local child initially produced a redundant recovery notice. The capture correction reserves the archived identity while showing that notice for #todoist capture attempts. Its regression checks the plain checklist before restoring original Markdown. The corrected installed build cleared source issues after full reload. Restoring original fixture bytes then opened the expected saved-deletion review, created no replacement intent and retained completed history through another reload.

The matching v9 migration backup preserved original bytes. Cleanup removed the fixture event and subtree and restored prior Tasks preferences. Final refresh/reload verified task absence, event absence/cancellation, no fixture text, preserved two-task metadata/history, zero pending operations, zero source/reconciliation issues and no task-service error. Full validation has 934 passes, one inherited ICS timeout, nine skips and 17 todo cases. Formatting, standard/style lint, TypeScript, zero-warning Svelte diagnostics, the separate strict scorecard and production build pass. This closes the explicit provider-delete portion of A36. Provider deletion lacks a conditional tree-version precondition, and unknown completed descendants may have no locally saved details. Exact live feed/exporter checks, recurrence/history and release acceptance remain open.

### Desktop internet-feed verification

Controlled HTTP fixtures exercised actual Obsidian fetching and parsing. Their URLs differed by a query string. Both events initially reached the displayed timeline. Native custom settings selected one exact feed and saved hiding. The display then retained the other feed through explicit refresh, native date navigation and full-window reload. The form measured zero horizontal overflow. Disconnect restored both events after the reactive update, and reconnecting the same account reapplied its saved exclusion.

Cleanup restored the original empty internet-calendar list and original account settings, reloaded and verified zero fixture events and exclusions. The helper server was stopped. This adds desktop HTTP-source evidence for A32 and A33 alongside the earlier live Google-source readback. Actual Todoist native-exporter collision handling remains open under A34. Source validation counts remain at the preceding 934-pass checkpoint with the inherited ICS timeout.

### Exporter collision regression

API cases recognize exact native Todoist task-source URLs across recurring-master pages and date ranges. Ordinary description links, other source hosts/paths and cancelled events complete their checks. Malformed ownership identities, malformed/repeated pages and permission failures retain a failed preflight. Original managed-account validation and explicit task-feed selection apply before source scanning, including an empty feed with hiding disabled.

Normal Google service initialization/sync tests verify that a detected exporter sends only reads and preserves the original registry before note access. A cleared source permits fresh preflight. Task scheduling retains the local block and pauses before task-date writes, survives restart and finishes the same intent after resolution. Untimed insertion completes through its local journal. The custom disclosure labels a preflight error for review and dispatches its Retry action. Four focused files have 133 passes. Full validation has 957 passes and the inherited ICS timeout, with nine skips and 17 todo cases. Source checks, strict scorecard and production build pass. Installed/native source-fixture acceptance remains pending at this source checkpoint.

### Live native exporter and duplicate verification

The isolated installed bundle matched the built source hash and had a matching plugin/state backup. Read-only checks detected actual Todoist source events. A controlled source-marked event in the managed calendar, dated outside the schedule window, paused a disposable task schedule before its provider-date command. The local block and saved intent survived full reload. The provider date remained unset and no second managed event existed. Ordinary Google sync also rejected that exporter.

After removing the controlled source, automatic retry completed the same intent. Readback verified one date command, one 45-minute event, the generated child description, both task descriptions and the child relationship. Temporarily selecting the target as a task feed also rejected export with hiding disabled. Restoring the exact selection permitted fresh preflight.

The native Todoist integration created a real calendar copy. Displayed-block readback initially had one local task and one native copy, with the managed overlay already suppressed. Native custom settings enabled exact native-feed exclusion, leaving one local task and retaining a separate calendar-context event. After reload and navigation to the scheduled date, the same counts held. The custom review UI exposed the collision and Retry. Automatic recovery finished before native Retry was invoked.

Product deletion removed the root/child and kept their deletion history. The native calendar copy outlasted the first cleanup wait and was subsequently cancelled by Todoist. Final cleanup/readback verified both tasks, the managed event, controlled source/context events and native echo absent or cancelled. Note text was removed and original account/calendar settings restored. Reloaded state had complete schedule/deletion records, zero pending operations, zero source/reconciliation issues and no task-service error. This supplies live A34 evidence and same-task duplicate evidence for A32–A33. Detection uses observable source events and explicit feed IDs, with the preflight/write race described in the technical specification. M5 and remaining M6 acceptance continue.

### Live missing-source verification

The v8-to-v9 migration retained the original bytes in a matching content-addressed backup. The first desktop check exposed unloaded Markdown views without editor instances. The stability guard now uses Obsidian's isDeferred API before accessing an editor. A dedicated lifecycle regression covers deferred and loaded tabs with focus transitions.

Disposable live checks used the existing task service and schedule coordinator, fixture-only note edits and two full application reloads. Deleting the timed subtree detached its root and child links with no added provider operation. Both Todoist tasks retained their identities, descriptions and relationship. Restoring exact original note bytes after reload recovered the original root link, 45-minute event and generated child description. A second deletion used ordinary calendar sync with its deletion policy enabled. Direct readback confirmed the old event absent/cancelled and its UID tombstoned. After reload and restoration, the original Todoist task/link had exactly one active event with a fresh event identity, the same interval and child description. Both cycles finished without a pending fixture operation or source issue.

Cleanup returned 404 for both provider tasks, confirmed both known calendar events absent/cancelled, removed fixture text and restored the prior deletion setting. A final refresh/reload found no fixture task or active link, zero pending schedules, zero review issues and no task-service error. Private journals and IDs stay in ignored verification output. This verifies the default missing-block portion of A36. Permanent remote deletion remains open. Full validation has 902 passes and the inherited ICS timeout. Required source checks, strict scorecard and production build pass. Search returned to an earlier value after full-window reload during native verification, leaving leaf-state persistence in M6.

### Undo recovery source regression

The custom history confirmation shows current/restored dates, source paths, cached-state disclosure and conversion of following schedules into local checklists. Source changes refresh the comparison and require another confirmation. Saving disables closing and Escape. Pending undo shows recovery retry, and cancellation is available only before the provider command starts. Undo conflicts open occurrence recovery.

Integrated tests restore historical root/child identities and the original event mapping while retaining the following local calendar block. Interrupted following and historical note writes resume their saved UUIDs after restart. Calendar failure permits local acknowledgment and a later task edit, then converges the original event. Current completed children stay checked, and moved or missing children retire the historical task link without child provider commands. A later completion after verified undo prevents local restoration and retains actionable recovery. Competing retired source identities stay ambiguous. Version migration includes v15 and retains exact original bytes.

The full suite has 1,066 passes, the inherited inclusive-last-day ICS timeout, nine skips and 17 todo cases. Source formatting, standard/style lint, TypeScript, zero-warning Svelte diagnostics and production build pass. The separate strict scorecard passes. Full lint stops at the inherited test failure. Native installed confirmation, provider readback, note/calendar restoration and cleanup remain required for complete A49 acceptance.

### Installed undo API readback

An exact source build, matching bundle hashes, full plugin backup and original v14 migration bytes were verified in the isolated vault before v16. A disposable parent/child was scheduled, completed and scheduled again. The child was checked before the product controller reviewed and confirmed undo. Todoist readback retained the root ID, restored the original counter/date and repeat rule, and kept the child checked under the same parent. One undo command and four completed source journals restored the historical active links and retired the following sources into local checklists.

Both Google event IDs, intervals, mapped colors and child descriptions were retained. Reload preserved the same undo/source UUIDs, original completion baseline and restored mappings, with zero pending operations or source/reconciliation issues. Cleanup removed the task tree and managed events, restored original note bytes or file absence and confirmed zero native calendar echoes. Pane/calendar settings and occurrence/undo/deletion history were retained through another reload.

This supplies installed API evidence for A49 recovery and restart. The native helper initially captured the isolated window, then lost access to it after reload while the domain API continued working. Confirmation/recovery used the product controller API. Native confirmation, queued cancellation and pointer drag acceptance remain pending. Full source validation stays at 1,066 passes and the inherited inclusive-last-day ICS timeout.

### Copy reservation regression

A copied linked block in another note now reserves both roots before automatic task creation. Nested parent copies reserve their original descendant identities. Their saved task links and source bytes are retained while an independent note still captures normally. Identity review retains the candidate inventory. Distinct linked identical tasks remain distinct, and native IDs supply copy evidence within their original note. Tests cover edited IDs, line endings, tagless local children after undo and unique moves.

The four-file subset has 159 passes. Full validation has 1,075 passes, the inherited inclusive-last-day ICS timeout, nine skips and 17 todo cases. Required source checks, the separate strict scorecard and production build pass. This establishes copy reservation for A20�A21. The complete custom assignment/create workflow and installed acceptance remain pending, so US-12 stays open.

### Durable source-choice regression

The custom form exposes all three source actions, explicit path/line selections, copied-tree creation and saved source history. Changed comparisons clear selections. Saving disables close and Escape. Queued recovery uses a derived cancellability value from the complete outbox and source state. Known local copies can later enter a fresh separate-task decision. Source metadata retains the original note bytes and opt-in tags.

Controller checks cover keeping or moving the original link, copied-parent and child creation, checked children, current provider title/project choices, inherited child project, bulk parent renames, offline restart, interrupted intent writing, a moved/renamed selected source, lost create responses, concurrent confirmations and safe cancellation. Missing, foreign and modified source receipts block replay. A retained first-send timestamp prevents cancellation after a transmitted command returns to pending. Registry migration preserves exact v16 bytes before v17.

The scheduling fixture verifies both canonical calendar events, original task/child ownership, selected task-side event adoption and restart with zero source issues. The six-file subset has 229 passes. Full validation has 1,105 passes, the inherited inclusive-last-day ICS timeout, nine skips and 17 todo cases. Required source checks, the separate strict scorecard and production build pass. This supplies source-level A20�A21 evidence. Installed native/API acceptance, historical copy ownership, incomplete-tree reassignment and older-state restoration review remain pending for complete US-12/A46 acceptance.

### Installed source choices and deletion recovery

The source-choice build was installed in the isolated vault with matching bundle hashes, a complete plugin backup and exact original v16 bytes preserved before v17 migration. A disposable linked parent and child were copied into a second daily note. Keep one linked retained both original task IDs and the original source. Move link transferred those same identities to the selected copy. Create separate task generated a fresh parent/child pair under the reviewed project. Both canonical Google events retained their identities, intervals, mapped colors and generated subtask descriptions. Exact note bytes and opt-in tags were preserved by each source decision.

Full reload retained the three decisions, four source identities, provider relationships and selected calendar mappings. Replaying the same saved create comparison reused its decision without extra provider commands. The custom source form rendered without horizontal overflow at an internal width below 250px. These actions used product controller APIs and rendered-form inspection. Native confirmation and cancellation remain pending while the user is using the desktop.

Live deletion exposed a collision between an already deleted identical tree and the surviving copied child's raw text. Capture now resolves proven same-note whole-block containers and nested offsets before detached-source restoration. The dedicated regression reproduced the live failure before the change. Four focused files have 179 passes. Full validation has 1,107 passes, the inherited inclusive-last-day ICS timeout, nine skips and 17 todo cases. Source checks, zero-warning Svelte diagnostics, the separate strict scorecard and production build pass.

The fixed build was installed with matching hashes and a full plugin backup through plugin-only reload. The existing deletion journals then completed with their original identities. Cleanup verified all four provider tasks and both managed events absent or cancelled, zero native calendar echoes, restored original note absence, restored pane/calendar settings, retained source/deletion history, zero pending commands/schedules, zero identity/reconciliation issues and no task-service error. Private proof journals stay in ignored output. Historical-copy ownership, unfinished-tree reassignment, older-state restoration repair and remaining M6 acceptance stay open. The working vault retains the baseline hotfix.

### Historical source ownership

Source review now includes completed recurring occurrence links alongside active links. Registry v18 records each historical source's occurrence owner. Keep and Move update that occurrence's current source metadata and preserve its immutable completion baseline. Separate-task creation uses fresh task/source command identities and retains the copied checklist status. Cancellation of an unsent decision restores metadata within its original owner. Provider send, replay and verification require that historical ownership still agrees with the reviewed source. A changed or undone occurrence leaves recovery pending for review.

The custom form labels completed occurrences in source selection and saved history. Regression coverage verifies root/child ownership, original task counter/date, unchanged note bytes, separate checked task trees, restart, safe cancellation and changed-owner rejection. Integrated calendar tests exercise both Keep and Move through recurring undo. They retain both canonical events and adopt the selected source's event when the occurrence becomes active again, while preserving the original completion baseline.

Full validation has 1,116 passes, the inherited inclusive-last-day ICS timeout, nine skips and 17 todo cases. Formatting, standard/style lint, TypeScript, zero-warning Svelte diagnostics, the separate strict scorecard and production build pass. Migration coverage includes exact v17-byte preservation. Installed historical-copy API/native acceptance remains pending at this source checkpoint. Unfinished-tree source reassignment, older-state restoration repair and remaining M6 acceptance continue.

### Installed historical-source API verification and baseline merge

The v18 source build was installed in the isolated vault with matching bundle hashes, a full plugin backup and exact v17 migration-byte preservation. Disposable live readback verified Keep, Move and Create against a completed recurring parent and its child. Historical links stayed with the selected completed occurrence. The original task retained counter one, its repeat rule and child relationship. Separate creation produced fresh non-recurring parent/child identities and a verified completion command for the checked root. Both canonical Google events retained their IDs, intervals, mapped colors and subtask descriptions.

Plugin-only reload retained all three decisions and the immutable occurrence baseline. Replaying the saved create review reused its decision without another command. Rendered saved history identified both completed-occurrence sources and had no horizontal overflow below 250px internal width. Native input acceptance remains pending while the user is using the desktop.

Controlled cleanup reopened the separate completed fixture before product deletion. Readback verified all four tasks and both managed events absent or cancelled, zero native calendar echoes, restored original note absence and pane/calendar settings, retained source/deletion history, zero pending work and zero identity/reconciliation issues. These fixture actions used product APIs throughout.

The feature worktree then incorporated baseline hotfix 87de378b for verified calendar deletion after note edits. Merge resolution preserved shared source identity matching, note transaction recovery and task/calendar projection recovery. Empty-title recovery now uses the owned event's empty title consistently. Regression coverage retains both verbatim and untimed section moves. The five-file combined subset has 240 passes. Full combined validation has 1,124 passes, the inherited inclusive-last-day ICS timeout, nine skips and 17 todo cases. Required source checks, zero-warning Svelte diagnostics, the separate strict scorecard and production build pass. Combined installed readback remains the next step. Unfinished-tree reassignment, older-state restoration repair and remaining M6 acceptance stay open.

### Installed combined calendar verification

The combined feature/hotfix build was installed in the isolated vault with matching bundle hashes and a full plugin/state backup. Post-install readback retained the historical source decisions and clean recovery state. Review identified one remaining empty-title path in task-side projection removal. Two focused service regressions reproduced the rejection before correction. That method now shares the calendar engine's exact owned-event check and empty-title handling. Additional regressions reject an orphan event with a different vault, block or event identity.

The final four-file subset has 212 passes. Full validation has 1,129 passes, the inherited inclusive-last-day ICS timeout, nine skips and 17 todo cases. Formatting, standard/style lint, TypeScript, zero-warning Svelte diagnostics, the separate strict scorecard and production build pass. The final installed bundle matches the built source and retains the complete v18 state backup.

A disposable live daily note exercised normal Google sync with a time-only block and a neighboring titled block. Google omitted the empty summary. Recovery retained its event identity. Removing that block while adding prose and editing the neighbor deleted the original event, tombstoned its mapping and retained the neighbor's event identity and interval. A second owned time-only event with no saved mapping was removed through the task-side projection-removal API and received its own tombstone.

Cleanup verified all three Google events absent or cancelled, original note absence and exact calendar settings restored through plugin-only reload. Final readback retained the occurrence's immutable completion baseline and source decisions, with zero pending commands/schedules, zero identity/reconciliation issues and no task/calendar error. The working vault's bundle still matches the separate baseline checkout at hotfix 87de378b. Native confirmation, cancellation, pointer/IME/popout acceptance, unfinished-tree reassignment, older-state restoration repair and the remaining M6 work continue. Private journals and identifiers remain in ignored output.
