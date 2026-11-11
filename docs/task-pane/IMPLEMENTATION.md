# Implementation sequence

## M0 Reviewed design and contracts

Deliver the stories, technical specification, acceptance matrix, goal prompt and reviewed mockup gallery. Confirm production baseline and a separate development worktree. Verify the old plugin/feed situation from installed settings. Review generated screens against capture, date, identity and recurrence semantics. Resolve contradictory UI before using screenshots as implementation guidance.

Completion evidence is the design review, screen traceability and a committed design package. The baseline is already pushed at `82ae46ff`. The unused previous sync plugin was backed up outside the vault and uninstalled. Existing Todoist task links were not found in the planning notes inspected.

## M1 Connected task browser

Implement provider-neutral snapshot records, Todoist v1 paginated reads, account validation, SecretStorage connection, versioned cache and lifecycle-safe refresh. Add dockable Tasks, date/project grouping, search, tree expansion, selection and read-only task details. Account replacement must be explicit. Display cached data and clear connection/error states. Keep unsupported actions out of the first milestone's live UI.

Run A01–A12, A52 and A56 as applicable. Test partial pagination, stale responses after disconnect, account separation and deep/cyclic parent data. Use synthetic data to inspect the actual Svelte pane in a disposable Obsidian vault. Complete provider read acceptance before describing it as connected and verified.

## M2 Durable edits and capture

Add a versioned operation outbox, field baselines, runtime-checked mutations and command UUID recovery. Implement new task, title/description/project/label/priority edits, completion and mapped #todoist capture. Introduce settings together with their UI and migration. Test create-response loss and repeated indexing before enabling automatic creation. Add the inline routing popover and ambiguity choice.

Dependencies are M1's account identity and complete snapshots. Acceptance covers A13–A18, A41, A44 and relevant token/permission cases. Desktop capture acceptance must include real editor cursor movement and IME behavior.

## M3 Scheduling and calendar ownership

Extract a small public identity/projection interface around existing Google note identities. Add the shared scheduling coordinator, day/week drops, Markdown drops, keyboard Schedule, resize, move and unschedule. Add exact legacy-calendar exclusion with restoration. Adopt existing Google event mappings. Persist note intent before writes and integrate the existing move-recovery journal.

Dependencies are M2's durable identities and operations. Acceptance covers A19–A21 and A24–A38 as applicable, including no duplicate feed after refresh/restart. Validate the note block and event ID through normal entry points.

## M4 Reconciliation and recovery

Connect note, pane, Todoist and Google changes through field-level reconciliation. Add conflict UI, read-before-write checks, origin handling, independent acknowledgment of task and calendar phases, retries, account reattachment, explicit unlink/delete semantics and second-writer detection. Extend synthetic failure injection across every acknowledged boundary.

Acceptance covers A22–A23, A28–A30, A35–A36, A39–A46, A51, A55 and A56. Record the actual Todoist concurrent-write limitation after live verification. A newer upstream version appearing during a conflict-resolution dialog must trigger a fresh comparison.

## M5 Recurrence, subtasks and identity repair

Implement occurrence identities, completion history, next-occurrence transition, safe recurring rescheduling, parent/child semantics and explicit copy/link repair. Add independent child scheduling. Reuse existing compact layout and Google description export. Verify recurring completion and undo against disposable real tasks.

Acceptance covers A18, A20–A21, A37 and A47–A50. Recurrence history must survive restart, offline completion and a moved note. Unsupported provider undo semantics must have explicit UI and documented acceptance evidence.

## M6 Integrated release

Verify all cases against the exact combined feature/hotfix tree. Review screen fidelity, 320px panes, keyboard focus, light/dark theme, popout lifecycle, performance, export and existing calendar workflows. Build and back up the working vault before installation. Restore the relevant calendar-display selection according to the task integration's recorded policy. Complete live readback and test cleanup.

Completion requires acceptance evidence for the supported workflows, a pushed branch, a usable build and installed verification. Carry genuine remaining limitations into user-facing documentation and the final report.

## Current progress

