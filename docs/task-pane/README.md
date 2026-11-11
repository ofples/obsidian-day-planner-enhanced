# Tasks in Day Planner

The Tasks pane connects Todoist tasks to daily-note schedules and the existing Google Calendar bridge. Readable tags opt a note task into syncing. A private registry maintains identity as tasks are edited and moved. The provider boundary supports adding another task service later.

The current production baseline is commit `82ae46ff` on `feat/google-calendar-sync`. Development starts on `feat/task-pane-todoist`. The baseline remains available for hotfixes.

## Design package

- [User stories and screen behavior](USER-STORIES.md)
- [Technical specification](TECHNICAL-SPEC.md)
- [Acceptance cases and release evidence](ACCEPTANCE.md)
- [Implementation sequence and current progress](IMPLEMENTATION.md)
- [Goal prompt](GOAL-PROMPT.md)
- [Mockup review and screen index](DESIGN-REVIEW.md)

The mockups describe the intended product. Implementation progress and verification live in IMPLEMENTATION.md and ACCEPTANCE.md.

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
