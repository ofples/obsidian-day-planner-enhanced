# Tasks in Day Planner

The Tasks pane connects Todoist tasks to daily-note schedules and the existing Google Calendar bridge. Readable tags opt a note task into syncing. A private registry maintains identity as tasks are edited and moved. The provider boundary supports adding another task service later.

The production baseline started at `82ae46ff` on `feat/google-calendar-sync` and includes the installed rename/deletion hotfixes through `87de378b`. Feature development runs on `feat/task-pane-todoist`, which includes those hotfixes. The baseline checkout remains available for hotfixes.

## Design package

- [User stories and screen behavior](USER-STORIES.md)
- [Technical specification](TECHNICAL-SPEC.md)
- [Acceptance cases and release evidence](ACCEPTANCE.md)
- [Implementation sequence and current progress](IMPLEMENTATION.md)
- [Goal prompt](GOAL-PROMPT.md)
- [Mockup review and screen index](DESIGN-REVIEW.md)

The mockups describe the intended product. Implementation progress and verification live in IMPLEMENTATION.md and ACCEPTANCE.md.

## Development build usage

Open Tasks from the ribbon or the Show tasks command. Connect Todoist using its API token. The token is saved through Obsidian SecretStorage. Task creation, editing, completion and reopening use the pane's custom controls. The latest Morgen-inspired design is implemented with scoped HTML, CSS and JavaScript through Svelte. Details adapt to narrow and wide panes, forms open inline and pending changes share a compact disclosure.

Open Capture and routing to choose capture folders, the default project, project tags and label tags. Initial project tags come from unique single-tag project names, and the Inbox is the initial default. Settings are account-specific. Add `#todoist` to an unchecked Markdown task and leave its line to capture it. For example, `- [ ] Buy rice #todoist #karma` routes to the project mapped to `#karma`. A task with tags mapping to several projects waits for Choose project. The editor context menu also provides Todoist routing for a specific task. Remote IDs remain in plugin state.

Tagged capture creates and links tasks. Use Schedule in task details, the row context menu or Schedule selected task to choose a date, start and duration. Drag a pane task into a day/week timeline to use its snap interval. A repeated drop moves its existing linked block. A schedule chip opens the note. Remove from schedule keeps the checklist and provider date and removes its managed event after confirmation. Dropping into an editable Markdown line moves the linked checklist there, with a confirmation when this removes a scheduled interval.

Linked titles and nonrecurring checkboxes reconcile automatically between notes and Todoist. Changes to mapped project and label tags update the task while retaining provider-only labels. Timed-note edits use the same projection journal, including normal timeline move/resize writes. A remote date-only move keeps the linked clock time and duration. A date on an unscheduled task remains task metadata until you schedule it explicitly. Subtask text and checkbox changes refresh the parent's generated Google description.

Provider command conflicts offer Review with per-field choices and a fresh comparison before applying them. A same-field note/provider disagreement preserves both values and pauses propagation. Review fields offers current-note/provider choices for these disagreements and reloads the comparison if either side changes. Recurrence, independently scheduled children, source-copy decisions and recovery use the custom panel controls described below. Current installed verification and rollout status are recorded in ACCEPTANCE.md.

Open Capture and routing in the Tasks pane, then Task calendar feeds to select the exact Google or internet-calendar sources to hide for the connected task account. Load calendars lists your Google calendars and retains unavailable saved selections. Enable Hide selected task feeds after making that selection. Disconnecting the task account restores feed display. This plugin-level choice is saved per task account. The full Day Planner settings opens the same custom calendar form.

Unlink note in task details opens a confirmation. It removes that note's capture tag and task link through the durable note journal. Manage the local task and Todoist task separately afterward. Timed notes continue through Day Planner's calendar bridge. Previously pending calendar recovery and explicit removal work stays saved for retry. Removing #todoist from an established link offers Review link. Confirm Unlink note or cancel to restore the tag and continue syncing. Closing the form or pane also restores it. Other edits made during the decision continue through normal reconciliation.

Deleting a linked note block detaches its task link after you leave Markdown editing. The existing calendar deletion setting controls its event. A saved recovery record retains the task identity. Restoring the original block reattaches that task, including when automatic capture is disabled. Restored duplicate copies require Recheck link and one original block. A task already scheduled in another note keeps its current link while the restored block awaits review. Review task links opens source-copy decisions. Keep one linked retains the selected original source, Move link transfers its identity to a selected copy, and Create separate task makes a new task tree from the reviewed copy. Historical choices retain their occurrence ownership.

Todoist duration sync depends on its Pro or Business entitlement. Scheduling retains full time ranges in Obsidian and Google Calendar for every account. Sync schedule start to task date in Calendar feeds controls the provider date update. Provider duration synchronizes when the account supports it. [Todoist duration availability](https://www.todoist.com/help/todoist/features/set-a-task-duration-L1kYkZv8d)

New Google exports follow the existing Google Calendar date window. A schedule outside that window stays saved locally and in Todoist with its calendar phase available for retry. Adjust Days to sync in the past or Days to sync ahead in Google Calendar settings and retry the schedule. Existing linked events retain their identity when moved outside the current window.

## Recurring tasks and recovery

Completing a recurring task saves its checked schedule under Completed occurrences and refreshes the next Todoist occurrence. Schedule that next occurrence to create its own note/calendar identity. Open a completed occurrence to inspect its saved task and subtasks or navigate to its note. Undo this completion opens a comparison before Confirm undo. The historical root becomes active and unchecked, subtasks use their current Todoist state, and following schedules become local checklists with their calendar blocks retained. Cancel closes the comparison. Pending recovery exposes retry and safe cancellation controls.

Delete from Todoist opens a permanent-deletion review showing the task tree and linked notes. Confirmation saves the decision, verifies provider deletion and unlinks the affected notes while retaining their text. Deletion history keeps the result available for inspection. Remove from schedule and Unlink note have their own controls and confirmation.

A restored or unreadable task-state file opens Review tracking and holds task writes. The form compares loaded and saved tracking before restoring the latest supported copy. It backs up displaced bytes and refreshes Todoist before releasing writes. Keep matching plugin, note and state backups together for a full rollback. Detection of an older task-state file depends on the separate checkpoint retaining the newer tracking. Restoring both files to a matching older pair requires the matching full rollback backup.

## Decisions

- Integrate the pane into Day Planner Enhanced, reusing its schedule editor, note parser, task rendering and calendar exporter.
- Start with a fresh task registry. Discovery of an old link is an explicit adoption case, rather than a prerequisite for setup.
- Keep `#todoist` as the capture opt-in. Mapped project tags such as `#work` or `#karma` route new tasks. Ordinary local tasks remain local until opted in.
- Store provider IDs, occurrence identities and operation journals in plugin state. Preserve user-authored text and native block IDs.
- Defer deadline editing. The first release handles task dates and planned schedule times.
- Retire the unused former sync plugin. Record the selected Todoist calendar feed during setup and exclude it from Day Planner display when task scheduling takes over.
- Give a scheduled task one Markdown projection and one managed Google event. Show a schedule chip in the Tasks pane. Unscheduled Todoist tasks appear in the pane without creating daily-note tasks.
- Start on desktop. Narrow docked panes and keyboard scheduling are required desktop behaviors.

## Provider reference

Implementation targets Todoist API v1. Pin the adapter contract to the official documentation and validate real responses before enabling writes. Cursor pagination and account identity are acceptance requirements. [Todoist API](https://developer.todoist.com/api/v1/)