- M0 complete. Eight boards were reviewed across three passes. Targeted revisions corrected connection, capture, recurring occurrence, conflict, schedule-chip and count inconsistencies.
- M1 browser foundation implemented. Provider reads, SecretStorage connection, complete cached snapshots, account validation, lifecycle guards, date/project grouping, search, tree folding, read-only details and pane reopening work in an isolated desktop vault. Live reads loaded a complete account snapshot. Seventeen focused regression tests pass. Remaining M1 acceptance covers exhaustive keyboard/popout behavior and connection-dialog account-switch presentation, with working-vault installation scheduled in M6.
- M2 editing and capture implemented. A versioned registry persists intent before provider writes. Todoist commands reuse saved UUIDs across uncertain responses and restarts. Native task dialogs support creation, narrow field edits, project moves and subtask creation. The pane supports completion, pending status, retry and reopening completed nonrecurring tasks. The canonical index contributes unscheduled task candidates. Stable #todoist lines capture through account-scoped project/label routing with explicit ambiguity review. Simultaneous capture paths reuse a durable source identity. Live desktop verification covered mutations, cursor-leave capture, simulated composition gating, parent/child creation, routing choice and restart, followed by authoritative cleanup checks. Actual OS input-method composition and exhaustive routing-dialog keyboard checks remain in release acceptance.
- M3 scheduling coordinator implemented. Day/week pane drops, native keyboard scheduling, schedule chips, Markdown insertion/moves and explicit unschedule use one durable coordinator. Exact Google calendar IDs and internet-calendar URLs can be selected per task account. A connected account's enabled policy filters both overlay sources and survives refresh. Disconnect restores their display. Source and Google identities remain internal. The existing calendar note journal applies prepared before/after edits and recovers interrupted cross-note moves. Live Todoist/Google readbacks covered scheduling, repeated moves with the same event ID, child descriptions, planner colors, Markdown relocation and unschedule. The disposable tasks and event were removed and their deletion was read back. Native pointer drag and OS input-method acceptance remain pending because the native test window could not be activated. Timeline resize and direct note/provider edit propagation depend on M4 reconciliation.
- A live M3 contract check exposed an acknowledged duration that the free provider plan ignored. Duration capability now guides the scheduling contract. The outbox verifies actual fields per command, persists readback and supports restart between verification and cache publication. Registry v2 migration keeps a content-addressed v1 backup. Native creation/completion/reopen acceptance passed after this change and all disposable tasks were cleaned up. Paid-provider duration acceptance remains pending.
- M4 note/provider reconciliation implemented for title, nonrecurring completion, mapped project/label edits and planned intervals. The canonical capture index and stability guard provide source identity. A separate acknowledged note baseline preserves formatting and routing semantics. The existing schedule journal applies note writes and ordered provider commands, then acknowledges Google separately. Date-only remote moves retain clock time and duration. Unscheduled provider dates stay metadata. Child text changes refresh the parent's Google description. A native provider-command comparison revalidates the task and intent before saving fresh replacement commands. Source-level disagreements persist their baseline and both current values for review. The shared conflict dialog now offers current-note/provider choices, including planned intervals, and revalidates source bytes, provider values, the link baseline and account settings before saving the projection. Offline supersession now persists task/note acknowledgment independently, permits later edits and source-conflict choices, recovers uncertain owned calendar writes and carries unfinished removals across restart. The remaining unlink/delete recovery UI is in progress.
- M5–M6 planned.

The feature worktree exposes browsing, connection, task editing, tagged Markdown capture, linked scheduling and automatic note/provider reconciliation. The remaining recovery surfaces, recurrence/history and release acceptance follow their dependent milestones. Scheduling preserves the Todoist date when removing a time block. A per-account switch controls whether scheduling updates that task date. Unavailable provider duration remains in Markdown and Google. Registry v6 migrates earlier versions through an original-byte backup and retains acknowledged note text separately from current source identity. The working vault runs the calendar baseline with the independently installed rename hotfix at `4431a998`.

### Next reconciliation work

The automatic comparison and journal handle direct timed-note edits, which also receive normal timeline move/resize writes. Both conflict controllers revalidate their latest comparison. Calendar-only retries yield to later edits after durable task acknowledgment. Explicit unlink and tag-removal decisions are implemented below. Complete missing-source handling and remote-delete choices. Verify exact live feed selection and native exporter collision handling. Recurrence and independently scheduled children retain their M5 acceptance requirements.

### Custom panel implementation

Boards 09–11 refine the Morgen-inspired visual design. The Tasks ItemView now hosts a fully custom Svelte panel with scoped dark/light tokens, flat controls, circle checkboxes, search, grouping, tree rows, interval chips and adaptive details. Create, edit, connect, schedule, capture settings, routing, unschedule and conflict review use custom forms. External timeline/editor commands reuse the same forms in styled hosts. A single collapsed disclosure summarizes pending changes and review issues. Custom row menus support keyboard navigation and restore focus after closing. Escape handling is scoped to the panel.

