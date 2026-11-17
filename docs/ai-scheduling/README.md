# AI scheduling

This package defines a focused assistant-driven planning preview for Day Planner Enhanced. An assistant can prepare a day or several days, fill frames, shift flexible blocks and organize task buckets. Suggestions appear for review before approved changes enter the existing Markdown and Google sync workflow.

## Design and implementation

- [Plan and milestones](PLAN.md)
- [User stories](USER-STORIES.md)
- [Screen and interaction mockups](mockups/README.md)
- [Technical specification](TECHNICAL-SPEC.md)
- [Focused acceptance cases](ACCEPTANCE.md)
- [Implementation goal prompt](GOAL-PROMPT.md)

## First-preview decisions

Use the existing assistant through a local skill and plugin interface, with context copy and JSON import available. Keep one current proposal and one last-batch Undo. Support the existing one-to-seven-day planner range. Tasks retain their ordinary Markdown, descriptions and weak Todoist links.

Locks and displayed timed calendar commitments constrain approved changes. All-day entries provide context. Saved prose guides the assistant, while the plugin independently validates its structured constraints. Cloud-only Google scheduling is a later adapter.

## Review record

The initial workflow review retained the existing Tasks sources and timeline controls. The source review identified the existing note queue, durable note-change journal, optimistic note display, task serializer, frame matching and lock checks as reuse points.

The second review corrected the batch plan to use an evolving in-memory document map, defined last-focused date-range selection, retained context mappings for independent task views and specified guarded Undo with fenced calendar cleanup. Focus acceptance on the main workflows and these concrete data-preservation risks.

Use bounded parallel work with one integration owner. Independent reviewers cover workflow and source reuse, a dedicated image-generation task produces the mockup set, and implementation/test tasks receive explicit file ownership. This follows the documented bounded-task pattern. [OpenAI multi-agent guidance](https://developers.openai.com/api/docs/guides/responses-multi-agent)

The baseline is commit 1d170b8b1fbd878a46afdae50faa0925e0cf6957, tagged baseline/ai-scheduling-0.9.9. Development uses feat/ai-scheduling in its separate checkout. Completion and verification evidence are recorded in ACCEPTANCE.md.
