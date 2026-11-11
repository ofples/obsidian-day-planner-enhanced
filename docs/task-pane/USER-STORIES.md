# User stories and screen behavior

## US-01 Connect and browse

As a planner, I can connect Todoist and browse my tasks without importing the entire account into my notes. The first connection uses a personal API token stored through Obsidian SecretStorage. Connection help links to the official token settings. A later OAuth flow can use the same credential interface after an application and redirect are configured.

The pane opens from a command, a ribbon action or the Day Planner menu. It can be docked in either sidebar or a main leaf. It restores grouping, filters, collapsed groups and selection. Date groups are Overdue, Today, Tomorrow, Upcoming and No date. Project grouping preserves project and task order. Search matches task titles, descriptions, projects and labels. Tasks with unavailable parents remain discoverable.

## US-02 Understand and edit a task

As a planner, I can open a task's details, edit its title, date, project, labels, priority, description and subtasks, or open it in Todoist. A checkbox completes a task. Scheduled, Date and Duration have separate labels. Schedule chips navigate to the existing note block and date. An unscheduled task has no schedule chip.

Each row shows its title and only the metadata useful in the active grouping. Project names, date chips and sync state fit at 320px pane width. Group counts count matching task branches, with a matched parent and its nested children counted once. A matching descendant retains its ancestor context without inflating counts. Undated children stay with their parent's date group. A child with its own date appears under that date. Source-native ordering breaks ties consistently.

## US-03 Schedule by dragging or keyboard

As a planner, I can drag a task onto a day or week slot. The preview uses the planner's snapping and default duration. Drop creates a linked Markdown time block and a pending operation. The Tasks row gains a chip only after the local note write succeeds. Dragging the same task again moves its existing block.

A Schedule command offers a date, start time and duration with keyboard focus and validation. This is the equivalent workflow for keyboard users and narrow panes. Escape cancels a drag. Dropping outside a valid surface changes nothing. Overlaps follow existing Day Planner behavior and remain visible.

## US-04 Drag into Markdown

As a note writer, I can drop a task into a Markdown list at the caret. A drop into the configured schedule heading uses the selected schedule date and optionally opens Schedule. A drop elsewhere creates an untimed linked checklist projection. Existing linked content is moved through the note editor service. Dropping into a code block or a read-only editor is refused with useful feedback.

## US-05 Capture with tags

As a note writer, I can finish a line such as `- [ ] Buy plant ties #todoist #karma` and get one Todoist task. The inline popover shows project and date routing. Creation starts after the user leaves the line and the parser sees a stable nonempty task. A manual sync also commits stable candidates. Composition input, partially typed tags and active lines are excluded from automatic creation.

An explicit project choice takes precedence over mapped tags. One mapped tag chooses that project. Multiple different matching projects require a choice. No match uses the configured default project. Project tags remain readable in the note. The `#todoist` routing tag is excluded from the remote title. Other tags become Todoist labels only through explicit label mappings.

## US-06 Edit in either application

As a planner, I can rename, reschedule or complete a linked task in Todoist, Markdown or the task details. The change appears in the other projections. Independent changes to different fields merge. Two different changes to the same field open a field-level conflict. A conflict has no preselected winner. Apply choices becomes available once each conflicting field is resolved.

Changing a linked task to another date keeps its existing start time and duration. A remote exact time moves the linked schedule. A remote date-only change on an unscheduled task changes grouping only. A remote time on an unscheduled task offers scheduling and follows the configured import policy. The default keeps scheduling an explicit action.

## US-07 Unschedule, unlink and delete

As a planner, I can remove a time block while keeping the task. Remove from schedule removes the planner interval and its managed calendar event and retains an untimed linked task in the source note. This action preserves the Todoist date, which remains separately editable.

Unlink keeps both note and remote task and stops propagation. Removing `#todoist` from an established linked block offers unlink and restores the tag if the user cancels. Deleting a note block unlinks it by default. Permanent remote deletion is a distinct explicit action with confirmation and a recovery record. Removing a task from a filtered list never implies deletion.

## US-08 Recurring tasks and history

As a planner, I can complete today's recurring task while retaining today's checked schedule entry. The next occurrence appears with its new task date. The old occurrence retains its own identity, content and calendar history. Rescheduling one occurrence preserves the recurrence rule. Completing a recurring parent follows Todoist's actual child-completion semantics and then refreshes the tree.

Undo of a recurring completion requires resolving the specific completed occurrence. If the provider cannot restore that occurrence safely, show the supported recovery action and retain the historical note. Reopening the current recurring task must never silently reopen a different occurrence.

## US-09 Keep subtasks together

As a planner, I can expand a task tree, schedule a parent with its children and change individual child statuses. Independently scheduling a child excludes that child from a second overlapping scheduled block while preserving its relationship. The existing compact timeline layout and Google description exporter continue showing nested content. Local-only child bullets remain local until explicitly opted into task sync or created through Add subtask.

## US-10 Recover after interruptions

As a planner, I can keep browsing cached tasks while offline and see pending changes. Retry resumes persisted operations after reconnect or restart. Expired credentials show Reconnect without erasing notes or mappings. A partial page fetch keeps the last complete task snapshot. Losing permission to a project marks affected tasks unavailable and preserves their local content.

## US-11 Avoid duplicate calendar entries

As a planner, I see one scheduled block even if a Todoist calendar subscription exists. Setup chooses the exact feed to exclude from this plugin's overlay. Other calendars continue displaying normally. Existing Google-linked schedule blocks are adopted by the task link without recreating their Google event. Similar titles alone never establish a task link.

## US-12 Review and repair identity

As a planner, I can choose which copied or ambiguously moved block keeps a task link. Copying linked content offers Move link, Keep one linked and Create separate task. Native block IDs are reused when present. The registry records link decisions and preserves source text. Restoring an older state file creates a repair workflow before writes resume.

## US-13 Switch accounts and manage connections

As a planner, I can disconnect and reconnect the same account while retaining its cache and links. Connecting another account presents its identity before switching and keeps the accounts' registries separate. A project with the same name in two accounts never shares links. A future provider appears through the same source selector and declares supported editing capabilities.
