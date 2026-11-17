# AI scheduling technical specification

## Product contract

Implement the user stories in USER-STORIES.md using the existing Tasks pane, timeline, local-note editor and Google bridge. The six image-generated boards guide spacing, hierarchy and interaction. The behavior in this document governs acceptance. The first preview supports one through seven consecutive local days and up to fifty actions per proposal.

An existing assistant produces a structured proposal. Day Planner provides context, validates the proposal, renders its preview and applies user-approved actions. A reusable local skill calls a small public plugin interface through Obsidian CLI. Copy context and Import suggestions provide an alternate entry point into the same interface.

## Source review and simplifications

Two independent reviews checked workflow and implementation reuse. Retain a single proposal store and the current task browser. Reuse the three existing task sources, the same task rows and the normal timeline date controls. A small Plan action opens the planning/review surface. Keep saved instructions, planning hours and default duration together.

The generated boards include additional working-day, buffer and task-type preference panels. These are deferred. Several example dates and arrows are cosmetic. Implement time placement from actual timestamps, keep task completion circular, use the current app chrome and preserve the existing right-half frame hover. A proposal-selection control is distinct from task completion. Replace claims of an agent being connected with Local tools available, because the skill invokes operations on demand.

Cloud-only Google execution and a hosted model connection are later adapters. This preview uses the assistant already available to the user. It has no AI polling loop and introduces no task ownership registry.

## Components

### Planning service

Add a focused src/ai-scheduling area containing validated types, snapshot construction, proposal validation, Markdown planning and draft lifecycle. Keep Obsidian access in a host adapter. Pure functions receive data and return validated actions or before/after note edits. UI components consume the service's readable state.

Persist one active draft and one last-applied batch in a versioned ai-planning.json sidecar under the plugin directory. Context, notes and task titles are private local data. Keep the file out of Git. Validate stored data on load and report corruption with a recoverable UI state. A reload retains the pending draft and revalidates it before approval.

The last batch stores exact affected before/after note content, action IDs and the identity changes required by the existing Google mapping. An in-flight operation is recorded before note effects, using the current note-change journal for the actual writes. Recovery compares the current documents with the stored before/after states and recognizes a completed operation without inserting it twice. Keep this record limited to the current draft and last batch.

### Context

getContext accepts a local start date, day count, request and optional planning preferences. Default to the selected timeline range, the current default task duration and saved instructions. Validate the range and cap it at seven days.

When several planners are open, use the last-focused planner's range. Fall back to the current local day when no planner has been focused. An explicitly supplied date range takes precedence.

The snapshot contains a generated context ID, timestamp, timezone, range, preferences, scheduled blocks, frames, displayed calendar commitments and available task references. Scheduled blocks retain a reference to their current source range and complete subtree. Note sources include the selected daily notes, current editor note and notes explicitly included by the existing Tasks-pane scan. Todoist data comes from its existing cached snapshot. Include source freshness, counts and truncation information. Bound returned task lists and show when more tasks are available.

Use opaque context-local references for blocks, frames and tasks. The model returns these references. Source validation compares captured raw content and document fingerprints. Persist references only with their proposal. Google/Todoist credentials and unrelated notes are excluded.

Keep full document snapshots inside the plugin's private state. The public assistant context contains task subtrees, descriptions, scheduling fields and reference IDs, while omitting unrelated document paragraphs. Include existing provider priority, due date, estimated duration and project metadata when available. The current task serializer's descendant IDs let batch validation detect overlapping parent/child selections without new ownership records.

Context collection performs no scheduling or provider writes and starts no provider refresh loop. Use the current cached calendar commitments and disclose their freshness. The selected displayed calendars define the commitments visible to this local planner. Live provider conflict checks continue through the established synchronization code.

Timed displayed events reserve their interval. All-day entries provide context and remain informational in this preview. Include that distinction in the assistant context. Refreshing context reuses the current Todoist cache, whose timestamp remains visible. Use the normal provider refresh to learn about new remote changes.

### Proposal document

