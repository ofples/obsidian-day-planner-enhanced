# Day Planner Enhanced privacy notice

Updated 19 November 2026.

This notice describes the optional Google Calendar, Google Tasks, Todoist and GitHub integrations in this development fork of Day Planner Enhanced, also registered with Google as Day Planner Calendar Sync.

## Information used

When you connect Google Calendar, the plugin reads calendar names, identifiers, colors and event information needed to display and synchronize your schedule. Event information can include titles, dates, times, descriptions and task links. Approved schedule synchronization creates, updates or removes events in the configured calendar and updates matching Markdown notes.

If you connect Todoist, the plugin reads task and project information for the task pane. Enabled task capture and linked-task features can create tasks or synchronize titles and completion states with Todoist.

Google Tasks uses a separate authorization from Calendar. It reads your account identity, selected task lists and their tasks, including descriptions, hierarchy and scheduled days. Completing tasks from the pane is an optional feature requiring an additional editing grant. Copying a task into a note does not continuously synchronize changes back to Google Tasks.

The optional GitHub source reads account identity, assigned issues, selected repositories and Projects, including issue bodies, labels, assignees and selected Project status/date fields. Private repository access is an explicit choice. GitHub's OAuth repository permission includes writes, although this integration only reads GitHub work. Imported source links and content remain ordinary Markdown.

## Processing and storage

Schedule processing runs inside Obsidian on your device. Calendar and task requests go directly to Google, Todoist or GitHub for the connected source. Configured internet calendar feeds are fetched from their respective providers.

Account credentials are stored through Obsidian SecretStorage. Calendar mappings, cached task information, preferences and recovery records are stored in the vault's plugin configuration folder. Notes remain in your vault. Any backup or vault synchronization tools you configure may copy these local files under your settings.

The bundled Google Desktop app registration identifies the application. Your account authorization is held separately in SecretStorage.

Google user data is used to provide the calendar and task features requested by you. Use of information received from Google APIs adheres to the Google API Services User Data Policy, including its Limited Use requirements.

AI planning contexts are prepared locally from selected notes, cached source tasks and calendar commitments. Exporting or sharing a planning context with an assistant is an explicit action. That context can contain task descriptions and private issue content; the assistant service and its own policies apply when you choose to share it. Source descriptions and issue bodies are treated as task content, not scheduling instructions.

## Your controls

You choose the calendars to display and the calendar used for schedule synchronization. You can disable automatic synchronization or sign out in Connections. Signing out removes this plugin's saved account authorization on the device. Existing notes, tasks and calendar events can be managed through Obsidian, Todoist and Google Calendar.

You can also revoke Google access through your Google Account's third-party connections settings. Local caches and configuration can be removed from the plugin folder after disabling the plugin. Backups and synchronized copies are governed by the tools you use to maintain them.

Each task source signs out independently. You choose Google task lists and GitHub repositories/Projects, and can revoke GitHub access in its authorized-app settings. Signing out does not remove Markdown already imported into your notes or undo actions already completed at the source.

## Contact

Questions about this fork can be raised through its [GitHub issue tracker](https://github.com/ofples/obsidian-day-planner-enhanced/issues). Please omit private calendar entries, credentials and task content from public reports.
