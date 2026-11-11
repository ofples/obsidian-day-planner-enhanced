# Goal prompt

Implement the integrated Tasks pane described in this package, starting with Todoist and retaining a provider-neutral boundary. Complete the staged implementation, verification and working-vault installation with honest acceptance evidence.

Read `docs/task-pane/README.md`, `USER-STORIES.md`, `TECHNICAL-SPEC.md`, `ACCEPTANCE.md`, `DESIGN-REVIEW.md` and `IMPLEMENTATION.md`, then inspect the current branch and milestone status. Use the reviewed screenshots as UI guidance and the written behavior and acceptance cases as the implementation contract.

The production baseline is `82ae46ff` on `feat/google-calendar-sync`. Develop on `feat/task-pane-todoist` in its separate worktree. Keep the baseline checkout available for hotfixes. Incorporate subsequent hotfix commits and verify the combined tree before installation.

Deliver M1 through M6 in order, with reviewable commits. Start with a secure, cached, dockable Todoist browser. Extend it with durable edits and #todoist capture, linked day/week/Markdown scheduling, bidirectional reconciliation, recurrence, subtasks and recovery. Update milestone and acceptance records after meaningful changes. Continue authorized work autonomously through recoverable failures.

Use these product decisions throughout.

- Start a fresh registry. Treat discovered legacy links as explicit adoption cases.
- Use #todoist to opt new Markdown tasks into sync. Mapped tags route projects, with an explicit choice for ambiguous mappings.
- Preserve readable note text and native block IDs. Keep generated provider identity and journals in plugin state.
- Defer deadline editing. Preserve upstream fields outside each narrow patch.
- Use the existing Day Planner scheduling and Google Calendar exporter. Keep each scheduled occurrence linked to one note block and one managed event.
- Exclude the exact legacy Todoist calendar feed from this plugin when scheduling takes over. Preserve the other displayed calendars and record a restoration policy.
- Keep remove-from-schedule, unlink, completion and permanent deletion as explicit actions with the semantics in the stories.
- Resolve independent field edits automatically and ask for a choice for conflicting fields. Keep recurrence occurrence history and provider repeat rules.
- Persist operations before side effects, reuse provider command identities on retries and recover incomplete note moves after restart.
- Validate every account and provider response. Keep credentials in SecretStorage and private data out of Git.
- Implement the reviewed Morgen-inspired custom panel using scoped HTML, CSS and JavaScript through Svelte. Use boards 09–11 for the current visual direction, adaptive details, custom forms and compact recovery feedback.

Run focused regression tests for changed behavior, the repo-required full validation and a production build. Inspect the normal-entry UI in a disposable desktop vault at narrow and normal widths. Verify writes with disposable real tasks and the dedicated calendar, read back stable task/event identity, and clean up artifacts. Complete matching backup, installation, reload and live acceptance when the required cases pass. Report the inherited ICS timeout separately from feature regressions.

Completion means the supported user stories work through the pane, daily-note editor, day/week planner and Todoist, with calendar deduplication and restart recovery verified. A partial milestone is progress toward the goal. Record pending cases and continue until the defined outcome is achieved or an external blocker requires user input.
