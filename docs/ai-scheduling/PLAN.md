# AI scheduling plan

## Outcome

Reduce the work of preparing and rearranging a daily schedule. An assistant uses the same tasks, frames and commitments shown in Day Planner to prepare a proposal. The user reviews that proposal in the existing planner and chooses the changes to apply.

## Baseline and workspace

The installed 0.9.9 baseline is commit `1d170b8b1fbd878a46afdae50faa0925e0cf6957`, tagged `baseline/ai-scheduling-0.9.9`. Its checkout stays available for hotfixes. Develop this feature on `feat/ai-scheduling` in a separate worktree. Check subsequent baseline changes before installing a combined build.

## First release

- Plan the selected day or a range of up to seven days, using the existing day-count controls.
- Read scheduled note blocks, visible calendar commitments, cached Todoist tasks and available note tasks through one bounded planning snapshot.
- Propose task placement, movement of existing flexible blocks and plain Markdown children inside frames.
- Show pending changes on the existing timeline and in a compact review panel. Select, inspect, accept or dismiss suggestions.
- Let an assistant prepare named task buckets for manual triage with the existing completion and drag interactions.
- Keep one editable scheduling instruction and a small set of planning defaults. Locks, occupied commitments and explicit frame-label mismatches are validated by the plugin.
- Apply approved edits through existing local-note machinery and let normal Google sync follow. Provide one checked Undo for the last AI batch.
- Expose a small local agent interface and a reusable skill, with context-copy and proposal-import controls for assistants without tool access.

## Delivery sequence

1. Write user stories and scope, then review the existing mutation, preview, task filtering and Undo machinery.
2. Generate six mockup boards covering preparation and rules, day/week preview, individual review, curated buckets and frames, shifting and Undo, and setup/empty/stale states.
3. Review the boards against the stories. Remove redundant screens and controls. Record visual and behavioral refinements in the mockup index.
4. Specify the snapshot, proposal schema, validation, persistence, normal UI entry points, application transaction and checked Undo. Map each main user story to one acceptance case.
5. Write the implementation goal prompt and activate it. Implement in small reviewable milestones with separate ownership for independent components.
6. Verify the main workflows with deterministic proposals and installed Obsidian checks. Use background app access where available. Run repository-required validation and report the existing ICS timeout separately.

## Milestones

- M1 establishes planning snapshots, proposal validation and a persisted draft, plus model-free tests.
- M2 adds the review surface, timeline overlays, selected approval, stale-state handling and checked Undo through existing writes.
- M3 adds task buckets, frame placement, shift requests, the local agent interface and a usable skill.
- M4 verifies normal UI and agent round trips, reviews the implementation against the boards, and completes a separately backed-up preview installation.

## Scope boundaries

Cloud-only Google Calendar execution is a later adapter. The first release works while desktop Obsidian is open. Model accounts and a hosted scheduling service are outside this release. The plugin validates and applies assistant proposals. The assistant supplies task choices and scheduling reasoning.

Keep one draft and one last-applied Undo record. Reuse existing task identities and Markdown links. Preserve the current best-effort Todoist behavior. Use explicit source references and snapshot versions supplied by the plugin. Avoid ownership reconstruction from task titles.

## Review and testing budget

Review the plan once for workflow and once against the source implementation. Cover the supported end-to-end paths and the concrete risks of stale edits, locked schedules, duplicate approval and destructive Undo. Use focused deterministic tests. Additional speculative combinations are outside the acceptance requirement.

## Progress

- Baseline checkpoint and separate feature worktree are ready.
- Two independent reviews completed workflow and source checks. The technical contract includes their batch composition, reference resolution and guarded-Undo corrections.
- User stories and the six-board mockup set are complete. The technical contract follows the reviewed screens, with generated layout/time artifacts called out for correction.
