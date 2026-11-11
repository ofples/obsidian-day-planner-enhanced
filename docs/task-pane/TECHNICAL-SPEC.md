# Technical specification

## Outcome and boundaries

Build one integrated Tasks pane for Todoist, with a generic task service boundary, linked Markdown projections and the existing Google Calendar sync. Preserve the production calendar bridge and plain daily notes. The first implementation milestone provides connected, cached browsing. Subsequent milestones enable mutations and scheduling after their failure-recovery tests pass.

Deadline editing is deferred. Existing upstream deadline data is preserved by field-specific patches. Multi-user distributed editing and a hosted auth relay are outside this release. Detect a second writer and stop writes until state is reloaded. Use synthetic fixtures in the repository and keep credentials, vault data and private screenshots outside Git.

## Invariants

1. A remote task is identified by provider, account ID and remote task ID. A recurring occurrence adds a stable occurrence key.
2. Each occurrence has at most one active scheduled Markdown projection and one managed Google event. Multiple untimed references may navigate to the canonical projection.
3. Remote task identity, source block identity and Google event identity are distinct fields. Adopt existing Google mappings through their canonical local block identity.
4. Every external write has persisted intent, a stable operation identity and a recovery path. Baselines advance only for acknowledged fields.
5. A missing result, failed page, changed filter or unavailable note is insufficient evidence of remote deletion.
6. Note writes compare the current source to the scanned bytes and retain unrelated text, child content, line endings and native block IDs.
7. Every projection change enters the same reconciliation queue. Origin annotations suppress echo without suppressing a subsequent user edit.
8. Provider descriptions and content are untrusted text. Use text nodes or the existing safe Markdown rendering path. Validate external URL schemes and provider origin.

## Components and integration points

| Component | Responsibility | Existing integration |
| --- | --- | --- |
| TaskProvider | Normalize one account's tasks, projects and capabilities | Todoist API v1 transport |
| TaskService | Connection lifecycle, complete snapshots, cache, refresh, sync status | Obsidian SecretStorage and plugin lifecycle |
| TaskRegistry | Task/occurrence/projection links, field baselines, tombstones | Reuse Google local identities through a small public identity API |
| TaskReconciler | Three-way merge per field, operation planning and conflict records | Common queue for note, pane and provider changes |
| TaskOutbox | Persisted operations and acknowledged phases | Plugin adapter, serialized writer and generation guard |
| TaskProjectionService | Find, create, move, resize, unschedule and repair note blocks | PeriodicNotes, ListItemEntryEditor, TransactionWriter, VaultIndexAdapter |
| TasksView | Dockable host, commands, view state and Svelte lifecycle | ItemView, mount/unmount, existing context boundaries |
| TasksPane and TaskDetails | Grouping, search, tree, status, task actions | Existing Obsidian colors, typography, controls and icons |
| TaskScheduleCoordinator | Accept drops and keyboard scheduling, reuse Google identity | Existing use-edit pipeline, planner parser, Google engine |
| CalendarDisplayPolicy | Exclude selected legacy feed and owned event projections | Google view adapter, ICS selector, exact calendar/source IDs |

Keep provider HTTP calls out of components and keep Todoist-specific fields inside its adapter. Introduce writable provider capabilities when their first operation is implemented. A future provider may support fewer fields and exposes those restrictions through task details.

## Domain records

`ProviderTask` contains source identity, title, description, project and parent IDs, labels, priority, completion, provider task date, duration, recurrence, source order, assignee, source revision and URL. Preserve the provider's original date-only value and timezone alongside normalized instants. Date-only values are local calendar dates and never pass through UTC midnight conversion.

`TaskLink` contains a generated local task key, remote key, occurrence key, per-field baseline and a list of projections. A projection records local block UID, path, raw source fingerprint, previous source text, native block ID when available and scheduled interval when present. The source block UID can reference an existing Google identity. The Google state file remains authoritative for its event mapping.

`Occurrence` contains remote task ID, previous due identity, completion identity when supplied by the provider, completion state and the current projection. Finishing a repeat freezes the completed occurrence and opens a new occurrence after the provider readback. Never reuse the previous schedule link based solely on an unchanged remote task ID.

`TaskOperation` contains UUID, account, task key, origin, kind, expected baseline, field patch, note before/after images, provider command UUID, Google block UID, phase, attempts, next retry time and last classified error. Phases progress through prepared, local-applied, remote-acknowledged, calendar-pending and complete. A conflict suspends the affected fields without discarding this record.

## State storage and concurrency

M1 stores a versioned `task-cache.json` with a generated vault namespace and the last complete account snapshot. It contains no credentials. The versioned `task-state.json` registry and outbox preserve the cache schema as a read model. Registry v2 adds persisted provider readback, v3 adds schedule intents/projections and v4 adds conflict replacement relationships. Migration retains a content-addressed backup of original older-version bytes before writing the current format. A failed backup or unsupported future version stops registry writes and preserves the original file. Use matching backups for restoration.

