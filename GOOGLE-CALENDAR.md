# Google Calendar two-way sync (development fork)

This fork adds direct Google Calendar API sync to Day Planner Enhanced. It mirrors **titles and start/end times** between top-level timed blocks in daily notes and one writable Google calendar, and applies configurable event colors from the planner. Existing Google events can also appear directly as calendar entries. Daily notes remain ordinary Markdown.

This is a development implementation. Automated tests exercise the sync engine, note adapter, REST requests and OAuth callback. Desktop Google consent and live title/time round trips have also been verified with a dedicated calendar. Test your own setup before enabling automatic sync for an important calendar.

## Existing alternatives checked

| Project | Documented behavior | Fit for existing Day Planner schedules |
| --- | --- | --- |
| [Day Planner Enhanced](https://github.com/jagaldol/obsidian-day-planner-enhanced) | Read-only ICS calendars | No outbound or two-way Markdown sync |
| [Time Blocks](https://github.com/jonmccon/obsidian-time-blocks) | Two-way Google sync for its scheduled blocks | A different planner and scheduling store |
| [ObsidianGoogleCalendarSync](https://github.com/BJSchmidt/ObsidianGoogleCalendarSync) | Two-way event-per-note sync | Separate event notes and YAML properties |
| [Google Calendar and Tasks Sync](https://github.com/namnguyen-code/obsidian-google-sync-bridge) | Imports event/task notes and patches existing Google items | Does not create Google items from local-only notes |
| [Sasoon's Google Calendar Sync](https://github.com/Sasoon/obsidian-gcal-sync) | One-way task export using dated-task metadata | No Google-to-Day-Planner update path |

No existing drop-in bridge for Day Planner Enhanced's daily-note time ranges was identified in this search. The alternatives above may suit a different workflow; this is not a claim that no other project exists.

## Setup

1. Use **Obsidian 1.11.4 or later**. Optional Google sync uses Obsidian SecretStorage. The rest of Day Planner keeps its existing minimum version.
2. In [Google Cloud Console](https://console.cloud.google.com/), create or select a project and enable **Google Calendar API**. Standard Calendar API use is free; Google may require a billing account when creating a project. No paid resources are needed for this setup.
3. Configure Google Auth Platform's consent screen. If the app is External and in Testing, add your Google account as a test user. Google's testing-mode refresh tokens can expire after seven days for these scopes; reconnect when needed.
4. Create an OAuth client with application type **Desktop app**. Copy its client ID and client secret. A Desktop client uses an ephemeral `http://127.0.0.1:<port>/oauth2callback` redirect; do not create a Web client or use the deprecated out-of-band copy/paste flow.
5. Create a dedicated Google calendar for the schedule. Copy its **Calendar ID** from Google Calendar → Settings → the calendar → Integrate calendar. This is the calendar ID, not its secret ICS URL.
6. Build this branch with `npm ci` and `npm run build`. Copy `main.js`, `styles.css` and `manifest.json` into the existing `day-planner-enhanced` plugin folder in a **test vault**, then reload Obsidian. Keep a copy of the previous plugin files outside the vault if replacing an installation.
7. Open Settings → Day Planner Enhanced → **Google Calendar two-way sync**. Expand **How to set up Google Calendar sync** for inline instructions, official setup links and troubleshooting. Enter the client ID, save the client secret, and enter the target calendar ID. Click **Connect** and finish consent in your browser. Under Google Auth Platform → Data Access, the requested scopes are `https://www.googleapis.com/auth/calendar.events` and `https://www.googleapis.com/auth/calendar.calendarlist.readonly`.
8. Keep automatic sync off initially. Run **Sync Google Calendar now**. Test both directions with a disposable event, including renaming, resizing, changing days, cancellation, and an offline/restart recovery. Enable automatic sync only after verifying your setup.

### Calendar display and colors

- **Show Google calendar events** displays events directly in the planner. **Choose calendars** lets you select calendars, including an empty selection, or follow the selection in Google Calendar. It initially follows Google Calendar's selected calendars. Events refresh when changing planner dates, every minute while connected, and through the timeline menu.
- New Google events appear as calendar entries by default. **Import new Google events into daily notes** optionally creates tasks for timed events in the dedicated sync calendar. Existing linked note blocks continue syncing in both directions. Events from other displayed calendars are display-only. Linked schedule events are excluded from the calendar overlay to avoid duplicate blocks.
- **Google color for [rule]** assigns a Google event color to each existing planner color rule. The first matching rule wins. Automatic matching uses the nearest Google palette color to the rule's light-mode color, making the mapping stable across Obsidian themes. **Google color for other schedule blocks** controls the remaining blocks and can automatically match the time-of-day gradient.
- Google supports a fixed event palette, so arbitrary planner hex colors are approximated. Color changes apply on the next sync, including already linked events. Color-only updates use conditional PATCH requests and do not rewrite note content.
- **Sync Google Calendar and refresh calendars** in the timeline menu runs two-way schedule sync and refreshes displayed Google and ICS events.

With note import enabled, each recurring Google event occurrence in the import window becomes a separate daily-note block. Editing it changes that occurrence. Configure recurring series in Google Calendar.

## Behavior

```markdown
# Day planner

- [ ] 09:00 - 10:00 Work #work <!-- dp-gcal:0123456789abcdef0123456789abcdef --> ^existing-id
    - [ ] Follow-up [[Project]]
```

- New eligible daily-note blocks get a hidden ID comment when sync runs. **Keep the ID when editing, sorting, renaming, or moving a block.** Remove the ID from a deliberate copy that should become a new event. Duplicate IDs stop the sync before Google writes.
- Only top-level timed list items under the configured planner heading are exported. Timed and untimed children remain in the parent Markdown subtree, and are not separately exported. Children, task completion status, links and block IDs stay in Obsidian.
- When optional note import is enabled, Google events in the dedicated calendar are imported as ordinary timed daily-note blocks. The plugin creates daily notes through the existing Daily Notes / Periodic Notes integration, including its templates and date format.
- Single-start blocks use the planner's configured duration or stretch-to-next setting. Explicit overnight ranges are supported. Timestamps use the device's local timezone and are sent to Google as absolute instants.
- The initial discovery window defaults to 7 days back and 30 days ahead. Existing linked blocks continue to be reconciled by ID even if moved outside that window. This avoids interpreting a date move as deletion.
- Local title/time changes patch those fields in Google. Remote title/time changes edit only the matching source block. Date moves carry the entire subtree to the destination daily note using a persisted recovery journal.
- Google descriptions, guests, conferencing links, locations, reminders and recurrence rules are not mirrored into the task text, and are preserved by title/time PATCH requests.
- Checkbox completion has no equivalent on a Google Calendar event; checking a task does not delete or complete its calendar event.
- A Google cancellation turns its note block into a visibly cancelled, untimed `- [-] Cancelled in Google Calendar: …` entry. Children and the old time range are retained as history.
- **Local deletion propagation is off by default.** Enabling it allows removing a linked block from an existing daily note to delete its unchanged Google event. A missing/renamed note, an ID found elsewhere in the vault, a removed heading, or a conflicting edit prevents that deletion. Disabling it leaves the Google event intact and reports the removal as a conflict.
- If both sides changed differently since the last successful sync, the plugin preserves both and reports a conflict. Run manual sync to see the conflict details. To resolve it, make the title and times agree on both sides and sync again. Do not remove tracking comments or reset the state file as a conflict-resolution method.
- Optional background sync runs once per minute while Obsidian is open. Enable it on **one device at a time**. A second device changing the state file stops further saves and requires restarting Obsidian to reload the shared state. This is not a distributed locking system.

## Supported scope and limitations

- Note sync supports timed events of at most 24 hours, aligned to whole minutes. All-day events, events longer than 24 hours and Google's special event types are not imported as tasks. The calendar overlay displays timed and all-day events. Sub-minute timestamps are reported instead of silently rounded for note sync. Titles use a single line with normalized whitespace; HTML comments remain private to the note.
- Google sign-in is desktop-only. No hosted authentication relay is used. Mobile sign-in and acceptance are not implemented; leave calendar sync disabled there. Ordinary planner features still work.
- No Google Tasks sync, attendee/invitation UI, series-level recurrence editor, or live push/webhook listener.
- Avoid adding an ICS subscription for the same calendar: it would display the same events again alongside their synced daily-note blocks. ICS sources for other calendars remain available.
- The local timezone should be consistent across devices. DST transitions and travel across timezones require live acceptance testing.

## Credentials, identity and recovery

- OAuth uses a random state parameter, PKCE S256 and a loopback listener bound only to `127.0.0.1`. Client secret and refresh token use Obsidian SecretStorage; the access token stays in memory. They are never written to the plugin's `data.json` or sync-state file by this code.
- Requested scopes: `calendar.events` and `calendar.calendarlist.readonly`. Writes use the configured writable calendar, whose resolved ID is pinned to its mappings. Calendar display reads events from the calendars selected in the display settings.
- Network destinations are Google's OAuth endpoints and Calendar API, plus the local callback listener. There is no third-party proxy, hosted token service or telemetry.
- `gcal-state.json` alongside the plugin files contains the namespace, calendar ID, mappings, last-synced title/times, cancellation tombstones and any pending move/import journal. Treat it as private calendar data and preserve it when updating the plugin. The source repository ignores it.
- Create operations use deterministic Google event IDs; a retry after a timeout adopts the existing event rather than inserting another. Imported events use deterministic local IDs so an interrupted import can be recovered too.
- Updates and deletes carry `If-Match` with Google's event ETag. A concurrent change returns a conflict instead of overwriting newer data. Listings are paginated completely before reconciliation; absence from a discovery window is followed by an ID lookup.
- A failed operation does not advance that item's successful baseline. Cross-note moves save their intent before appending the destination, remove the unchanged original afterward, and recover the journal before a later sync. Imports save their event identity before writing the note, so recovery still works if Google subsequently moves the event out of the discovery window.
- Disconnect removes the local refresh token without deleting notes, mappings or events. Revoke the application's access separately in your Google account if desired.

Google references: [Desktop OAuth](https://developers.google.com/identity/protocols/oauth2/native-app), [ETags and conditional modifications](https://developers.google.com/workspace/calendar/api/guides/version-resources), [event creation and IDs](https://developers.google.com/workspace/calendar/api/v3/reference/events/insert).

## Validation of this implementation

- 60 new automated tests pass across reconciliation, Markdown, vault writes and recovery, display-only calendars, color mapping, HTTP transport, and a real local OAuth callback with a mocked Google token endpoint.
- Full suite: 657 passed, 1 failed, 9 skipped and 17 todo. The failure is the existing ICS test `Last visible day is inclusive` in `tests/ical.test.ts`; it also fails on a separate, untouched checkout of upstream commit `db64375d` with the same environment and dependencies.
- Prettier, ESLint, stylelint, TypeScript, Svelte diagnostics, the stricter scorecard lint and the production build pass. The aggregate `npm run lint` stops at the inherited test failure, so it is not an all-green result.
- Windows checkout CRLF bytes in the test fixtures had to be normalized back to the repository's LF content so the recorded metadata offsets matched. No fixture or unrelated source changes are included in this branch.
- Installed desktop acceptance verified Google consent, SecretStorage credentials, initial schedule export, Google event import, title/time edits in both directions, and Google cancellation. The expandable setup row is present in installed settings. Desktop sign-in uses a guarded CommonJS Node HTTP import because Chromium cannot resolve `import("node:http")` in Obsidian's plugin loader.
- Live cross-day moves, offline/restart recovery, mobile behavior and DST/travel scenarios remain unverified. Automatic sync runs only while Obsidian is open; Google apps left in Testing can require reconnection after seven days.
