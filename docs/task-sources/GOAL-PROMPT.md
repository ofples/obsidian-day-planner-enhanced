# Goal: Google Tasks and GitHub work sources

Implement a usable first version of Google Tasks and GitHub Issues/Projects sources in Day Planner Enhanced. Work autonomously from the reviewed plan through source implementation, meaningful tests and a reviewable preview. Preserve the existing scheduling workflow and keep the mechanism simple.

## Starting point and authority

- Baseline: f4050c7272fc36145140cc5a6b4ffbf92ed8bcc0, including the recent optimistic timeline rendering fix.
- Work on branch `feat/task-sources-google-github` in the dedicated feature checkout. Retain the stable scheduling checkout for hotfixes.
- Read repository/subdirectory AGENTS instructions and these documents: [PLAN](PLAN.md), [TECHNICAL-SPEC](TECHNICAL-SPEC.md), [ACCEPTANCE](ACCEPTANCE.md).
- The user authorized this integration and an unsupervised session. Make routine implementation choices independently. Prefer local automation and deterministic tests over desktop takeover. Do not send messages to other people or perform unrelated account changes.
- Follow current tool and authentication rules. Registration, live grants and any user-only authentication action must be reported honestly; complete independent work while such an action is unavailable. Do not invent credentials or borrow another application's OAuth identity.

## User outcome

The existing Tasks pane offers Overview, Notes, Todoist, Google Tasks and GitHub through a compact source selector. Google lists and GitHub assigned issues/repositories/Projects are useful for morning triage. The user can drag work into a note, timeline or frame, see it immediately, hide already-added work, and include it in AI task buckets and scheduling proposals. Connections clearly show the account, selected containers, capabilities and actionable errors.

Imports are ordinary Markdown with a small source link. Descriptions and children use the existing Markdown conventions. New-source Markdown edits do not trigger continuous source writeback. Existing Todoist weak links and Calendar synchronization retain their current behavior.

## Scope boundaries

Deliver Google Tasks selected lists, task dates/notes/hierarchy/order and optional explicit sidebar completion after an editing grant. Treat Google task dates as date-only scheduled dates. Do not invent scheduled times or a recurrence model.

Deliver GitHub assigned issues, selected repositories and user/organization Projects v2. Read Issue, DraftIssue and Project PullRequest items. Preserve multiple memberships on one issue identity. Support an actual status field/filter and an optional date-field mapping by field ID. Keep issue state and Project status separate. Initial GitHub operations are reads and local scheduling. Issue closure, project workflow writes, comments, source creation and merges are outside scope.

One account per new provider and github.com are sufficient. Do not build a new task ownership database, automatic relinking system, universal provider framework, continuous polling service, cloud scheduler or second scheduling UI.

## Implementation sequence

### M0: Review and protect the baseline

Confirm the branch, clean starting status and existing source/UI/auth/import/AI seams. Preserve current notes, Calendar identities, connections, saved drafts and credentials. Record actual progress in ACCEPTANCE. Keep all private credentials, caches and native acceptance artifacts ignored before writing them.

### M1: Share the smallest necessary source contract

Introduce provider/account/item-qualified references, optional normalized metadata and a small source-session collection. Bridge the existing Todoist read state; do not run its legacy synchronization/recovery machinery for new providers.

Extract shared pure serialization from the current cached-task path. Route normal editor, timeline, frame and schedule actions through the owning source and the existing PlainTaskImporter. Extend consumed-item recognition with provider-aware source links and existing receipts. Keep Todoist-specific occurrence/weak-sync behavior isolated. A copied child stays plain Markdown.

Keep old snapshots, saved pane state, Todoist links, drags and AI drafts compatible. Add small deterministic integration tests before duplicating UI state.

### M2: Google Tasks

Implement bounded list/task reads, hierarchy/order/notes/date normalization, source-specific credential storage and staged account validation. Reuse the existing desktop Google authorization mechanism through narrow parameterization; Calendar defaults must remain unchanged.

Use the owned Google application. Tasks needs API enablement, consent scopes and potentially additional publishing/verification work. Default to a reading grant. Optional explicit completion needs the editing scope, exact list/task resolution, serial requests, immediate row feedback and readback for uncertain responses. Refresh/search/Markdown edits/AI reads never manufacture completion operations.

Check actual app setup using available account tools. Record prerequisites and granted capabilities separately from passing auth fixtures. If a user-only consent step is unavailable, keep its live gate pending and continue the remaining implementation.

