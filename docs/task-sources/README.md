# Task sources preview

This feature branch adds Google Tasks and GitHub work to the existing Tasks pane. The installed preview passed local app/DOM workflow checks. App registration is prepared; live account authorization/readback and a desktop pointer/visual pass remain separate checks. This is a preview, not a generally validated release. See [ACCEPTANCE](ACCEPTANCE.md) for current evidence.

## Connect and browse

Open Tasks, then Connections. Each source signs in and out independently.

- Google Tasks uses Sign in with Google. Its grant is separate from Google Calendar. Choose the lists to include under Task lists and apply the selection. Assigned tasks are optional.
- GitHub uses a device code. Copy the code, open GitHub and approve the app. Start with assigned issues, add repositories as owner/repository, or add a user/organization Project URL. Find my Projects discovers your own Projects.
- For each selected GitHub Project, choose an actual status field and optionally a target-date field. These mappings use field IDs, so renaming a field does not replace it. Project status and issue open/closed state are separate.

Use the source picker in Tasks to switch between Notes, Todoist, Google Tasks and GitHub. Search, grouping, sorting and Show added follow the current pane pattern. Each source remembers its filters. GitHub also offers Assigned to me, Repositories and Projects views.

Source opening refreshes data when it is older than five minutes. Refresh is explicit otherwise. Search and grouping use the cache. Large reads show their partial coverage and offer a bounded Load more action. A source error keeps available cached work usable.

## Plan work

Drag a row into Markdown, a timeline slot or the right half of a frame. The current insertion/time/indentation rules apply. Imported descriptions and children remain ordinary Markdown. The root gets a compact source link. Show added reveals items already copied into the selected note.

Links are best effort. Removing a link can make the source item available again; the plugin does not reconstruct ownership from edited names or times. Copied children have ordinary Markdown semantics. Source links are kept in Google Calendar descriptions, while event titles stay readable.

The new sources do not continuously write Markdown edits back to their platforms. GitHub work is read-only in this first version. Open the source link to change issue/Project workflow state.

Google Tasks completion is optional. Enable Allow completing tasks here and grant editing access, then use the row checkbox. A confirmed completion refreshes the source once for updated child state or a following instance. An uncertain result offers Verify before another write. Schedule Undo concerns the schedule; it does not reopen a source task.

Google Tasks supplies a scheduled day, without an API time-of-day field. GitHub's selected date field is a target date. Timed placements are chosen in the existing scheduling UI.

External checklists do not opt in to creating Todoist tasks. An imported `#todoist` directive in a description is preserved as inline code. You can deliberately add the ordinary tag later through the existing capture workflow.

Overview combines connected sources using qualified identities, including their applicable priority and date buckets. AI planning reads cached source tasks and descriptions, retains provider/account identity and Project metadata, and uses the same preview, review, Apply and Undo flow. Preparing a context does not refresh or mutate task sources. Applying a suggestion rejects changed, completed or disconnected source tasks. A source with a large backlog cannot crowd every other source out of the bounded context. Show added and curated task buckets resolve against the current connected accounts.

## App setup for maintainers

The Google application must have the Tasks API enabled and the requested scopes configured in its consent setup. Publishing/verification and a real authorization/read are separate checks. The existing Calendar registration is reused with separate Tasks credentials; signing out of one source does not sign out the other.

The owned Google project has Tasks API enabled and Tasks read/edit scopes declared. It remains in Production with unverified sensitive scopes and a 100-user cap. Declaration is not an account grant or Google verification. Broad distribution still requires the separate verification process. Existing Calendar sign-in is unchanged.

GitHub needs an owned OAuth app with device flow enabled. Bundle its public client ID through `github-oauth-client.public.json` (`{"clientId":"PUBLIC_CLIENT_ID"}`) or the build environment variable `DAY_PLANNER_GITHUB_CLIENT_ID`. No GitHub client secret is needed for device flow. An optional custom public client ID is under Advanced in Connections.

This branch bundles the owned OAuth application's public client ID. Device flow is enabled; no client secret was generated. User authorization and successful API reads still need live acceptance.

The installed Google Tasks sign-in reached Google's account chooser and then its unverified-app screen. The GitHub sign-in control received a real device code at the official verification URL. Both test flows were canceled before granting new account access; neither remains polling. When resuming live checks, start fresh sign-in from Connections. Google Tasks initially asks for account identity/email and read-only task access. GitHub initially asks for Project read access and expiring-token access, with private repository access left off.

Default GitHub access requests `read:project` and expiring-token access. Including private repositories is an explicit choice: GitHub's `repo` grant includes write permissions, although this integration only reads GitHub work. Organization approval and SSO may impose additional access requirements.

Account credentials stay in Obsidian SecretStorage. Source caches are private runtime files. Before saving them, the plugin adds their ignore pattern to its own installation folder's `.gitignore`, preserving existing rules. The source repository excludes them too. Do not commit tokens, private responses or native acceptance captures.
