# Mockup review

The boards were generated with the built-in ImageGen tool. Prompts are retained in `mockups/prompts.json`. The screenshots are synthetic product guidance. The original approved composition informed their typography, spacing, docked-pane layout and restrained task colors.

## Screen traceability

| Board | Screens and scenario variants | Stories |
| --- | --- | --- |
| [Connection and mappings](mockups/01-connect-and-project-mapping.png) | Token connect, help, connected account, project routing, capture opt-in | US-01, US-05, US-13 |
| [Browse and details](mockups/02-browse-search-and-task-details.png) | Date/project groups, search/filter, expanded task tree, task details | US-01, US-02, US-09 |
| [Schedule by pointer or keyboard](mockups/03-drag-week-and-keyboard-scheduling.png) | Day drag preview, week view, Schedule modal | US-03 |
| [Markdown capture and linked edits](mockups/04-markdown-capture-and-linked-editing.png) | Clean tag capture, routing popover, linked note, move and unschedule actions | US-04, US-05, US-06, US-07 |
| [Recurrence and calendar ownership](mockups/05-recurring-completion-and-calendar-deduplication.png) | Completed occurrence, next occurrence, exact feed visibility | US-08, US-11 |
| [Recovery and narrow layouts](mockups/06-offline-conflict-and-empty-states.png) | Offline queue, field conflicts, empty/filter state, reconnect, narrow keyboard actions | US-06, US-10 |
| [Unschedule and identity repair](mockups/07-unschedule-and-link-recovery.png) | Unschedule confirmation, copied-block choice, unavailable project | US-07, US-12, US-13 |
| [Create and change dates](mockups/08-task-creation-and-date-changes.png) | New task, ambiguous tags, date-only move, keeping clock time | US-02, US-05, US-06 |

Shared error surfaces cover permission loss, rate limit and retry states. Their exact behavior is specified by acceptance cases, including states that differ only in feedback text.

## Review round one

1. The connection board showed OAuth and token controls simultaneously and a connected card inside a disconnected screen. Refine to a coherent token-first flow. OAuth remains a later connection implementation.
2. The browsing board repeated Shopping as a group and a task. Keep one parent row and use date/project groups consistently.
3. The Markdown board showed Admin in the remote Tasks pane without #todoist. Remove it from that pane. Only #todoist opts a new local task into capture.
4. An unscheduled task with No date appeared in Today. Put it in No date.
5. The recurring board described the next occurrence without displaying it in Tomorrow. Show one fresh unchecked Water plants occurrence and keep today's checked history.
6. Calendar visibility used radio buttons despite allowing multiple calendars. Use independent toggles and exclude the selected Todoist feed by exact ID.
7. Unschedule used a trash icon. Use calendar-minus and retain the task.
8. The conflict screen mixed whole-task choices, per-field choices and duplicate commit actions. Use per-field choices with one Apply choices button and no preselected winner.
9. The narrow context menu foregrounded Delete. Show Schedule, Rename and Open in Todoist. Permanent deletion belongs to its separate explicit workflow.
10. Counts and visible rows varied across generated boards. Count matching branches once, with nested children under their matched parent and context ancestors excluded from counts.
11. Scheduling screenshots alone omitted ambiguous routing and copied links. Add boards for these workflows.
12. The earlier details concept contained a deadline field. All new screens defer it.

## Review round two

Targeted image revisions corrected the connection, capture opt-in, recurring occurrence, unschedule and conflict interactions. The connection screen now presents one available token path. The recurring screen retains a completed occurrence and displays its fresh successor. The conflict screen uses per-field choices and a single disabled-until-resolved Apply choices action. Two additional boards cover creation, date-only moves, unschedule confirmation and identity repair.

Reviewing the rendered revisions caught two further drifts. The Shopping details lost its Scheduled value while retaining active navigation actions. The Markdown board lost the Admin title and kept an incorrect lower group count. A third targeted image pass restores those values.

The boards combine alternative screens for review. Actual dialogs appear one at a time, and their accessible focus and Escape behavior are acceptance requirements. Generated counters are illustrative. Runtime counts come from unique matching identities. Short prompt artifacts such as a redundant deadline sentence are omitted from implementation. The written specification governs date-only and unschedule behavior.

## Final review

The third pass was visually inspected. Shopping now has a consistent schedule chip and details value. The Markdown examples retain Admin as a local task and show the correct lower Today count. All eight final boards are saved in the gallery. The reviewed flows are ready to guide the staged implementation. The acceptance matrix covers runtime behavior and failure states beyond what a static board can demonstrate.

The first actual desktop pane review exposed undated children appearing in a separate No date group from their dated parent. The implementation now groups those children with the parent and supports folding their tree. Explicitly dated children retain their own date group. Counts track matching branches, consistently with the parent-first mockups.

The M3 desktop review moved schedule chips below full-width task titles and wrapped the selected-task actions after finding narrow-pane overflow. The M4 conflict dialog was compared again with board six. Removing its additional whole-task commit button restored the reviewed per-field flow. It shows original, saved and current values, leaves contested choices empty and disables Apply choices until they are resolved. A newer provider edit refreshes the comparison and clears those choices. Measured overflow in both refined surfaces was zero. Native pointer and OS input-method checks remain in acceptance.

## Streamlined implementation decisions

- Use one adaptive details surface, docked on wide layouts and modal on narrow layouts.
- Keep one routing decision path for both new-task UI and Markdown capture.
- Reuse one scheduling command for keyboard placement, drop confirmation and rescheduling.
- Show a schedule chip rather than duplicating a scheduled task in another timeline layer.
- Use one field-conflict form and one Apply choices action.
- Keep one cached snapshot per account and one durable operation queue per vault writer.
- Use the existing Google subtask-description exporter for shared nested content.