### M3: GitHub

Implement owned OAuth-app device flow and a normal Connections experience: code, Copy, Open GitHub, Cancel and useful expiry/permission feedback. Bundle only the public registered client ID. No client secret is required for device flow. Respect returned polling intervals, slow_down, cancellation and token rotation. Store secrets using the existing SecretStorage pattern.

Request read:project. Public browsing needs no repo grant. Private repository support is explicit opt-in because the OAuth repo scope includes write permissions, even though this provider only issues reads. Explain that accurately. A custom public client ID can be tucked under Advanced. Missing owned registration is a specific prerequisite, never a successful sign-in state.

Read identity/issues with bounded REST requests and Projects with GraphQL. Handle pagination, partial permissions, redacted items, field mappings, memberships and rate-limit errors carried in HTTP-200 GraphQL responses. Parse selected repository/Project URLs into fixed API variables. Avoid broad organization-list permissions by accepting an owner/Project URL.

Use native source URLs. A Project draft without a stable individual URL can carry a small validated reference in its Project link's Markdown title. Resolve the current Project-item identity after draft conversion using cached membership; do not add persistent reconciliation machinery.

### M4: Existing UI and AI

Reuse current task rows, search, grouping, sort, Show added, drag feedback, frame rules, Overview and Connections cards. Use a source dropdown rather than crowding the narrow pane with more tabs. Keep per-source preferences small. Capability flags govern source completion actions.

Generalize provider/account routing all the way through active drags, toolbar actions, serialization, consumed detection, Overview and AI references. A schema enum change alone is insufficient. Source/account switches invalidate stale drag and completion work.

AI context and curated buckets use current cached source snapshots and exact references. Preparing proposals remains side-effect free. Reuse review, stale-source validation, locks, Apply and Undo. New provider work must not weaken those guarantees.

Ensure Calendar titles stay human readable and source provenance appears in descriptions. Keep current Calendar UID mappings and scoped update behavior. Preserve stable local timeline DOM identity during optimistic updates.

### M5: Verify and deliver

Complete the main cases in ACCEPTANCE with deterministic fixtures and actual installed UI where available. Test the real shared entry points. Use disposable data for live completion checks. Do not close existing GitHub issues or change Project fields for testing.

Run focused tests first, required TypeScript/test/lint commands, Svelte/style checks and a production build. Identify the inherited ICS timeout separately. Investigate new failures; do not claim a green full suite when it is unavailable.

Before preview installation, back up this plugin's artifacts and check it is idle. Replace only this plugin's generated files. Reload and read back connections, settings, notes, workspace and Calendar identity. An exit code or silent CLI invocation is not acceptance evidence.

Commit coherent milestones and push the feature branch. Keep runtime user data and private screenshots out of commits. Write brief user-facing setup/use notes. Do not publish an installable release that claims normal bundled sign-in while required app registration is missing.

## Request and recovery rules

- Reuse RequestGate for serial bounded requests, cooldown and cancellation. No unbounded retries, automatic note-triggered reads or completion replay loop.
- Initial refresh budget: at most 20 pages/2,000 items per source, pages up to 100. Stop repeated cursors. Show partial coverage and a separate bounded Load more action.
- Refresh on connection, explicit Refresh and source opening when stale, initially five minutes. Search/group/render/AI reads use cache.
- Honor provider Retry-After/reset and secondary limits. Retain last-good data on failure. Never interpret incomplete reads as source deletions.
- Stage credentials and validate identity before replacing the active account. Prevent late old-account requests from publishing rows or writing work.
- Optimistic UI must revert confirmed failures and distinguish uncertain delivery until readback. Avoid rebuilding unaffected timeline blocks.

## Completion standard

Code completion requires both providers through the ordinary pane/import/AI paths, meaningful passing feature checks, a built candidate and an accurate acceptance ledger. Live readiness additionally requires owned-app configuration, real sign-in/read evidence and installed UI verification. Keep these gates distinct.

Finish all independent implementation before reporting an external prerequisite. Do not mark the overall goal achieved merely because fixtures pass or an authentication button renders. If only a user-only authorization/registration action remains, state the precise remaining action and preserve the useful tested implementation. Follow the goal tool's blocking rules; do not silently treat missing live evidence as success.

Report what works, the evidence level, any remaining prerequisite and the branch/commits. Keep the result understandable without requiring the user to read the work log.
