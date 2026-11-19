# Acceptance and progress

Use a small set of realistic workflows. Source tests, authentication, live API reads and installed UI are separate evidence. A fixture result does not establish a working live sign-in.

## Main acceptance cases

| Case                         | User workflow                                                                                                                                               | Expected result                                                                                                                                                                                                                                  |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A1: Existing setup           | Open old Notes/Todoist/Overview settings and a saved AI proposal. Use an existing Todoist item.                                                             | Old settings, weak links, accounts, drafts and normal completion/import still work. No unrelated plugin credentials change.                                                                                                                      |
| A2: Google lists             | Connect, select two lists, browse dated and undated work, search and change grouping. Include a parent with notes and children.                             | Correct account, list names, hierarchy and native order. Date-only tasks remain date-only. Queries and rendering use the cache.                                                                                                                  |
| A3: GitHub work              | Browse assigned issues, a chosen repository and two Projects containing the same issue. Include a draft, project pull request and inaccessible item.        | One issue identity, preserved memberships, distinct item kinds, useful partial-access feedback. No issue/project write is sent.                                                                                                                  |
| A4: Project fields           | Select an actual status field, filter one option and optionally select a date field. Reorder/rename the fields in a fixture refresh.                        | Mappings use IDs; the view uses that Project's order/status/date. Issue closure and Project status remain distinct. A missing mapping asks for reselection.                                                                                      |
| A5: Plan the note            | Drop each new source into the editor, an empty timeline slot and the right half of a frame. Repeat with a parent. Use Show added and Undo.                  | Immediate optimistic feedback; existing insertion/time/indentation/label rules; one source link, readable notes and plain descendants; no duplicate insertion. Hide added applies to the selected note. Undo restores the note/calendar effects. |
| A6: Calendar description     | Schedule a linked item with a description and children, then sync.                                                                                          | Event title contains the human title. Provenance and supporting content appear in the description. Existing Calendar block identity and metadata are retained.                                                                                   |
| A7: Explicit completion      | Enable Google Tasks completion, consent to editing access and complete a disposable task from the sidebar. Simulate a lost response.                        | No write before editing consent and the explicit action. UI responds immediately. Confirmed failure restores it; uncertain delivery requires readback before another write. No indefinite retry. Schedule Undo does not reopen source work.      |
| A8: AI workflow              | Include new-source items in context and a curated bucket. Prepare a proposal, review, Apply and Undo.                                                       | Exact provider/account/item identity; shared source rows; zero writes during preparation; locks/frame rules and stale-source validation work. No source-side mutation.                                                                           |
| A9: Limits and accounts      | Return multiple pages, a repeated cursor, a rate limit and a partial error. Refresh twice, then sign out or replace the account while a request is pending. | Bounded single-flight work, visible cooldown/coverage, retained last-good data, no stale-account publication or pending completion replay. No API calls caused by typing/searching or note edits.                                                |
| A10: Normal UI and rendering | Use Connections and Tasks at a narrow sidebar width. Switch sources, drag, refresh, reload, then update a scheduled block.                                  | Clear status/actions, useful empty states and restored preferences. Ordinary entry points work. Unaffected timeline blocks keep their DOM identity; no font/reload flash.                                                                        |

For A5 also check an unavailable source URL/reference: keep the readable note and source link, with no ownership reconstruction. For A3 check conversion of a Project draft into an issue using the current Project-item alias.

## Verification sequence

1. Adapter fixtures verify normalization, dates, hierarchy, membership deduplication, field selection, pagination and rate-limit classification.
2. Shared integration tests verify qualified identity, source-aware serialization, consumed hiding, drag routing and AI resolution through the real shared entry points.
3. Authentication tests verify staged credentials, device-flow timing/cancel/expiration, scope changes and account replacement. Never commit tokens or recorded private API responses.
4. Run TypeScript, Svelte/style checks, targeted tests, then the repository's required test and lint commands. Build the exact candidate.
5. Inspect normal installed UI using isolated fixtures and existing local app/DOM tooling where possible. Prefer this to mouse takeover. Exercise the real handlers, not a replacement test-only renderer.
6. Configure owned apps and record live sign-in/read checks independently. Use a disposable Google task for the optional completion check. Do not mutate existing GitHub issues or Projects for testing.
7. Before an authorized preview installation, back up this plugin's artifacts, check it is idle and preserve workspace/settings/source caches. Replace only this plugin's generated artifacts. Reload and read back the existing Calendar identity, connections, notes and settings.

