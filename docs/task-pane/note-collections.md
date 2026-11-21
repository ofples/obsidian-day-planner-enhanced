# Folder collections in Notes

This candidate adds folder-backed collections to **Tasks → Notes**. Each Markdown note is one item. Existing checklist tasks remain available alongside collections.

## Add a collection

1. Open **Notes** in the Tasks pane and choose **Add collection**.
2. Choose a vault folder and confirm its name.
3. Choose **Save**. Notes initially use their filenames as titles.

Subfolders are excluded unless **Include subfolders** is enabled. The folder picker is searchable. Removing a collection removes its configuration; its files remain in the vault.

## Use your existing properties

Expand **Customize display** to choose properties already found in the folder:

| Mapping | Behavior |
| --- | --- |
| Title | Shows this property, falling back to the filename when empty. |
| Status | Shows its existing value and provides a quick status filter. |
| Group by | Groups notes by a property; a list can place a note in several groups. |
| Show properties | Adds selected fields beneath each title. |
| Sort by | Sorts by a property or title; numeric properties sort numerically. |
| Duration (minutes) | Uses a numeric value from 1 to 1,440 for linked sessions. |

Filters support **Is any of**, **Is none of**, **Contains**, **Is empty**, and **Is set**. Values within one filter are alternatives; multiple filters must all match. Boolean and numeric values retain their types. Notes without a property can be included using **Is empty**.

An inquiry collection could use `question` for its title, `inquiry-status` for status, and `inquiry-category` for grouping. No particular property names or statuses are required. A note's existing status does not acquire task-completion semantics.

## Read and schedule

Select a note to open its original file. Use the session button to choose a start time and duration, or drag the note to the timeline. The resulting session contains a link to the note. Scheduling and completing that session leave the source note's body and properties unchanged.

Collection configuration and file identities live in plugin settings. No identifying fields, task markers, or default properties are inserted into your notes. Ordinary Obsidian rename events update collection references and preserve item identities. Moves made outside Obsidian while it is closed may require choosing the folder again.

Metadata changes update the list while it is open. An unavailable folder displays recovery guidance; empty folders and filters with no matches have distinct empty states. Long collections load additional rows with **Show more notes**.

## Relationship to Bases

A folder collection and an Obsidian Base can display the same Markdown notes and properties. This version selects a folder directly; it does not evaluate `.base` views, formulas, or filters. Configure the equivalent folder and property filters in the collection.

## Candidate verification

Verified in desktop Obsidian 1.15.1 using a separate profile and disposable vault with synthetic notes. The desktop checks cover the native folder picker, property mappings, grouping, status filtering, recursion, linked-session creation, source-content preservation, opening notes, metadata refresh, note and folder renames, reload persistence, and removing a collection without deleting its files. The narrow editor was inspected visually and measured to keep its Save footer visible while fields scroll independently.

Automated coverage also checks typed filters, numeric sorting, safe Markdown links, stable identities, failed settings-save rollback, drag references, and scheduling recovery without duplicate sessions. No connected task providers or paid services are used by these checks.

The full suite has an existing calendar-test failure: `tests/ical.test.ts` → “Last visible day is inclusive.” Its timeout also reproduces from the unmodified starting commit. This is separate from the folder-collection tests. Installation into a personal vault and GitHub publication are separate from this candidate verification.