The editor's extracted domain helpers preserve opened field baselines, recurrence metadata and narrow commands. Twelve focused editor/component regressions cover those contracts, Escape composition, toolbar routing, late-save callbacks and review counts. The isolated browser preview verified the new surfaces at 320px and 800px, in dark and light themes, with zero measured horizontal overflow. Full validation has 830 passing tests and the inherited ICS timeout. Strict scorecard and production build pass. Desktop takeover is deferred until after the user's 22:00 IST gate. Recurrence, recovery and release acceptance continue under M4–M6.

### Scoped source recovery foundation

Identity inspection now reports ambiguous links per note while retaining safe matches. Capture excludes unresolved candidates in that note and continues in unaffected notes. Reconciliation exposes individual source issues for the affected links and continues applying independent note edits. Original links remain intact for the upcoming unlink/repair workflow. Six new regressions cover shared matcher compatibility, multiple affected notes, capture isolation and integrated reconciliation. The focused subset has 57 passes. Full validation has 836 passing tests and the inherited ICS timeout. Strict scorecard and production build pass.

### Explicit unlink

The custom details surface now offers a confirmed Unlink note action. Registry v7 retains its local note intent, original acknowledged note baseline and recovery data. The coordinator removes the parent's parsed capture tag, preserves all other note bytes and nested links, and detaches the active task projection after note acknowledgment. It sends no task mutation and leaves the ordinary Day Planner calendar mapping available. Earlier uncertain exports and explicit removals remain retryable, with unlink completion blocking a new schedule until they settle. Tests cover intent failure, interrupted note writes, acknowledgment failure after a successful note write, restart, offline calendar recovery, later local edits, source stability, schema validation, parsed tag handling and confirmation/error UI. The focused subset has 68 passes. Full validation has 850 passing tests and the inherited ICS timeout. Strict scorecard and production build pass. Tag-removal prompts, missing-block unlink and identity repair remain next.

### Capture-tag removal decisions

Removing an acknowledged #todoist tag now pauses field propagation and exposes Review link. Confirming uses the unlink journal. Cancel, Escape, form close, form switching and pane close restore the tag through a local repair journal. Registry v8 preserves the previous common note baseline throughout that repair. Other title, interval and provider changes reconcile afterward. Source/account validation, failed intent persistence, interrupted writing, failed acknowledgment after a successful write and uncertain calendar recovery are covered by regression tests. Runtime validation excludes provider commands and new calendar exports from tag repair. The five-file subset has 91 passing cases. Full validation has 873 passing tests and the inherited ICS timeout. Formatting, standard/style lint, TypeScript, zero-warning Svelte diagnostics, strict scorecard and production build pass.

### Native custom panel acceptance

The isolated Obsidian window is accessible through the authorized Windows helper. Native forms created a disposable parent and child, scheduled a 45-minute block, restored a removed capture tag through Cancel and confirmed explicit unlink. Todoist and Google readbacks verified saved task descriptions, child parent/project identity, the Google child checklist and retained event identity. Ordinary calendar sync then exported a local title edit after unlink while Todoist retained its original title. Both task endpoints returned 404 after cleanup, the event was absent/cancelled and the fixture text was removed.

Native drag retests reached trusted entry/over handlers with accepted move effects, including after a full application reload, but ended before drop. End-to-end native drag remains pending. Opening workflows and details now collapses expanded review content to keep narrow forms visible. Tests cover that transition and unlink sentence spacing. Missing-source behavior, remote deletion, exact live feed/exporter checks, recurrence/history and remaining release acceptance continue under M4–M6.

### Custom task calendar settings

Capture and routing now opens Task calendar feeds inline. The full settings entry reuses the same custom Svelte form. It retains exact Google IDs and internet-feed URLs, unavailable saved selections, the hide-feeds switch and the schedule-to-task-date choice. Google calendar names and IDs distinguish sources. Internet-feed URLs stay out of visible text. Loading and saving validate the original task account, and a late load after closing cannot update another surface. Saves preserve current routing and unrelated settings. Four component cases and one pane-entry case cover exact selections, unavailable sources, cancellation, loading failure/retry, account replacement and concurrent unrelated settings. The calendar-display subset has 24 passing cases. Native acceptance follows against the isolated build.

## Working conventions

Keep implementation in the feature worktree. Reserve the baseline checkout for hotfixes. Commit reviewable milestones and keep this progress section current. Inspect the working tree before editing after interruptions. Reuse the existing parser, note writers, calendar ownership and rendering pipeline. Expand tests only for changed contracts and demonstrated failure risks. Preserve the existing full-suite ICS failure in the evidence record.
