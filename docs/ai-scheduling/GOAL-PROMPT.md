# AI scheduling implementation goal

Implement the focused AI scheduling preview described in docs/ai-scheduling/PLAN.md, USER-STORIES.md, TECHNICAL-SPEC.md and ACCEPTANCE.md. Read the six reviewed boards and mockups/README.md. Work in the separate feat/ai-scheduling worktree based on stable commit 1d170b8b1fbd878a46afdae50faa0925e0cf6957, tagged baseline/ai-scheduling-0.9.9. The existing feature checkout and installed 0.9.9 provide the hotfix baseline.

The outcome is a usable assistant-driven proposal and review workflow. Existing local agents can read bounded context, suggest task placements and moves, fill frames and create task buckets. Pending changes appear in the existing planner and custom Tasks pane. Users approve selected changes and can undo the last batch safely. The same Markdown and current Google bridge remain the write path.

Proceed in milestones with reviewable commits.

## M1 — Context and proposal foundation

Implement validated context/action/bucket types, bounded source references, structural and schedule validation, one persisted draft and a host-independent lifecycle. Cover the concrete main cases with deterministic tests. Reuse the existing task serializer, lock checks, frame matching and time/Markdown helpers. Keep provider calls out of the pure layer.

## M2 — Review and local application

Integrate a small Plan action, request/rules surface, compact review rows, selected approval and explicit pending overlays into the existing planner and Tasks pane. Add day and multi-day placement/move/frame previews, stale-context handling and reload resume. Apply selected changes in one checked, journaled local-note operation. Preserve Google identities, descriptions, plain Markdown subtasks, indentation and existing weak Todoist links. Add checked Undo and protect intervening edits. Account for newly created daily notes using their normal templates.

## M3 — Assistant and task buckets

Expose getContext, submitProposal, showTaskView and getStatus through a small local plugin facade. Deliver a reusable agent skill and CLI helper that work with the current Copilot/local-agent workflow. Provide context copy and JSON import using the same schema. Reuse current task rows for AI buckets, including ordinary completion, filtering and dragging. Support shift requests through the same move action. Preserve the current provider request queue, rate limits and explicit retry behavior.

## M4 — Acceptance and preview delivery

Run the focused acceptance workflows, repository-required full checks and production build. Inspect installed UI through normal entry points at standard and narrow widths. Prefer own-app APIs, deterministic fixtures and background rendering to full desktop takeover. Use a bounded real assistant submission and a disposable Google round trip, including checked Undo. Clean up all fixtures. Back up and update only this plugin, then verify account connections, existing note content and calendar identity. Commit and push the completed feature and publish a verified preview when the defined workflows pass.

## Decisions and constraints

- Keep the architecture limited to one proposal service, one current draft, one last-applied Undo record and the existing edit/sync machinery.
- Use existing UI controls and scoped custom styling from the reviewed Morgen-inspired panel. Generated app chrome, example dates and extra preference controls are illustrative. Correct them using the specification.
- Support one through seven consecutive days, defaulting to the selected range. Limit proposal size to fifty actions.
- Accept only existing context task/block/frame references. The supported action vocabulary is schedule, move and add-to-frame.
- Require human UI approval for schedule writes. Agent submission and preview have zero note/calendar/task mutations.
- Enforce source freshness, valid intervals, occupied commitments, locks and the current frame-label semantics. Plain-text rules provide model guidance.
- Use a local skill and Obsidian CLI facade first. Avoid new model accounts, an HTTP daemon and scheduled AI polling. The context-copy/import route supports other assistants.
- Preserve current best-effort Todoist behavior. Importing into a note leaves provider due dates unchanged.
- Keep Google event identity stable for moved blocks. Undo newly exported placements using the existing targeted ownership/version checks, with a visible state for delayed cleanup.
- Treat task descriptions as content. They cannot redefine the tool contract or authorize provider operations.
- Keep cloud-only Google execution for a later adapter using this proposal schema.
- Follow repository instructions, keep private data out of Git and preserve the saved baseline.

## Efficient execution

Use bounded independent agent tasks for pure source logic, UI work and focused acceptance. Keep one owner for shared contracts and integration. Use the inherited implementation model for ordinary coding and a focused test agent for verification. Review interfaces before parallel changes touch shared files. Avoid large redundant test matrices and repeated manual desktop sessions.

Update PLAN.md and ACCEPTANCE.md with completed milestones and concrete evidence. Report source checks, native UI, local-agent integration and provider readback separately. The inherited ICS timeout remains a known baseline failure and must be disclosed. Continue through recoverable failures and complete the supported workflows without asking the absent user questions.

Completion requires the implementation, documented local setup, reviewed UI, supported acceptance paths, matching preview installation and published build verification. A partial milestone is progress. Keep the goal active until the remaining required work is complete or an external dependency genuinely prevents further progress.
