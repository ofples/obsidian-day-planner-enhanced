# Tasks in Day Planner

The Tasks pane connects Todoist tasks to daily-note schedules and the existing Google Calendar bridge. Readable tags opt a note task into syncing. A private registry maintains identity as tasks are edited and moved. The provider boundary supports adding another task service later.

The production baseline started at `82ae46ff` on `feat/google-calendar-sync` and now includes the separately installed rename hotfix at `4431a998`. Feature development runs on `feat/task-pane-todoist`, which includes that hotfix at `7137427e`. The baseline checkout remains available for hotfixes.

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

Provider command conflicts offer Review with per-field choices and a fresh comparison before applying them. A same-field note/provider disagreement preserves both values and pauses propagation. Review fields offers current-note/provider choices for these disagreements and reloads the comparison if either side changes. The remaining recovery controls are in development. Recurrence/history and independently scheduled children follow in M5. The feature build is under development in its separate branch. The production baseline remains installed during verification.

Calendar feeds in the full Tasks settings selects the exact Google or internet-calendar sources to hide for the connected task account. Enable Hide selected task feeds after making that selection. Disconnecting the task account restores feed display. This plugin-level choice is saved per task account.

Todoist duration sync depends on its Pro or Business entitlement. Scheduling retains full time ranges in Obsidian and Google Calendar for every account. Sync schedule start to task date in Calendar feeds controls the provider date update. Provider duration synchronizes when the account supports it. [Todoist duration availability](https://www.todoist.com/help/todoist/features/set-a-task-duration-L1kYkZv8d)

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
