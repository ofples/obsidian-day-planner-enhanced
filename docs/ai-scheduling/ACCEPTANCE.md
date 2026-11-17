# AI scheduling acceptance

## Main workflows

1. Prepare a day from current-note and cached Todoist tasks. Submit a valid proposal and see pending timeline blocks and review rows. Context, preview, task curation and dismissal produce zero note or provider writes.
2. Include a Todoist placement, an existing-note placement and a frame child. Accept a subset and verify exactly those Markdown edits, preserved descriptions/subtrees, one weak link per imported root and current-note consumed-task hiding. Repeating acceptance creates no duplicate.
3. Fill a frame with an unlabeled or matching task. An explicit category mismatch is explained. Locked frames, locked tasks and parents with locked descendants remain protected.
4. Shift flexible blocks across two days around fixed local and displayed external commitments. Verify old positions are removed, durations and source subtrees are preserved and existing Google identities remain stable.
5. Show an AI-curated task view. Complete and drag ordinary task rows, then clear the view and resume normal browsing.
6. Edit a source or destination after preview. Applying the affected action requires refresh and preserves the current note. Reimporting from refreshed context works.
7. Apply a batch, then Undo it. Restore exact prior note content. Repeat with an intervening manual edit and verify the newer edit is retained with an actionable explanation.
8. Reload with a pending draft and resume review. Recover a recorded completed note operation without duplicate insertion. Create a future daily note through its normal template on approval.

## Installed checks

- Use normal planner and Tasks-pane entry points at ordinary and narrow widths.
- Complete one local assistant context/submission round trip through the documented skill/helper.
- Verify one disposable Google-synced placement/move and Undo with readback, including the general local-deletion preference being disabled.
- Check unchanged account connections, existing note bytes outside the fixture, plugin settings and calendar identities after targeted installation.
- Clean up disposable tasks, notes, events and owned dialogs, then verify cleanup.

## Evidence levels

Record source checks, installed UI, agent integration and live provider readback separately. A mocked provider response establishes source behavior. Report unavailable live acceptance explicitly. The baseline suite has an inherited inclusive-last-day ICS timeout.

## Preview recovery boundary

If Obsidian closes after creating a missing daily note and before saving the AI receipt, its template note may remain. The old draft stops when it detects the changed destination and preserves the current content. Refresh context and prepare the proposal again before applying schedule changes. Automatic recovery of this short template-creation window is deferred.

## Current status

M1 through M3 are implemented. The first preview uses the existing assistant, the current Tasks pane, one durable proposal service and the established note/Calendar queues. Cloud-only execution remains a later adapter.

### Source checks

The full suite has 1,644 passing tests, nine skips and seventeen todos. The inherited inclusive-last-day ICS timeout remains the sole failure. Formatting, ordinary lint, style lint, TypeScript, Svelte diagnostics, strict lint and the production build pass independently. Focused tests cover selected approval, frames, cross-day moves, locks, occupied slots, source freshness, template commitments, reload/retry, corrupt-state reset and checked Undo.

### Installed UI

The preview was installed by replacing only this plugin's three build artifacts after a private backup. The normal Plan action opens the shared request/review panel. Standard and 240-pixel layouts, including the two-row narrow timeline header, were inspected using actual installed DOM and hidden Electron reconstructions with current form properties. Review rows, pending timeline overlays, frame previews, the selected/pending bar and two-day mode were verified. These are app-level handler and rendering checks. Full desktop pointer control was unnecessary.

Native UI handlers applied a fixture frame addition and timed task, preserved descriptions and plain Markdown subtasks, and restored the exact note with Undo. The final build resumed a saved draft after reload, used the selected two-day range, preserved an intervening manual edit with a usable Undo action, and then completed a checked Undo. Curated buckets reused the existing note rows and dragging. Todoist row completion remains covered by the component tests. Notes rows retain their existing open-note completion behavior.

### Local assistant

A local agent used the packaged helper to collect context, generate a two-action frame/schedule proposal and submit it through the installed facade. Status confirmed both actions pending, zero accepted actions, no issues and no applied batch. The fixture note hash stayed unchanged throughout preparation and submission. The self-contained skill is included in the source and preview download.

### Google Calendar

A disposable fixture was approved through the review UI and exported with the normal note-scoped sync path. Live readback confirmed its title, description, subtasks and unique mapping. Undo removed a newly created event through the guarded cleanup path. A second disposable placement moved to a new time with its event ID preserved. Undo moved it back through normal sync. Both test events and their fixture note were removed after confirmation.

### Delivery checks

Preview installation, final cleanup, unchanged existing notes, account connections, unrelated plugin state and installed artifact hashes passed final readback. Public release assets are checked separately after publication. The stable 0.9.9 baseline and hotfix checkout remain available. The repository pre-commit hook repeats the full suite, so its existing skip switch was used after recording the inherited ICS failure and passing the independent strict check.