The input contains version, context ID, a short summary, actions, optional task buckets and explanations for unplaced work. Each action has a unique ID, one source reference and a short reason.

- schedule places an available note or provider task at a proposed start/end interval.
- move relocates a scheduled local block, preserving its entire subtree, description, labels and provider link.
- add-to-frame places an available task beneath an existing local frame, preserving the frame's interval.

Freeform task creation, task completion, provider deletion, renaming and recurrence editing are outside this action vocabulary. Existing manual interactions remain available.

Buckets contain a short title and current task references. They reuse current task rows and source filtering. A task may occur in more than one bucket. Completion, consumed-task hiding and drag/drop continue through the existing handlers. Clearing the AI view restores the prior ordinary browsing preferences.

Retain the bucket's context mapping even when showTaskView is called without a schedule proposal. Resolve references against current task sources and remove unavailable/completed rows through existing filters. Bucket controls can select a source and filter the current rows, preserving ordinary completion and drag handlers.

The service validates the entire input shape, ID uniqueness and referenced entities before showing it. Validation issues identify their action and use plain language. Reject unknown or completed sources and duplicate placements. Task text is data and cannot request extra tools or change the proposal contract. Also reject selected parent/descendant sources whose source ranges overlap, since distinct references can still represent one subtree.

## Validation and scheduling constraints

Run the same validation when importing and again before applying the selected batch.

1. Accept whole-minute positive intervals inside the selected local dates and configured planning hours. Preserve explicit timezone offsets and use the app's local timezone consistently.
2. Protect #locked roots, descendants and locked target frames. Use the existing task-lock helpers.
3. Reuse frameDropWarning. Unlabeled children and shared categories are valid. An explicit disjoint category is a visible issue requiring a different suggestion in this preview.
4. Check the resulting selected schedule against displayed external calendar commitments, fixed local blocks and other selected proposed intervals. Exclude old positions of selected moved blocks before checking their destinations. A child added under a frame is contained by that frame and does not create a separate overlapping root.
5. Validate source documents and destination notes against the captured snapshot. If a relevant note changed, mark affected suggestions for refresh and preserve current content. A newly completed or changed provider task also needs a fresh context.
6. Recheck before saving inside the existing serialized note-edit queue. A stale preview is never authoritative over later edits.

Narrative rules are passed to the assistant and displayed during review. Machine checks cover the structured constraints above. Explain unfulfilled requests in the proposal's summary instead of inventing missing task durations or silently dropping work.

## Preview and review UI

Place Plan beside the existing timeline controls and expose the same entry from the command palette and Tasks pane. The planning surface has a compact request form and a Rules disclosure. Use the established custom pane styling and existing controls.

Show proposed new positions as translucent, explicitly marked overlays in the timeline. Existing blocks remain visible. A moved block's review row shows the original and proposed interval. Frame additions appear as proposed children in their parent or an anchored frame preview. Keep preview state separate from pending drag receipts, persisted note indexing and Google event feeds.

A compact bar shows the selected/pending count, Apply selected and Dismiss. Individual rows provide inclusion, dismissal and expandable reasoning. The detail view shows the source, destination, time and reason. Blocked or stale actions have an inline explanation and a Refresh context action. Apply stays available for independently valid selected actions when their final combination passes validation.

At narrow widths, use one column and expandable details. Applying disables duplicate submission and shows a short busy state. Errors remain in the planning surface until the user acts. Avoid recurring toast notices.

## Applying changes

The host flushes relevant editor buffers and enters GoogleCalendarSync.editNotes, which already serializes local changes against calendar operations. Prepare the selected actions in memory, combine their changes by path and validate the final document set before its first write.

Reuse parseBlocks, renderBlock, appendToPlanner, source-range location, indentTaskSubtree and the current task-to-Markdown conversion. Expose the existing default importer serialization as a read-only helper when needed. Preserve the root's weak Todoist chain link and plain Markdown descendants. Importing a task leaves its provider due date unchanged.

