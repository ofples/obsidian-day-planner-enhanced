# AI scheduling mockups

These six image-generated boards cover the first-release screens and interaction states. They follow the existing Morgen-inspired Tasks pane and planner style. The written specification defines behavior and wording.

## Screen inventory

- [Planning request and rules](01-planning-request-and-rules.png) covers the selected date range, editable request, working hours, duration, saved instructions and assistant exchange controls.
- [Day and multi-day proposals](02-day-and-multiday-proposals.png) covers pending timeline blocks, selection, approval, dismissal, locks and moved-block previews.
- [Change review and refresh](03-change-review-and-refresh.png) covers before/after times, short reasoning, frame additions and a stale draft after the note changes.
- [Task buckets and frame drops](04-task-buckets-and-frame-drop.png) covers an AI-curated task view, ordinary completion and dragging, frame nesting and explicit category mismatch feedback.
- [Shifting and Undo](05-shifting-and-undo.png) covers a shift request, move preview, accepted schedule, Undo and later-edit protection.
- [Resume, narrow layout and agent states](06-resume-narrow-and-agent-states.png) covers a saved draft, the narrow sidebar, an empty result, assistant exchange and an import failure.

## Design review

The reviewed direction uses the existing charcoal surfaces, muted project colors, category pills and circular task checkboxes. Plan is a small action beside the existing planner controls. Proposal review reuses the Tasks pane and timeline. Approval has a single compact selected-count/action bar. Frame additions retain nested-list content and the existing right-half drag target.

Image-generation artifacts need correction during implementation. Some boards use inconsistent example dates, weekday spacing and a mixture of operating-system window controls. The mockups occasionally show square proposal-selection controls alongside circular task-completion controls. Keep task completion circular and use an accessible selection control with its own label. Existing app chrome and toolbar placement take precedence over generated rearrangements.

Board 01 includes extra preference disclosures for task types and buffers. Limit the first release to the saved prompt, date range, working hours and default duration. Board 06 gives an overly confident empty-result explanation. Show the actual explanation returned by the validated proposal and preserve the visible schedule.

## Refinement pass

Boards 02, 04 and 05 were edited with image generation after source and workflow review. Board 02 now uses Work labels for the frame children, a compact nested child list, a clearly pending Draft summary in the free 14:00-14:30 slot, and a shortened Friday move preview. Redundant times were removed from the multi-day suggestion sidebar to keep one visible time per proposed block. Board 04 uses a lightly tinted right half and return-arrow cursor, with a compact inline label warning. Board 05 now moves Flexible work to 15:00-16:00, Work block to 16:00-17:00 and Wrap up to 17:00-18:00, preserving the fixed 14:00-15:00 meeting. The same values appear in the proposal and accepted result.

Remaining cosmetic artifacts include inconsistent example dates and weekday spacing, mixed operating-system window chrome, and approximate timeline geometry in a few nested examples. Implementation uses the existing date formatter, timeline coordinate system and chrome. The screenshot caption hierarchy and nested-list treatment guide visual implementation. The technical contract supplies exact times and validation behavior.

All six boards were generated with the built-in image generation tool. Exact prompts are stored in [prompts.json](prompts.json).
