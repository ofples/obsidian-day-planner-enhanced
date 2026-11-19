# Google Tasks and GitHub sources

## Outcome

Bring Google Tasks and GitHub work into the existing Tasks pane, morning triage and AI planner. A source item can be searched, filtered, dragged into a note or time slot, placed inside a frame and hidden after it is added to the selected daily note. Its compact source link remains useful in Markdown and the Google Calendar description.

The baseline is f4050c7272fc36145140cc5a6b4ffbf92ed8bcc0, containing the 0.10.0 AI preview and optimistic-rendering fix. Development uses feat/task-sources-google-github in a separate checkout. The preceding checkout is available for hotfixes.

Read the [technical specification](TECHNICAL-SPEC.md), [acceptance cases](ACCEPTANCE.md) and [implementation goal](GOAL-PROMPT.md) alongside this plan.

The [preview usage and setup guide](README.md) describes the implemented source controls and remaining live setup gates.

## First delivery

| Area              | Included behavior                                                                                                                         |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Google Tasks      | Sign in, choose lists, browse hierarchy, search, defined order and date buckets, import notes and plain Markdown children                 |
| Google completion | Optional editing grant and explicit completion from the source pane, with immediate feedback and checked failure recovery                 |
| GitHub Issues     | Sign in, assigned issues and selected repositories, labels, assignees, state, body and source link                                        |
| GitHub Projects   | Selected user and organization Projects v2, issues, drafts and project pull requests, status filtering and an optional date-field mapping |
| Shared planning   | Existing note/timeline/frame drops, Show added toggle, Overview, AI context and curated buckets, schedule Apply and Undo                  |
| Connections       | Existing Connections surface, account identity, selected sources, scoped errors, cancellation and sign out                                |

GitHub supplies work for planning. Issue closure, Project-status writes, comments, issue creation, merges and workflow automation are deferred. New-source Markdown edits remain local. Google completion is an explicit source-pane action. Existing Todoist completion and weak links continue through their current implementation.

One active Google Tasks account and one GitHub account are sufficient initially. Both can be connected alongside Notes and Todoist. Enterprise GitHub hosts, automatic source creation through new hashtags and cloud execution are later extensions.

## User stories

### Connect my sources

I can open Connections, sign in and select the lists, repositories and Projects I want to browse. The account and granted access are visible. I can cancel sign-in or disconnect a source independently.

### Triage Google Tasks

I can see tasks with dates and ordinary tasks without dates, grouped by day or list. Notes and subtasks stay attached to their parent. Defined order follows Google. A date stays on the same calendar day in my timezone.

### Plan GitHub work

I can choose Assigned to me, a repository or a Project. The same issue found through several views is one work item. Each Project can show its own status for that issue. Drafts and pull requests have recognizable kinds and useful source links.

### Choose useful Project fields

I can choose a status field for filtering and optionally a date field to display as a target date. Field names and options come from GitHub. Issue state and Project status are displayed as separate facts. Milestone dates are available as metadata.

### Consume items one at a time

I can drag an item into the current note, a time slot or the right half of a frame. Existing placement, indentation and frame-label rules apply. A successful insertion hides it for that note. Show added reveals it. A removed source link makes the relationship best effort and can make the source item available again.

### Keep source content readable

An imported root is an ordinary Markdown task with a small chain link. Its description and copied children remain editable. GitHub bodies can contain checklists and code. Source provenance belongs in the Calendar description.

### Complete Google tasks deliberately

After enabling completion and granting editing access, I can complete a task from its source row. It updates immediately. An uncertain result requires readback before another write. Schedule Undo restores schedule edits, while Google source completion has its own explicit action and confirmation state.

### Use the sources with AI

Planning context includes chosen sources with exact provider/account/item references, useful descriptions, labels, dates and freshness. The assistant can propose placements, frame children and task buckets through the existing facade. Preview produces zero note or source writes. Approval imports ordinary Markdown through the current edit queue.

