# Google Calendar two-way sync (development fork)

This fork adds direct Google Calendar API sync to Day Planner Enhanced. It syncs top-level timed daily-note blocks with one writable Google calendar. A configured **Sync start date** enables the Google-canonical mode described below. A blank date retains the legacy title/time sync. Existing Google events can also appear directly as calendar entries. Daily notes remain ordinary Markdown.

This is a development implementation. Automated tests exercise the sync engine, note adapter, REST requests and OAuth callback. Desktop Google consent and live title/time round trips have also been verified with a dedicated calendar. Test your own setup before enabling automatic sync for an important calendar.

## Existing alternatives checked

| Project                                                                                         | Documented behavior                                        | Fit for existing Day Planner schedules             |
| ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------- | -------------------------------------------------- |
| [Day Planner Enhanced](https://github.com/jagaldol/obsidian-day-planner-enhanced)               | Read-only ICS calendars                                    | No outbound or two-way Markdown sync               |
| [Time Blocks](https://github.com/jonmccon/obsidian-time-blocks)                                 | Two-way Google sync for its scheduled blocks               | A different planner and scheduling store           |
| [ObsidianGoogleCalendarSync](https://github.com/BJSchmidt/ObsidianGoogleCalendarSync)           | Two-way event-per-note sync                                | Separate event notes and YAML properties           |
| [Google Calendar and Tasks Sync](https://github.com/namnguyen-code/obsidian-google-sync-bridge) | Imports event/task notes and patches existing Google items | Does not create Google items from local-only notes |
| [Sasoon's Google Calendar Sync](https://github.com/Sasoon/obsidian-gcal-sync)                   | One-way task export using dated-task metadata              | No Google-to-Day-Planner update path               |

No existing drop-in bridge for Day Planner Enhanced's daily-note time ranges was identified in this search. The alternatives above may suit a different workflow; this is not a claim that no other project exists.

## Setup

1. Use **Obsidian 1.11.4 or later** for Google sync and SecretStorage.
2. Open **Connections** and choose **Sign in with Google**. Packaged builds include the Google Desktop app registration. Select your account and approve calendar access in the system browser.
3. Under **Google Calendar - Schedule sync**, use **Choose calendar** to select a dedicated writable calendar by name. Under **Planner display**, use **Choose calendars** for the calendars you want to see. Apply confirms the selection and Cancel discards it. Existing sync links retain their destination, which is marked in the picker.
4. Set **Sync start date** to the first local day to manage. Use **Sync** in the timeline header and check a disposable event before enabling automatic sync.

### Optional custom Google app

Under **Advanced Google connection**, expand **Developer options** and enable **Use your own Google app** to enter a Desktop OAuth client ID and save its client secret. Disabling the switch selects the bundled registration and retains the custom values. Selecting a different app requires signing in to that app. Saved refresh credentials and cached access tokens are checked against their client ID.

Custom registrations require a Google Cloud project with Calendar API enabled. An External app in Testing issues limited-lifetime authorizations for these Calendar scopes. Publishing a personal-use app to Production removes the testing lifetime for newly issued tokens. An unverified personal app can still show Google's warning and user cap. Public distribution requires the appropriate Google verification.

### Conflicts and explicit note authority

A red dot and count beside the planner controls opens conflict review. Choices are grouped by daily note, with expandable comparisons. **Use Obsidian** applies the saved Obsidian draft and **Use Google** accepts Google's version. Each choice updates the open review immediately. Automatic sync pauses its reconciliation while the review is open.

Choose **Force sync note to Google…** from the planner menu or conflict review. The command palette also provides **Force sync current note to Google Calendar**. Confirm once to send the selected daily note's current timed blocks in one outbound pass. Titles, times, tags, descriptions and subtasks become authoritative. The force action includes removal of linked Google events whose note blocks were removed, and recreates linked events deleted from Google. Existing Google event colors are retained.

Forcing a note clears that note's saved conflict drafts. Review a saved draft with **Use Obsidian** first if you want to restore it to the note. The selected daily note must exist, have its configured planner section and be enabled for sync. The sync start date and `sync: off` property apply. Editing the note during the operation stops further writes. Google version checks and request-rate limits apply to force sync too.

### Building with a Google registration

Provide the Google Desktop OAuth download as the ignored file `google-oauth-client.private.json`, or set `DAY_PLANNER_GOOGLE_APP_CONFIG` to its path. Run `npm ci` and `npm run build`. The production build includes only the Desktop app's client ID and app credential. Account access and refresh tokens stay in SecretStorage. Tests use an unconfigured build and synthetic credentials.

A source build without a supplied registration can use the custom-app option. Existing custom registrations are retained on upgrade. Install only the built `main.js`, `styles.css` and `manifest.json` into the plugin folder, keeping a backup first.

To exclude a note, add either `sync: off` or `sync: false` to its YAML frontmatter. The note is not imported, rewritten, or used to delete its Google event; existing links remain in the sync state. Remove the property and sync again to make the note eligible. This opt-out also applies to notes on or after the start date.

### Calendar display and colors

- **Show Google calendar events** displays events directly in the planner. **Choose calendars** lets you select calendars, including an empty selection, or follow the selection in Google Calendar. It initially follows Google Calendar's selected calendars. Events refresh when changing planner dates, every minute while connected, and through the timeline menu.
- New Google events appear as calendar entries by default. **Import new Google events into daily notes** optionally creates tasks for timed events in the dedicated sync calendar. Existing linked note blocks continue syncing in both directions. Events from other displayed calendars are display-only. Linked schedule events are excluded from the calendar overlay to avoid duplicate blocks.
- **Google color for [rule]** assigns a Google event color to each existing planner color rule. The first matching rule wins. Automatic matching uses the nearest Google palette color to the rule's light-mode color, making the mapping stable across Obsidian themes. **Google color for other schedule blocks** controls the remaining blocks and can automatically match the time-of-day gradient.
- Google supports a fixed event palette, so arbitrary planner hex colors are approximated. In Google-canonical mode the mapping sets the initial color for a newly created event; subsequent Google color choices are preserved. In legacy mode mappings continue to apply to linked events on sync.
- **Sync** in the timeline header runs schedule sync and refreshes displayed Google and ICS events. The timeline menu also provides **Sync**.

With note import enabled, each recurring Google event occurrence in the import window becomes a separate daily-note block. Editing it changes that occurrence. Configure recurring series in Google Calendar.

## Behavior

A `#frame` with exactly one direct child uses the child's name as its Google title. Private event metadata records the frame's container name and displayed child name. Editing that Google title renames the child. Empty frames and frames with multiple direct children use their container name. The complete child list remains in the event description.

```markdown
# Day planner

- [ ] 09:00 - 10:00 Work #work ^existing-id
  - [ ] Follow-up [[Project]]
```

- Sync identities live in the plugin's `gcal-state.json`. Daily notes stay ordinary Markdown with no generated IDs or tracking comments. Existing tracking comments in eligible notes can be migrated into the state file while retaining Google event links; notes outside the configured scope are left untouched. User-created block IDs remain intact.
- Whole block text, existing block IDs, title/time matches and source positions identify edits and moves. Ambiguous simultaneous rewrites or changed counts of identical duplicate blocks stop before Google writes. Apply and sync smaller edits when resolving such a conflict.
- Only top-level timed list items under the configured planner heading create calendar events. In Google-canonical mode, tags and nested Markdown subtasks sync in both directions through an editable Day Planner section of the event description; tags also have private event metadata for reliable matching. The rest of the event description remains editable and is represented in the note. In legacy mode, nested lists are exported to a managed description section; Google edits to that section do not update note subtasks.
- When optional note import is enabled, Google events in the dedicated calendar are imported as ordinary timed daily-note blocks. The plugin creates daily notes through the existing Daily Notes / Periodic Notes integration, including its templates and date format.
- Single-start blocks use the planner's configured duration or stretch-to-next setting. Explicit overnight ranges are supported. Timestamps use the device's local timezone and are sent to Google as absolute instants.
- The discovery window defaults to 7 days back and 30 days ahead. With a start date configured, records whose original synced date precedes it are archived even if an event later moves into the window. The planner can still display older events without syncing their notes.
- Local title/time changes patch those fields in Google. Remote title/time changes edit only the matching source block. Date moves carry the entire subtree to the destination daily note using a persisted recovery journal.
- In Google-canonical mode the note is a local cache of the managed Google event. Independent field changes merge; when both sides change the same field differently, Google is shown in the note and the Obsidian version is kept as a durable draft. Open the conflict review to choose **Use Obsidian** or **Use Google**. A malformed managed description section stops that event for review. Legacy mode retains its one-way subtask export. Unrelated event fields such as guests, conferencing links, locations, reminders and recurrence rules are preserved by field-specific updates.
- Checkbox completion has no equivalent on a Google Calendar event; checking a task does not delete or complete its calendar event.
- A Google cancellation turns its note block into a visibly cancelled, untimed `- [-] ~~original range and title~~` entry. Children and the old time range are retained as history.
- **Local deletion propagation is off by default.** When enabled, a clean removal from an existing daily note can delete its unchanged Google event. Stored note snapshots verify the removal. Missing notes, copies elsewhere, changes to unrelated note content, and ambiguous edits prevent deletion and report a conflict.
- In legacy mode, a conflicting title/time edit requires review and agreement on both sides before syncing again. Do not reset the state file as a conflict-resolution method.
- Optional background sync waits for five seconds without edits and also checks periodically while Obsidian is open. Enable it on **one device at a time**. A second device changing the state file stops further saves and requires restarting Obsidian to reload the shared state. This is not a distributed locking system.

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
- `gcal-state.json` alongside the plugin files contains the namespace, calendar ID, mappings, block identities, note snapshots, last-synced title/times, cancellation tombstones and recovery journals. Preserve this private state file when updating the plugin. Version 2 stores note identities externally. Older builds reject that version, preventing accidental duplicate exports after a downgrade. Restore a matching note/state backup when rolling back. The source repository ignores the file.
- Create operations use deterministic Google event IDs; a retry after a timeout adopts the existing event rather than inserting another. Imported events use deterministic local IDs so an interrupted import can be recovered too.
- Updates and deletes carry `If-Match` with Google's event ETag. A concurrent change returns a conflict instead of overwriting newer data. Listings are paginated completely before reconciliation; absence from a discovery window is followed by an ID lookup.
- A failed operation does not advance that item's successful baseline. Cross-note moves save their intent before appending the destination, remove the unchanged original afterward, and recover the journal before a later sync. Imports save their event identity before writing the note, so recovery still works if Google subsequently moves the event out of the discovery window.
- Disconnect removes the local refresh token without deleting notes, mappings or events. Revoke the application's access separately in your Google account if desired.

Google references: [Desktop OAuth](https://developers.google.com/identity/protocols/oauth2/native-app), [ETags and conditional modifications](https://developers.google.com/workspace/calendar/api/guides/version-resources), [event creation and IDs](https://developers.google.com/workspace/calendar/api/v3/reference/events/insert).

## Validation of this implementation

- 81 new automated tests pass across reconciliation, external identity migration, Markdown, nested subtask descriptions, vault writes and recovery, display-only calendars, color mapping, HTTP transport, and a real local OAuth callback with a mocked Google token endpoint.
- Full suite: 678 passed, 1 failed, 9 skipped and 17 todo. The failure is the existing ICS test `Last visible day is inclusive` in `tests/ical.test.ts`; it also fails on a separate, untouched checkout of upstream commit `db64375d` with the same environment and dependencies.
- Prettier, ESLint, stylelint, TypeScript, Svelte diagnostics, the stricter scorecard lint and the production build pass. The aggregate `npm run lint` stops at the inherited test failure, so it is not an all-green result.
- Windows checkout CRLF bytes in the test fixtures had to be normalized back to the repository's LF content so the recorded metadata offsets matched. No fixture or unrelated source changes are included in this branch.
- Installed desktop acceptance verified Google consent, SecretStorage credentials, initial schedule export, Google event import, title/time edits in both directions, and Google cancellation. The expandable setup row is present in installed settings. Desktop sign-in uses a guarded CommonJS Node HTTP import because Chromium cannot resolve `import("node:http")` in Obsidian's plugin loader.
- Live subtask acceptance verified backfilling linked events, nested lists and completion states, preservation of surrounding description text, repeated-sync stability and removal of the generated section when all children are removed.
- Live cross-day moves, offline/restart recovery, mobile behavior and DST/travel scenarios remain unverified. Automatic sync runs only while Obsidian is open; Google apps left in Testing can require reconnection after seven days.

## Bundled sign-in acceptance

The packaged desktop build uses its included Google registration with the custom-app switch disabled. Installed checks verified refresh and calendar listing with both the saved client ID and separately stored client secret temporarily empty, then restored the custom values. The native settings disclosure hides custom fields by default, reveals them when enabled and retains their values when disabled.

The app's publishing status was read back as In production after the approved homepage and privacy notice were configured. The user completed a new sign-in under Production. Existing Google and Todoist connections, other plugin secret keys, the calendar namespace, every existing managed event identity and daily-note bytes were verified after reload. The installed artifacts match the production build.

Credential binding uses a SecretStorage ID that fits the platform limit even with a full vault namespace. Regression coverage checks that limit, client-bound token caches, cancellation of an in-flight refresh on sign-out, legacy configuration migration and the bundled/custom selection. The full source suite has 1,544 passes and the inherited inclusive-last-day ICS timeout, with nine skips and seventeen todos. Source lint, TypeScript, Svelte diagnostics, strict checks and production compilation pass. Google's unverified-app warning and user cap still apply to the personal-use registration.