Use the current note-change journal for one combined before/after write set. Add a narrowly scoped optional identity update to its batch API if required. Preserve existing Google block identities for moved blocks, including cross-day moves. Fresh provider placements allocate a local Google identity once and retain it across recovery. Existing consumed-task detection can read the Markdown chain link without another identity registry.

Build selected edits against one evolving in-memory document map, using renderBlock, appendToPlanner, source-location and indentation helpers. Multiple additions to one frame accumulate in that map. notes.prepareWrite creates notes and reads disk, so keep it outside the pure batch planner. Extend notes.applyEdits with a narrow optional identity patch and use its existing change journal once for the whole batch. Expose TaskScheduler's existing plainTask conversion as a read-only serialization method.

Create missing daily notes with PeriodicNotes only during explicit approval and preserve the normal daily-note template. Record their original absence and template content. Failure recovery and Undo remove a newly created note only when its content still matches the recorded result. If another edit intervened, retain the note and show the issue.

Use OptimisticNoteEdits for the approved document set while the write completes. Failed operations remove their own temporary display. Pending AI suggestions already provide immediate feedback before approval.

After approval, let normal Google synchronization process the accepted Markdown. Show provider progress and conflicts through the existing Sync and conflict controls. Proposal preview and task curation have no calendar side effects.

## Undo

Offer Undo for the last accepted AI batch. Compare every affected current note with the exact after-content before restoring anything. Use a checked reverse transaction through the same queue. If a note changed afterward, retain the newer content and show Review required. The existing TransactionWriter.undo restores full previous files without this check, so call the guarded AI path.

Google-synced moves retain their event identities and synchronize back through the current path. Newly exported placements removed by Undo need targeted cleanup through the existing removeProjection ownership and version checks, independent of the general local-deletion preference. Persist an Undo-cleanup phase before local effects and keep normal reconciliation fenced through targeted cleanup. removeProjection currently rejects calls while editNotes is busy. Factor its existing ownership/version-checked core into the smallest scoped helper needed to run cleanup under the same fence. Keep the original public operation behavior.

Preserve a visible pending/error state for failed calendar cleanup. A pending cleanup record must survive reload and remain available for explicit retry. Defer another AI Apply while that record is unresolved, and keep ordinary manual editing available. Reuse existing request limits and explicit retry. Avoid full-note force sync during Undo because it could override unrelated remote changes.

## Local assistant interface

Expose a versioned public aiPlanner facade on the installed plugin.

- getContext(request) returns a bounded planning snapshot and response schema.
- submitProposal(document) validates and saves a draft for review.
- showTaskView(document) validates and sets curated task buckets.
- getStatus() returns current draft, issues and last-batch status.

Agent-facing operations prepare and inspect. Approval and Undo are UI actions. Use a reusable skill with a small CLI helper to invoke the facade through Obsidian CLI. Pass JSON through a temporary file or encoded argument using a shell-free process call. Detect Error output as a failure even if the CLI exits successfully.

Package the helper inside the skill folder so the installed skill is self-contained. The local CLI route requires Obsidian's supported installer and enabled CLI. Setup instructions should link to the official installation guide. [Obsidian CLI](https://obsidian.md/help/cli)

Copilot's installed agent-based interface can use the skill through its existing local agent. Document the actual tested setup. Older Obsidian versions or assistants without local execution use context copy and JSON import. A standalone MCP wrapper can call the same facade later without adding a second planner or credential flow.

## Testing and delivery

ACCEPTANCE.md defines the main workflows. Use deterministic fixtures for model output and fake provider caches for most tests. Verify one real local-agent submission through the facade, one installed review/apply/Undo flow and one disposable Google round trip. Native pointer takeover is unnecessary for most cases because existing drag/drop handlers already have acceptance coverage.

Run formatting, source lint, TypeScript, Svelte checks, focused tests, full suite and production build. Record the inherited ICS test timeout separately. Keep the installed 0.9.9 baseline available while developing. Back up and replace only this plugin's build artifacts for the preview installation, then read back connections, note content and existing calendar identities.