Use a single service operation queue and coalesce refresh requests. Compare the last serialized disk state before every state mutation. A mismatch reports another writer, stops mutation and preserves local changes for recovery. Persist a before/after journal before touching a note. Resolve account and lifecycle generation after every asynchronous boundary so a disconnected account cannot repopulate the pane.

A snapshot is published only after all user, task, project and required section pages finish and validate. A failed page retains the previous snapshot. Repeated cursors stop with an error. Cache load failures report an actionable recovery message and preserve the damaged file. Initialization does not clear user data automatically.

## Todoist adapter and authentication

Use `https://api.todoist.com/api/v1`. Read account identity, cursor-paginated tasks and projects. Add sections and labels when their editing/filter UI lands. Runtime-validate responses and fail a refresh as a whole if required identity or structural fields are invalid. Preserve empty titles as returned for display, but reject empty local creates. Reject temporary `tmp-` resource IDs for writes.

Initial connection accepts an API token and validates it before saving to SecretStorage under the generated vault namespace. Keep the previous credential and snapshot until the new connection validates. An account switch requires an explicit action after showing the detected account. Later OAuth uses an application configuration, state validation, verified redirect and the same token store. A mockup's Connect button must invoke a real available connection path.

Map 401/403 to reconnect or permission feedback, 429 to Retry-After, and transport/5xx to bounded exponential backoff with jitter. Expose a manual Retry action and retain successful cached data. Never put tokens or upstream response bodies in notices or logs. Cancel scheduled retries on plugin unload.

