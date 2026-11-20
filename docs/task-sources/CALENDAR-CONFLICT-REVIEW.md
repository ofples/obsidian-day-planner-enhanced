# Calendar conflict review

## Empty-checkbox round trips

An empty Markdown checkbox exports as an emoji checkbox. Calendar editors can remove the trailing space after that symbol. The old reader required that space, so a bare symbol became description text instead of a subtask. The next comparison could then report competing description/subtask changes and insert the symbol as a paragraph in the note.

The reader accepts empty checked and unchecked boxes, including emoji variation selectors, and keeps them in the task list. A regression covers export, line-end trimming, import and Markdown rendering. A full engine regression verifies that a local child added alongside such a placeholder does not conflict with Calendar's whitespace normalization.

This fixes one reproducible formatting cause. Genuine competing edits still require a choice; they are not silently discarded.

## Stable review and resolution

- Unresolved event choices pause automatic Calendar reconciliation. Closing the dialog leaves that pause in effect. Ordinary local note edits and scheduling remain available.
- Manual Sync reopens existing choices instead of running another reconciliation behind them. Refresh conflicts explicitly rechecks the current versions.
- If a calendar operation is already running when review opens, the dialog waits for it to finish before showing choices. It never presents a comparison while that operation is still changing it.
- Review and the bulk-confirmation dialog share a counted hold. Passing from one to the other cannot briefly restart automatic sync.
- Closing while a choice waits cancels that choice. Closing after a choice has begun keeps the hold until the operation settles.
- Applying individual choices retains the existing note-version and Google-etag checks and validates the managed calendar once per review session.
- Saved conflicts that have not yet been refreshed after restart show their count and a clear refresh instruction rather than saying no choices remain.

## Layout

Each note has a separate heading and bulk action. Each event has a bordered card, expanded Obsidian/Google comparison, spaced choice buttons and an explanation of their effects. Comparisons become a single column in narrow windows. Status/errors appear above the choices; refresh and close actions sit in a separate footer.

The bulk action still requires confirmation and explains that making the note authoritative also removes linked Google events for blocks removed from that note.

## Verification

Seventy focused calendar tests pass, including round trips, genuine conflict resolution, review races, force-confirmation handoff, AI batch behavior and deletion recovery. TypeScript, Svelte diagnostics, formatting, ESLint, stylesheet lint, the strict source scorecard and production build pass. The broader test run retains the recorded unrelated ICS last-visible-day timeout; it is not a fully passing suite.

Installed-host fixture checks confirm the review hold, the confirmation handoff, no Calendar validation while held, separated buttons and two-column comparisons. Wide/narrow hidden renders inspect the installed DOM/CSS; they are not physical-desktop screenshots. No live conflict choice or force sync is applied during these checks.
