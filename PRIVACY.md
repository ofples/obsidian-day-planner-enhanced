# Day Planner Enhanced privacy notice

Updated 15 November 2026.

This notice describes the Google Calendar and optional Todoist integrations in this development fork of Day Planner Enhanced, also registered with Google as Day Planner Calendar Sync.

## Information used

When you connect Google Calendar, the plugin reads calendar names, identifiers, colors and event information needed to display and synchronize your schedule. Event information can include titles, dates, times, descriptions and task links. Approved schedule synchronization creates, updates or removes events in the configured calendar and updates matching Markdown notes.

If you connect Todoist, the plugin reads task and project information for the task pane. Enabled task capture and linked-task features can create tasks or synchronize titles and completion states with Todoist.

## Processing and storage

Schedule processing runs inside Obsidian on your device. Calendar and task synchronization requests go to Google and Todoist. Configured internet calendar feeds are fetched from their respective providers.

Account credentials are stored through Obsidian SecretStorage. Calendar mappings, cached task information, preferences and recovery records are stored in the vault's plugin configuration folder. Notes remain in your vault. Any backup or vault synchronization tools you configure may copy these local files under your settings.

The bundled Google Desktop app registration identifies the application. Your account authorization is held separately in SecretStorage.

Google user data is used to provide the calendar display and synchronization features requested by you. Use of information received from Google APIs adheres to the Google API Services User Data Policy, including its Limited Use requirements.

## Your controls

You choose the calendars to display and the calendar used for schedule synchronization. You can disable automatic synchronization or sign out in Connections. Signing out removes this plugin's saved account authorization on the device. Existing notes, tasks and calendar events can be managed through Obsidian, Todoist and Google Calendar.

You can also revoke Google access through your Google Account's third-party connections settings. Local caches and configuration can be removed from the plugin folder after disabling the plugin. Backups and synchronized copies are governed by the tools you use to maintain them.

## Contact

Questions about this fork can be raised through its [GitHub issue tracker](https://github.com/ofples/obsidian-day-planner-enhanced/issues). Please omit private calendar entries, credentials and task content from public reports.