### Keep working through a source problem

An unavailable source shows cached data, refresh time and an actionable error. Other sources remain usable. An incomplete fetch is visible and cannot imply remote deletion. Switching accounts clears the previous account's active rows before publishing the new session.

## Interaction plan

Use one source picker in the current pane header with Overview, Notes, Todoist, Google Tasks and GitHub. Reuse search, grouping, sorting, Show added, task rows and drag affordances. The menu accommodates narrow sidebars.

Google Tasks adds a list selector. GitHub adds a view selector for Assigned to me, Repositories and Projects, followed by a source selector. Project status chips appear when a status field is selected. Field mappings live beside that Project's settings in Connections.

Connections adds Google Tasks and GitHub cards using the current pattern. Google Tasks starts with viewing access. Allow completing tasks requests an editing grant. GitHub shows its device code, Copy, Open GitHub, progress and Cancel. Private repositories are an explicit access choice. Errors stay near the affected source.

## API findings

Google Tasks exposes notes, hierarchy, sibling order and a source URL. Its API records a day and cannot read or set a task's scheduled time. Dates enter triage and planning guidance. Timed placements use the current Markdown/calendar path. [Task model](https://developers.google.com/workspace/tasks/reference/rest/v1/tasks)

Task listing is paginated. Completed tasks cleared in first-party apps need hidden/completed flags to be returned, and assigned tasks are a separate query choice. Initial reads show active tasks. [Task listing](https://developers.google.com/workspace/tasks/reference/rest/v1/tasks/list)

Viewing and editing use separate Google Tasks scopes. A dedicated credential namespace lets the new connection use the existing desktop flow. Owned-project API enablement and consent configuration are part of setup. [Authorization](https://developers.google.com/workspace/tasks/auth)

Projects v2 contains issues, drafts and pull requests with item-specific fields. GraphQL provides one read path for the first adapter. Some user-project REST endpoints explicitly exclude GitHub App and fine-grained tokens. Test personal and organization Projects with the selected authentication. [Project model](https://docs.github.com/en/graphql/reference/projects), [Project items](https://docs.github.com/en/rest/projects/items)

Use an owned OAuth application's device flow initially. Project reading requests read:project. Public repository information needs no repository scope. Private repositories require repo, which includes write permissions in GitHub's grant. The provider exposes read operations and presents private access as an explicit opt-in. [Scopes](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps), [Device authorization](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps)

## Milestones

1. Establish provider-qualified references, capabilities and source sessions. Extract the current serializer and verify shared browsing/import with fixtures.
2. Implement Google Tasks normalization, selected lists, account identity, sign-in and optional completion. Verify the existing Calendar authorization defaults.
3. Implement GitHub sign-in, issue and Project reads, deduplication, field selection and partial-permission handling.
4. Connect both sources to the current pane, drag/drop, consumed-item detection, Overview and AI context.
5. Verify the main workflows with deterministic providers and installed UI. Finish owned app configuration where available and record live authorization gates.
6. Back up and install the preview, verify normal entry points and existing state, then commit and push the implementation with acceptance evidence.

## Source review and simplification

TaskProvider and TaskSnapshot have generic names, but TaskService, credential keys, request gates, serialization, weak links, source enums, drag sessions and AI adapters contain Todoist assumptions. A provider factory alone would leave the normal entry points incomplete.

Add a small source-session layer for the new providers and bridge the existing Todoist service into its read view. Share the current browser and plain-note importer. Todoist's current ownership/reconciliation remains in its service. New source work stays concentrated on reads, capabilities and ordinary imports.

The principal checks are qualified references, duplicate Project membership, dates, permissions, pagination, bounded requests, insertion and account/source switching. Acceptance uses a small set of realistic workflows. Broad combinatorial matrices and unrelated sync refactoring are outside this delivery.

## Status

API and source review are complete. The stable checkout is preserved and the feature checkout is ready. Record implementation progress and concrete evidence in ACCEPTANCE.md.
