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

### Live missing-source verification

The v8-to-v9 migration retained the original bytes in a matching content-addressed backup. The first desktop check exposed unloaded Markdown views without editor instances. The stability guard now uses Obsidian's isDeferred API before accessing an editor. A dedicated lifecycle regression covers deferred and loaded tabs with focus transitions.

Disposable live checks used the existing task service and schedule coordinator, fixture-only note edits and two full application reloads. Deleting the timed subtree detached its root and child links with no added provider operation. Both Todoist tasks retained their identities, descriptions and relationship. Restoring exact original note bytes after reload recovered the original root link, 45-minute event and generated child description. A second deletion used ordinary calendar sync with its deletion policy enabled. Direct readback confirmed the old event absent/cancelled and its UID tombstoned. After reload and restoration, the original Todoist task/link had exactly one active event with a fresh event identity, the same interval and child description. Both cycles finished without a pending fixture operation or source issue.

Cleanup returned 404 for both provider tasks, confirmed both known calendar events absent/cancelled, removed fixture text and restored the prior deletion setting. A final refresh/reload found no fixture task or active link, zero pending schedules, zero review issues and no task-service error. Private journals and IDs stay in ignored verification output. This verifies the default missing-block portion of A36. Permanent remote deletion remains open. Full validation has 902 passes and the inherited ICS timeout. Required source checks, strict scorecard and production build pass. Search returned to an earlier value after full-window reload during native verification, leaving leaf-state persistence in M6.
