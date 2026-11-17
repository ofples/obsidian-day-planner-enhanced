# AI scheduling user stories

## Prepare a plan

As someone preparing the day, I can ask my assistant to arrange tasks for the selected day or several days using the schedule and task list already available in Day Planner.

The planning request includes the visible date range, timezone, an editable instruction, planning hours and default task duration. The assistant sees the current note tasks, cached Todoist tasks, existing schedule, frame categories and locked commitments. Snapshot metadata identifies its source freshness. A copied request is useful in an existing assistant conversation.

## Review before applying

As the person responsible for the schedule, I see suggested blocks in the timeline with an explicit pending treatment. The existing schedule remains visible. I can inspect a change's reason and before/after time, select individual suggestions, accept the selected set or dismiss it.

A proposal may contain newly scheduled tasks, moved blocks and additions under frames. Previewing and rejecting a proposal produce zero schedule or provider writes. Accepting a subset applies only those changes. Repeated acceptance produces no duplicates.

## Fill a frame

As someone using time containers, I can ask the assistant to add suitable tasks beneath an existing frame while retaining its scheduled interval. The proposed children use the existing Markdown representation, descriptions and weak Todoist links.

An unlabeled child is allowed. A shared category is sufficient. An explicit category mismatch is explained. Locked frames and locked child tasks are protected by the same validation as manually scheduled blocks. A task already consumed by the destination note is identified in the snapshot.

## Rearrange the remaining day

As someone running late, I can request a shift of flexible blocks, keeping fixed commitments in place. The assistant sees the old and proposed times and can leave tasks unscheduled when space is insufficient. The review explains those omissions. Moves preserve the entire task subtree and description.

## Triage with a shortlist

As someone who prefers manual scheduling, I can ask the assistant for named buckets such as urgent work, short tasks and suitable tasks for a frame. The Tasks pane shows these sets using its current task rows. Completion, hide-added behavior and dragging into the timeline remain available. Clearing the AI view returns to ordinary browsing.

Buckets refer to current snapshot task IDs. A task can be shown in several buckets, while its underlying completion state remains shared. Missing or completed tasks disappear through existing filtering.

## Keep practical rules

As someone with a recurring planning style, I can save a concise scheduling instruction and adjust planning hours and default duration. The assistant receives those preferences with every request. The plugin enforces locks, valid intervals and protected commitments independently of the assistant's prose.

The first release offers one rules surface. Rule text is ordinary planning guidance. It is separate from the machine-checked constraints shown beside it.

## Refresh a changed plan

As someone continuing to edit, I can change a note or task while a proposal is pending. Acceptance validates the original source and destinations. An outdated action is marked for refresh, and newer content is preserved. I can copy a refreshed request for the assistant using the current state.

The saved pending draft survives a plugin reload and is revalidated before applying. The panel clearly distinguishes pending suggestions, changes already accepted, dismissed items and actions needing refresh.

## Undo an accepted batch

As someone trying an AI-generated arrangement, I can undo the last accepted batch with one action. Undo checks that its affected note content still matches the result it applied. If the note has since changed, the panel explains that automatic Undo needs review and retains the newer content.

Successful acceptance and Undo both use the established local editing and Google sync flow. Calendar-side effects remain visible through the normal sync status and conflict UI.

## Use my existing assistant

As someone using Copilot, Codex or another local agent, I can give it a reusable scheduling skill and a small set of operations to read planning context, submit a proposal and prepare task buckets. The user remains responsible for approval in Day Planner.

The local interface carries no Google or Todoist credentials. The planning snapshot contains only the selected range and task sources needed for this request. A manual context-copy and proposal-import path supports assistants without the local tool integration.
