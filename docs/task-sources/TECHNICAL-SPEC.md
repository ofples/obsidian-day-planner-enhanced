# Technical specification

## Architecture

Add Google Tasks and GitHub source sessions alongside the current Todoist service. Reuse TaskSnapshot, ProviderTask, taskGroups, row rendering, RequestGate, TaskRenderCache, PlainTaskImporter, optimistic note edits and the AI lifecycle.

TaskService has Todoist credential names, gates, weak writes and legacy recovery. A small bridge exposes its current snapshot and actions to the common source browser. New sessions own connection state, selected containers, read caches and an optional explicit completion command.

The collection resolves provider/account/item references and supplies current snapshots to Overview and AI. It routes an action to the owning session. A session exposes readable state, connect, disconnect, refresh and containers. State includes loading/error/retry information and fetch coverage. The Todoist bridge reads its existing state directly.

## Data model and identity

Extend the existing normalized task/snapshot models with optional source metadata. Old snapshots and drafts remain valid. A source reference contains provider, accountId and itemId. Google task identity includes list ID and task ID. GitHub issues and project pull requests use their node ID. A draft uses its Project item ID and retains its content ID as metadata.

Suggested optional metadata includes source kind, source URL, native ID, native container ID, update timestamp, memberships and date meaning. Each membership carries container reference, Project item identity, order and selected field values. Containers distinguish lists, repositories and Projects. Existing projectId provides a default grouping. A pure view projection supplies membership-specific grouping/order without mutating the source cache.

Keep one normalized issue with several memberships. Issue state and each Project's status retain their own meaning. A selected Project date field becomes a target date in that view. The default priority is neutral and labels stay labels. A milestone date is available as metadata.

Calendar block UIDs continue to identify schedule placements. External references identify their source work. Normal insertion acquires a Calendar UID through the existing importer.

One account per new provider is enough initially. Stage new authorization until identity/access are checked, then change the active account atomically. Old-account rows are cleared before new rows are published. Provider/account qualification applies to drags, mutations and AI references.

## Shared UI and import routing

Extend the saved source selector while accepting old Notes/Todoist/Overview values. A small optional per-source preference map preserves query, grouping, container and Show added settings. Old pane values seed the existing source view.

The current row renderer and browser helpers serve the new views. Capabilities determine whether completion is interactive. Read-only items offer Open source and support dragging. Compact chips can show source kind, issue number, repository and Project status.

Drag sessions resolve a source reference through the collection and retain the existing vault namespace and nonce protection. Transfer data identifies the session. Source switching, account changes and sign out invalidate stale sessions. Keep the old Todoist payload readable during transition.

Generalize ordinary scheduling entry points so timeline, editor, frame and schedule actions resolve a provider reference before serialization. New providers use the existing plain importer and its note queue, delivery receipts, offset rebasing, indentation, frame checks and optimistic feedback. Existing Todoist experimental operations continue through their current route.

Extract the current cached task serializer into a pure source-aware helper. Todoist output remains compatible. All entry points use the same serialization for a source item. A root contains its ordinary title/tags and a compact source link. Descriptions and descendants use current indentation. Copied children retain plain Markdown semantics.

## Best-effort source links

Add provider-aware link recognition through a dedicated helper. Existing Todoist URL/occurrence helpers keep their current weak-sync behavior. A provider-qualified match is required to resolve a task.

Prefer the native task/issue URL supplied by the adapter. Preserve opaque identity information in Google links. Normalize known GitHub issue and pull-request URLs. Labels and prose are display content.

For a Project draft lacking an individual web URL, link to its Project and encode the exact item reference in the optional Markdown link title. Use the same small, versioned, validated hint only when a Google task lacks a usable individual URL. Resolve hints against the current source cache. Malformed and unavailable hints remain ordinary note content.

Use the root link and existing import receipts to hide work already in the selected note. A parent import can consume its cached descendants while their plain copy remains under that root. Removing a link makes the relationship best effort. It can make the source item available again.

An existing Project item reference can resolve its current issue content after draft conversion. This is a current-cache alias, with no background ownership reconstruction. One issue across assignment, repositories and several Projects resolves to one task.

Teach Calendar title/description helpers to recognize these links. Event titles contain the human task title. The description holds provenance, description and subtasks through the existing note/Calendar bridge.

## Google Tasks

