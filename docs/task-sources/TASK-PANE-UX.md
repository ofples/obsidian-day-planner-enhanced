# Task browsing and details

The Tasks pane separates source selection, view preferences and scheduling.

- A compact source strip switches between Overview, Notes, Todoist, Google Tasks and GitHub. Arrow keys, Home and End navigate the strip. Each source remembers its browsing preferences.
- Search stays visible. View opens grouping, sorting and source scope controls. Active project and GitHub scope filters can be cleared from the toolbar.
- The selected note and Show added toggle stay visible during triage. Added tasks remain hidden by default.
- Clicking a provider task title opens a non-modal details card. Dragging and the calendar button continue to schedule through the existing importer.
- Details include the source account, description, labels, project/list, supported status/date metadata and a collapsible subtask list. Source text is rendered as text, never executable HTML.
- Add to selected note appends an untimed Markdown copy through the existing queued importer. Schedule opens the existing time picker. Neither action changes source dates or details. Completion stays a separate, capability-gated checkbox action.
- Details follow cache updates and close when their task disappears, the source changes or the account changes. Escape restores focus; clicking outside dismisses the card. Top-layer positioning keeps cards within the app window and out of the sidebar's clipping region.
- Saved views store the current source, search, scope, grouping and sort preferences in the existing workspace view state. They store no task copies, credentials or synchronization ownership. At most 20 views can be saved; each can be deleted from View. Assistant-curated views remain temporary and cannot be saved through this control.

Date labels preserve source semantics: Todoist due date, Google Tasks scheduled date, GitHub target date, and planner time blocks remain distinct. Detail editing beyond existing completion capabilities belongs in the source application.

## Main acceptance scenarios

1. Switch sources and return: previous filters return; stale drags are cancelled.
2. Click a task: description and subtasks appear without scheduling or provider writes. Schedule and dragging still use the original provider-qualified task identity.
3. Add a task to the selected note: insert one untimed copy through the existing importer, hide it under the normal consumed-task rules, and retain a retryable card if insertion fails.
4. Save a filtered view, switch sources, then restore it: source and filters return and survive workspace-state serialization without recursively embedding saved views.
5. Open details and press Escape, click outside, complete/remove the task, disconnect or change accounts: dismiss safely without scheduling stale data.
6. Check normal and narrow pane widths: wrapped titles, circular checkboxes and card bounds stay readable; keyboard users can reach row actions.

Provider authorization/read acceptance remains separate from these UI checks.

## Validation

- Thirteen focused pane/source interaction tests pass, including provider-qualified scheduling, source switching, read-only details, account-change dismissal, Escape focus restoration and saved-view serialization.
- Formatting, ESLint, TypeScript, Svelte diagnostics, the strict whole-source scorecard and production build pass. The full suite reports 1,695 passing tests and the previously recorded unrelated ICS last-visible-day timeout; it is not a fully passing suite.
- Installed-host fixture checks exercise the ordinary Tasks view, top-layer popup positioning, saving a view and the untimed note-import action. The imported parent includes its description, plain child and exactly one source link, and disappears with Show added off. Fixture task-provider reads and writes remain zero.
- Standard and narrow renders of the installed DOM/CSS have no horizontal overflow and retain square dimensions with a 50% border radius for circular checkboxes. These are hidden layout renders, not physical-desktop screenshots or pointer acceptance.
- Installation preservation checks cover settings, loaded plugins, secret values, daily-note contents, Calendar namespace and existing event IDs. Only this plugin's generated JavaScript and stylesheet are replaced.
- Live connection checks and the previously deferred physical-desktop acceptance remain deferred.