Use Todoist command UUIDs for durable mutations where supported. Verify the exact command contract against the official API before introducing each mutation. Do not assume Google-style conditional ETags exist on Todoist. Re-read the remote task before a write, merge against the last acknowledged field baseline, apply the narrow patch, and read back. A change racing between read and write remains a provider limitation, which must be recorded in acceptance evidence. [Todoist API reference](https://developer.todoist.com/api/v1/)

An API acknowledgment advances an operation to acknowledged. Verify the requested field values before advancing it to verified, and persist that task readback before processing a later edit to the same task. A complete snapshot then advances verified operations to complete and publishes their read model. Readback failure resumes verification through the saved operation. A returned value that differs from the requested patch creates a reviewable conflict. Compare normalized instants when the provider expands a timezone or human-readable date string.

Provider duration support is a capability. Todoist exposes its premium entitlement through `is_premium`, and its duration feature requires Pro or Business. A free-plan contract check acknowledged a duration patch while returning a null duration. Scheduling therefore keeps the full interval in the local projection and Google Calendar, synchronizes the task start, and sends provider duration only when supported. Existing duration fields remain readable in older cache shapes. [Todoist duration availability](https://www.todoist.com/help/todoist/features/set-a-task-duration-L1kYkZv8d)

## Capture, routing and linking

Use the canonical Obsidian task index to find stable Markdown list items, respecting excluded paths and configured capture roots. `#todoist` is the only default automatic capture opt-in. Use parsed tags, including escaped code and comments, rather than a whole-file substring search. Existing files with completed tasks are excluded from automatic first-time creation.

Commit a candidate when the cursor leaves its line, the editor loses focus, or manual sync sees a stable nonempty candidate. Persist a provisional local identity and operation UUID before a create. Repeated index events and application restarts reuse that operation. When a remote acknowledgment is uncertain, query or replay the same provider command UUID before allocating a new task.

Project routing precedence is an explicit task selection, then one unique mapped project, then the account default. Conflicting mappings pause creation. Project and label IDs are saved by ID, with names as display snapshots. Renames refresh display names. Archived or missing projects require rerouting. Removing a mapping must not move existing tasks automatically.

Existing Google-linked blocks retain their canonical identity when opted into Todoist. Similar titles are suggestions for explicit adoption. Reuse the current identity matcher for exact text, native block IDs and conservative move detection. Extend it to represent task projections through a shared API before consolidating storage. Keep the existing migration and crash-recovery behavior covered by regression tests.

## Field reconciliation

| Field | Obsidian representation | Propagation and resolution |
| --- | --- | --- |
| Title | First task paragraph excluding time and routing tags | Three-way merge using normalized provider title, retain original note formatting when unchanged |
| Completion | Markdown checkbox | Nonrecurring complete/reopen maps to provider, recurring completion uses occurrence handling |
| Project | Explicit choice or one mapped tag | Explicit move updates provider, tag mapping changes alone affect new tasks |
| Labels | Explicit mapped tags and detail chips | Preserve unmapped tags and provider-only labels |
| Description | Detail editor and opted-in note detail region | Keep provider descriptions distinct from unrelated local paragraphs |
| Parent/children | Registered nested task relationships | Move through provider tree operation, preserve local-only child text |
| Task date | Detail Date and optional existing task-date syntax | Date-only changes group tasks, linked scheduled tasks keep time and duration |
| Planned interval | Timed Markdown parent and registry | Synchronize task start and supported provider duration, retain the full local and Google interval, configurable per account |
| Recurrence | Provider metadata and details display | Reschedule occurrence without replacing recurrence, completion opens new occurrence |
| Google fields | Existing CalendarSnapshot and subtask exporter | One exporter owns event title/time/colors and generated description section |

For each field, compare local and remote with the last acknowledged baseline. One changed side wins. Matching changed values converge. Different changed values create a conflict. Disjoint changes merge. Treat coupled date/time/duration fields as one schedule patch when necessary for valid intervals. The conflict dialog shows original and latest values and revalidates both sources before applying choices.

Review of a saved provider command loads the current task under its original account. Group task date/duration and project/parent fields into coupled choices. Leave contested fields unselected and disable Apply choices until each has a value. Re-read the task and saved operation on submission. Changed values refresh the comparison and require another choice. Persist cancellation of the original intent and its replacement UUIDs in one registry transaction. Place replacement commands immediately after the original intent so later queued edits retain order. Keep the original command payload unchanged, including acknowledged creates, and use fresh update/move commands for the same remote task. A missing task can discard a saved command. Advancing recurrence cannot redirect an old completion command into a newer occurrence.

A schedule whose provider phase conflicted follows its saved replacement chain. After verification, prepare a replacement schedule using the accepted task date and the existing note/event identity. Date-only choices preserve local clock time and elapsed duration. Supported provider duration can update the interval. A cleared provider date retains the current planned interval. Explicit unschedule remains the operation that removes it. Preserve the note's common field baseline until its projection is reconciled.

Google title/time edits already reach Markdown through the calendar engine. Run task projection reconciliation after that acknowledged note write, then queue Todoist updates. A task-origin note write then queues the existing Google sync. Serialize the per-occurrence schedule operation and record acknowledgments independently. A Google failure leaves calendar-pending status and retries that phase without recreating the remote task.

## Scheduling and unscheduling

Use the planner's pointer-to-date calculation, snapping, duration validation and note writer. The drag payload contains a short-lived local task key and an explicit versioned MIME type. Resolve the task again at drop time and reject another vault/account's payload. A text fallback inserts readable content only and cannot establish a link by itself.

A scheduled task is moved on repeat drop. A child independently scheduled gets its own projection and is suppressed as a duplicate nested timeline event. Untimed child details remain in the parent's visible subtree. Multi-day moves reuse the persisted before/after note journal. Task ordering changes on their own do not generate remote mutations.

Remove from schedule removes the local time range, deletes the already-owned managed Google event through an explicit coordinator operation, clears its active schedule link and keeps an untimed linked note task. It preserves the provider task date. Google deletion in this explicit workflow is independent of the default setting for arbitrary local task deletions. Restart recovery completes only the phases already authorized by the operation.

## Calendar duplicate prevention

Setup records the exact legacy Todoist calendar ID or ICS source selected by the user. Exclude that feed from Day Planner overlay while the Tasks scheduling integration owns those tasks. Apply the exclusion in this plugin, preserving Google's selected-calendar preference. Restore the recorded plugin display policy on disconnect or offer the previous selection. The exclusion applies to date refresh, manual refresh, Google and ICS overlays.

A task's managed Google event is already suppressed from the external overlay by the Google link registry. The Tasks pane adds status and navigation rather than rendering a second timeline item. Detect a Todoist native Google integration writing into the same managed calendar. Require choosing a single exporter for affected task links before enabling outbound scheduling. Other events on the calendar continue to display.

M1 browsing creates no schedule projections. Calendar feed transition occurs in M3, immediately before scheduling is enabled, with a restorable record of the previous plugin selection.

## UI behavior and accessibility

Use native Obsidian theme variables, current Svelte primitives and icon wrappers. Date and Project are grouping controls. Source selection is shown only when useful. Search is labelled, toolbar icons have accessible names, status changes use a polite live region, and keyboard focus remains visible. Completed entries can be collapsed separately. Filter state is leaf-local and serializable.

Use a side details pane when space permits and a modal on narrow layouts. A 320px Tasks pane must wrap labels and titles without horizontal scrolling. Schedule, move, complete, retry and conflict resolution have keyboard equivalents. Keep meaningful focus after a row disappears. Confirm permanent deletion separately. Use a calendar-minus icon for unschedule.

## Performance and refresh

Refresh at connection, manual request, pane activation if stale and at a visible-pane interval. Coalesce overlapping refresh calls. Avoid reading all daily-note files during every row render. Use the existing vault index and update affected links incrementally. Keep account snapshots immutable to support Svelte subscriptions. Profile 2,000 active tasks and deep nesting before release. Add virtualization only if measured pane performance requires it.

## Rollout and rollback

Land M0 design, M1 browsing, M2 mutations, M3 schedule projections and duplicate prevention, M4 full reconciliation and recovery, M5 recurrence and identity repair, then M6 release acceptance. Commit each milestone independently. Rebase or merge hotfixes from the baseline with the exact combined tree checked before installation.

Run focused tests for changed contracts, full repo validation and a production build. Visual acceptance uses a disposable development vault with synthetic data. Live acceptance uses disposable tasks and the dedicated calendar, records IDs privately for cleanup and checks readback. Install the integrated build into the working vault after required acceptance cases pass. Back up the plugin and matching registry before schema upgrades. Roll back matching note/state/plugin snapshots together.