Read lists and tasks from selected lists. Use maxResults=100 and bounded page-token iteration. Preserve native parent and sibling order. Initial reads request active tasks and explicitly configure assigned-task visibility. Task-specific get supports freshness and completion readback. [Listing API](https://developers.google.com/workspace/tasks/reference/rest/v1/tasks/list)

Map notes into description, native list identity into the container and the provided task URL into provenance. Store its date as YYYY-MM-DD with scheduled-date meaning. Duration and recurrence remain unknown where the API exposes no field. [Task model](https://developers.google.com/workspace/tasks/reference/rest/v1/tasks)

Parameterize GoogleCalendarAuth narrowly for scopes and display labels, preserving its default Calendar behavior. Tasks uses its own secret namespace. Request openid/email plus tasks.readonly, and resolve the authenticated subject/account display through the authorized identity endpoint. Account validation precedes publishing a connection. [Tasks scopes](https://developers.google.com/workspace/tasks/auth)

Allow completing tasks requests the editing scope. Completion resolves the exact list/task and current version before PATCH. Serialize the command through RequestGate and update the row optimistically. A lost response retains a small verification-required state and requires readback before another write. A source refresh never creates a completion operation.

Confirm the returned task version/date and refresh its list after completion. A following instance managed by Google becomes fresh work. The schedule Undo record concerns Markdown/calendar effects. Explicit source completion has its own confirmation state.

Owned Google app preparation includes Tasks API enablement, consent scopes and publishing/verification status. Record the actual setup state and any user authorization prerequisite.

## GitHub authentication

Use an owned OAuth app with device flow enabled and bundle its public client ID when registered. Show the official user code and verification URL, with Copy, Open GitHub and Cancel. Poll at the server interval, honor slow_down and stop at expiration. Make login and token refresh single flight. Store rotated credentials together in SecretStorage. [Device flow](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps)

Request read:project initially. Public repository reads need no repo scope. Include private repositories is an explicit choice because repo grants broader access including writes. Describe that grant before reauthorization. The provider implements queries. Organization approval and SSO can limit access independently. [Scope definitions](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps)

A registered owned app is a prerequisite for bundled sign-in. A custom public client ID can live under the existing Advanced pattern. A missing registration must appear as a specific setup prerequisite. Continue the complete provider and fixture implementation while a registration or authorization action is pending.

## GitHub data

Use REST for identity and bounded issue reads from assignment and chosen repositories. Filter pull-request records from issue endpoints. Cache bodies and bound very large descriptions with a visible truncation flag. Identity uses the node ID. Repository/name/number and URL are display/provenance fields.

Use GraphQL ProjectV2 for both user and organization owners. Read selected Projects, field metadata, item content and page information. Handle Issue, DraftIssue and PullRequest fragments. Partial errors are scoped to their selected source. Redacted items become an unavailable-item count or stub. [Projects API](https://docs.github.com/en/issues/planning-and-tracking-with-projects/automating-your-project/using-the-api-to-manage-projects), [Project schema](https://docs.github.com/en/graphql/reference/projects)

Membership deduplication retains all selected Project identities and field values on one issue. Field mappings use IDs and data types. Support a chosen single-select status field and an optional date field initially. Read the actual available options. Project status does not authorize issue closure.

Cover github.com user and organization Projects v2. Discover user Projects directly. Allow organization Project selection by owner/Project URL so broad organization-list access is unnecessary. Parse source URLs into fixed API variables and use configured origins.

## Requests and caching

Reuse RequestGate, including cooldown, cancellation and circuit handling. Recognize GitHub reset headers, secondary limits and rate errors in GraphQL HTTP-200 responses. Honor provider deadlines. [REST limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api), [GraphQL limits](https://docs.github.com/en/graphql/overview/rate-limits-and-query-limits-for-the-graphql-api)

Use pages of up to 100 items and an initial budget of 20 pages/2,000 items per source refresh. Show count, coverage and continuation. A repeated cursor stops the read. Load more is a separate bounded action. Abandon queued work on unload or account change.

Refresh on connect, explicit Refresh and opening a stale source. Start with a five-minute freshness threshold. Search, grouping, render updates, Markdown edits and AI context use cached source data. These sessions start no persistent polling loop.

Coverage identifies fetched containers, completeness and cursors. A bounded partial result is visible. A failed fetch retains the affected source's last good state with an error. An incomplete result cannot produce deletion commands.

## AI and compatibility

Extend planning task kinds for Google Tasks and GitHub while accepting existing note/todoist documents. Keep provider/account/item references explicit. Source collection snapshots feed the current bounded planning context and cached-source checks. Reuse proposal validation, locks, frame rules, Apply and Undo.

AI buckets resolve references against current sources and reuse ordinary task rows. Proposals authorize schedule review through the established facade. Explicit source mutations stay with their source-pane action.

Accept old Todoist caches, secret keys, weak links, pending imports, planning drafts and saved pane values. New optional metadata defaults conservatively. Keep new cache files private and ignored by Git before they are created.

## Delivery

ACCEPTANCE.md defines the main workflows. Verify deterministic adapters, normal installed UI and a local assistant round trip. Preserve the recent optimistic-rendering fix, including stable local DOM identity during updates.

Record registration, authorization, live provider reads, source checks and installed UI as distinct evidence. Complete code and fixture acceptance before reporting an external prerequisite. Install built assets after backup and an idle check, then read back connections, existing notes, settings and Calendar identities.