The baseline has an inherited inclusive-last-day ICS timeout. Re-run required checks and report its current result accurately. A known baseline failure does not establish that new failures are harmless. Do not broaden this feature into an unrelated ICS rewrite.

## Delivery gates

| Gate                          | Status                 | Evidence to record                                                                             |
| ----------------------------- | ---------------------- | ---------------------------------------------------------------------------------------------- |
| Baseline preserved            | Complete               | Feature checkout starts at f4050c7272fc36145140cc5a6b4ffbf92ed8bcc0; stable checkout retained. |
| API/source audit              | Complete               | Official links and design decisions in PLAN and TECHNICAL-SPEC.                                |
| Shared source contracts       | Complete               | Qualified identity, read bridge, serialization and shared import routing pass focused checks.  |
| Google Tasks adapter          | Code/fixtures complete | Lists, read/auth/completion and pane routes pass; live authorization is a separate gate.       |
| GitHub adapter                | Code/fixtures complete | Issues/Projects/device auth and pane routes pass; owned-app/live checks remain pending.        |
| Pane/import/AI integration    | In progress            | Pane/import routes pass fixtures; Overview aggregation and new-source AI wiring remain.        |
| Owned app configuration       | Pending                | Tasks API/scopes and GitHub OAuth device-flow registration; no secrets.                        |
| Live authorization/read       | Pending                | Provider/account, granted capabilities and successful bounded read; no personal content.       |
| Installed UI                  | Pending                | Candidate commit, scenarios and observed results, distinct from fixtures.                      |
| Required source checks/build  | In progress            | TypeScript, Svelte, style, strict lint and build pass; final full test/lint remains pending.   |
| Preview installation/readback | Pending                | Backup, artifact match and preserved state.                                                    |

Update this table as work progresses. If authentication requires user participation, finish independent code and fixture work first, state the exact remaining step and retain the corresponding gate as pending. A registered client ID alone is not successful authentication.

## Implementation log

### Shared identity foundation

Provider/account/item tuple keys distinguish source and account collisions. Google task keys also include the list. Optional task/container metadata retains GitHub memberships, status and date fields without changing existing cache requirements. A current GitHub Project-item reference can resolve a converted draft's issue; no persistent alias registry is created.

The shared source session, pane, adapters and sign-in are still pending. This foundation does not establish a connected integration.

Checks: 19 tests passed across task-source-references, task-browser and optimistic-interactions. TypeScript and targeted ESLint passed. Full source validation and installed acceptance remain pending for the integrated implementation.

### Read sessions and Google Tasks backend

Added a small read session with single-flight refresh, five-minute cache freshness, account-generation guards, partial-container cache retention and explicit completion. Optimistic completion appears before cache persistence; commands wait for persistence. Uncertain delivery is verified by a later explicit action, with no replay on refresh or restart. Confirmed rejection restores the row without adding an unnecessary verification step.

The Google Tasks adapter reads selected lists with a shared 20-page/2,000-item budget, native hierarchy/order, notes and date-only scheduling. A bounded Load more read skips completed streams. Repeated cursors stop. Explicit completion checks the current task before PATCH and requires an editing grant.

Google authorization now accepts source-specific scopes, a display label and a validation callback. The new backend uses independent credentials and checks identity/list access before saving replacement tokens. Existing Calendar defaults remain covered. The shared HTTP wrapper uses RequestGate, cancellation and scoped authorization errors. GitHub rate-limit classification also handles GraphQL errors carried in HTTP 200.

Checks: 87 tests passed across source references, source session, Google Tasks provider, source HTTP, existing Google Calendar API and request-gate suites. TypeScript, targeted ESLint with zero warnings and formatting checks passed. These are code/fixture results; provider registration, live authorization, pane/import/AI wiring and installed UI are still pending.

### GitHub backend and device authorization

The read adapter covers assigned issues, selected repositories and user/organization Projects v2. Issue node identity is shared across these views. Memberships retain independent Project item IDs, order, status and optional date fields. The view projection changes grouping/order/date without mutating the canonical issue. Drafts, pull requests, redacted items and draft conversion are represented explicitly. Labels remain literal, priority stays neutral, and descriptions have a bounded cache size.

