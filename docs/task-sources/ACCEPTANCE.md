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

| Gate                          | Status   | Evidence to record                                                                             |
| ----------------------------- | -------- | ---------------------------------------------------------------------------------------------- |
| Baseline preserved            | Complete | Feature checkout starts at f4050c7272fc36145140cc5a6b4ffbf92ed8bcc0; stable checkout retained. |
| API/source audit              | Complete | Official links and design decisions in PLAN and TECHNICAL-SPEC.                                |
| Shared source contracts       | Pending  | Qualified identity, compatibility and import tests.                                            |
| Google Tasks adapter          | Pending  | Fixtures, selected lists, cached browser, optional completion.                                 |
| GitHub adapter                | Pending  | Issues/Projects fixtures, permissions, memberships, mappings.                                  |
| Pane/import/AI integration    | Pending  | A5/A6/A8 through ordinary application entry points.                                            |
| Owned app configuration       | Pending  | Tasks API/scopes and GitHub OAuth device-flow registration; no secrets.                        |
| Live authorization/read       | Pending  | Provider/account, granted capabilities and successful bounded read; no personal content.       |
| Installed UI                  | Pending  | Candidate commit, scenarios and observed results, distinct from fixtures.                      |
| Required source checks/build  | Pending  | Exact commands/results and inherited failures.                                                 |
| Preview installation/readback | Pending  | Backup, artifact match and preserved state.                                                    |

Update this table as work progresses. If authentication requires user participation, finish independent code and fixture work first, state the exact remaining step and retain the corresponding gate as pending. A registered client ID alone is not successful authentication.
