<script lang="ts">
  import { ChevronDown, ChevronRight, Lock } from "lucide-svelte";
  import { untrack } from "svelte";

  import type { CaptureCandidate } from "../../tasks/capture-parser";
  import type { NoteTaskDrag } from "../../tasks/note-drag";
  import { noteTaskDragText, noteTaskRows } from "../../tasks/note-list";

  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- Svelte's $props rune is checked by svelte-check.
  const {
    candidates,
    noteDrag,
    query = "",
    initialExpanded = true,
    openNote,
  }: {
    candidates: CaptureCandidate[];
    noteDrag?: NoteTaskDrag;
    query?: string;
    initialExpanded?: boolean;
    openNote: (path: string, line: number) => void;
  } = $props();
  let expanded = $state(untrack(() => initialExpanded));
  let limit = $state(30);
  const rows = $derived(noteTaskRows(candidates, query));
  $effect(() => {
    void query;
    limit = 30;
    if (query.trim()) expanded = true;
  });

  function startDrag(
    event: DragEvent,
    candidate: CaptureCandidate,
    locked: boolean,
  ) {
    if (locked || !noteDrag || !event.dataTransfer) {
      event.preventDefault();
      return;
    }
    noteDrag.start(
      {
        path: candidate.path,
        line: candidate.line,
        text: noteTaskDragText(candidate),
        durationMinutes: undefined,
      },
      event.dataTransfer,
    );
  }
</script>

<section class="note-tasks" aria-label="Note tasks">
  <button
    class="note-heading"
    aria-expanded={expanded}
    onclick={() => (expanded = !expanded)}
    type="button"
  >
    {#if expanded}<ChevronDown size={15} />{:else}<ChevronRight
        size={15}
      />{/if}
    <strong>Note tasks</strong><span>{rows.length}</span>
  </button>
  {#if expanded}
    {#each rows.slice(0, limit) as row (`${row.candidate.path}:${row.candidate.from}`)}
      <div
        style:--note-depth={Math.min(row.depth, 6)}
        class="note-row"
        draggable={Boolean(noteDrag) && !row.locked}
        ondragend={() => noteDrag?.cancel()}
        ondragstart={(event) => startDrag(event, row.candidate, row.locked)}
      >
        <span class="note-circle" aria-hidden="true"></span>
        <button
          class="note-open"
          onclick={() => openNote(row.candidate.path, row.candidate.line)}
          type="button"
        >
          <span class="note-title"
            >{row.candidate.title || "Untitled task"}</span
          >
          <span class="note-path">{row.candidate.path}</span>
        </button>
        {#if row.locked}<Lock
            class="note-lock"
            aria-label="Locked task"
            size={14}
          />{/if}
      </div>
    {/each}
    {#if rows.length > limit}
      <button class="note-more" onclick={() => (limit += 30)} type="button"
        >Show more</button
      >
    {/if}
  {/if}
</section>

<style>
  .note-tasks {
    margin: 0 8px;
    border-bottom: 1px solid var(--background-modifier-border);
  }

  .note-heading,
  .note-open,
  .note-more {
    background: transparent;
    border: 0;
    box-shadow: none;
  }

  .note-heading {
    display: flex;
    gap: 7px;
    align-items: center;

    width: 100%;
    padding: 11px 9px;

    text-align: left;
  }

  .note-heading > span {
    margin-left: auto;
    font-size: 11px;
    color: var(--text-muted);
  }

  .note-row {
    display: flex;
    gap: 8px;
    align-items: flex-start;

    min-width: 0;
    padding: 7px 6px 7px calc(20px + var(--note-depth) * 15px);

    border-radius: 6px;
  }

  .note-row:hover {
    background: var(--background-modifier-hover);
  }

  .note-circle {
    flex: none;

    width: 14px;
    height: 14px;
    margin-top: 3px;

    border: 1px solid var(--text-muted);
    border-radius: 50%;
  }

  .note-open {
    display: flex;
    flex: 1;
    flex-direction: column;
    align-items: flex-start;

    min-width: 0;
    padding: 0;

    text-align: left;
  }

  .note-title,
  .note-path {
    max-width: 100%;
    overflow-wrap: anywhere;
  }

  .note-path {
    font-size: 11px;
    color: var(--text-muted);
  }

  :global(.note-tasks .note-lock) {
    flex: none;
    color: var(--text-muted);
  }

  .note-more {
    margin: 4px 20px 10px;
    color: var(--text-accent);
  }
</style>