Reads share the page/item budget. REST pagination keeps a fixed page size when continuing. Missing/repeated GraphQL cursors and partial permissions cannot claim complete coverage. Field discovery uses GitHub's common field interface and keeps single-select/date mappings by ID. Private work is excluded from the cached source unless enabled; repository metadata and Project content provide its privacy flag.

Device authorization shows a code and official verification URL, coalesces sign-in, respects pending/slow-down intervals, and stops on cancel/expiry. Account/source reads validate before token replacement. Expiring tokens refresh in one flight and rotate through one SecretStorage value. Canceling sign-in preserves the existing credential. Private repository scope is requested only after explicit opt-in. A missing owned app registration is a setup prerequisite, with no network attempt or false connected state.

Startup now checks the credential's account identity before publishing cached rows. Google Tasks keeps an account marker that is invalidated during account replacement, so a restart during sign-in cannot attach old cached rows to the new grant. Incomplete multi-container reads can retain their previously cached memberships.

Checks: 117 tests passed across ten focused suites, including the existing task browser, optimistic interactions, Calendar API and request gate. TypeScript, formatting and targeted lint passed. Strict source lint also passed after using the common generation guard. The exact Project query was extracted from source and submitted through the existing CLI connection with a deliberately nonexistent node ID. GitHub returned only NOT_FOUND for that ID, confirming schema/query validation. This is distinct from owned-app sign-in and live Project data acceptance.

Owned app registration, real authorization/readback, source-pane/import/AI wiring and installed acceptance remain pending. The installed plugin has not changed.

### Task pane, source links and ordinary imports

The normal Tasks view now receives the source collection and offers a compact source picker. Existing rows, grouping, search, sorting, Show added and schedule forms serve both new providers. Source-specific filters are saved independently. GitHub adds assignment/repository/Project views and status filtering. Native issue numbers, repositories and assignees participate in cached search. Connection cards select Google lists, optionally include assigned tasks, configure GitHub repositories/Projects and map actual fields. Editing and private-access grants remain explicit, with retry actions when a grant is missing.

Editor drops, timeline drops, frame nesting and the schedule form pass provider/account/item references into the same PlainTaskImporter. These imports bypass Todoist ownership even if its experimental mode is enabled. Drag nonces keep their vault/session protection; source/account changes reject stale references. Optimistic drop state is provider-qualified. Existing rendering keys remain unchanged.

The shared serializer preserves descriptions and plain children. New sources do not infer hashtags from repository/list names. External checklist text containing a Todoist creation directive is preserved as inline code, so importing source content cannot opt in to another provider's mutation. Native source URLs remain readable links. Draft/fallback references use a small validated link-title hint. Removing a link remains best effort.

Calendar normalization, description parsing, note rendering and exports recognize the new source links. Event titles stay human readable; descriptions retain provenance. A current account's links and verified import receipts hide work already copied into the selected note. The existing Todoist weak-link helpers still recognize only Todoist.

Google completion performs one bounded follow-up refresh after confirmation to update child state or a following instance. Unknown delivery still requires explicit verification; refresh never replays the command. Unload/cancel stops active reads, and cache/account validation prevents stale rows from becoming a new account's active data. The cache writer installs its ignore pattern in the plugin folder before writing task data, preserving existing ignore rules.

Evidence: 439 tests passed across 27 Calendar/scheduling/import/browser/optimistic suites. A later focused run passed 74 export/settings/import/session checks. The pane/import/settings run passed 44 checks, including the normal source picker, source-qualified schedule/drag handlers, cache-only search, completion controls and configuration actions. The latest cache/import/session run passed 17 checks. These runs overlap and are not a cumulative total.

TypeScript, Svelte checks, formatting, changed-component style checks, full source strict lint and production build passed. Existing build warnings about the output directory and browser-external fs remain. GitHub registration is not bundled yet; the preview's sign-in gate accurately reports missing setup. The current candidate has not been installed.

Next: aggregate all selected sources in Overview and AI context/buckets, then perform final checks, owned-app setup, live authorization and installed acceptance. The goal remains active.
