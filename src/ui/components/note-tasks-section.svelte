<script lang="ts">
  import {
    ChevronDown,
    ChevronRight,
    FileText,
    Lock,
    ScanSearch,
    X,
  } from "lucide-svelte";

  import type { CaptureCandidate } from "../../tasks/capture-parser";
  import type { NoteTaskDrag } from "../../tasks/note-drag";
  import {
    noteTaskDragText,
    noteTaskRows,
    type NoteTaskRow,
  } from "../../tasks/note-list";

  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- Svelte validates annotated component props.
  const {
    candidates,
    noteDrag,
    query = "",
    currentPath = "",
    scannedPaths = [],
    showAdded = false,
    scan,
    remove,
    openNote,
  }: {
    candidates: CaptureCandidate[];
    noteDrag?: NoteTaskDrag;
    query?: string;
    currentPath?: string;
    scannedPaths?: string[];
    showAdded?: boolean;
    scan: () => void;
    remove: (path: string) => void;
    openNote: (path: string, line: number) => void;
  } = $props();
  let expandedPaths = $state<string[]>([]);
  let collapsedTasks = $state<string[]>([]);
  let currentCollapsed = $state(false);
  let limit = $state(50);
  $effect(() => {
    void currentPath;
    currentCollapsed = false;
  });
  $effect(() => {
    void query;
    limit = 50;
  });
  const paths = $derived(
    [...new Set([currentPath, ...scannedPaths])].filter(Boolean),
  );
  const byPath = $derived.by(() => {
    const grouped = new Map<string, CaptureCandidate[]>();
    for (const task of candidates) {
      const rows = grouped.get(task.path) ?? [];
      rows.push(task);
      grouped.set(task.path, rows);
    }
    return grouped;
  });
  const groups = $derived(
    paths.map((path) => ({
      path,
      current: path === currentPath,
      rows: noteTaskRows(
        byPath.get(path) ?? [],
        query,
        showAdded && path === currentPath,
      ),
    })),
  );
  const key = (row: NoteTaskRow) =>
    `${row.candidate.path}:${row.candidate.from}`;
  function displayed(rows: NoteTaskRow[]) {
    let foldedDepth = Infinity;
    return rows.filter((row) => {
      if (row.depth > foldedDepth) return false;
      foldedDepth = collapsedTasks.includes(key(row)) ? row.depth : Infinity;
      return true;
    });
  }
  function startDrag(event: DragEvent, row: NoteTaskRow) {
    if (
      row.locked ||
      row.candidate.completed ||
      !noteDrag ||
      !event.dataTransfer
    ) {
      event.preventDefault();
      return;
    }
    noteDrag.start(
      {
        path: row.candidate.path,
        line: row.candidate.line,
        text: noteTaskDragText(row.candidate),
        durationMinutes: undefined,
      },
      event.dataTransfer,
    );
  }
</script>

<section class="note-tasks" aria-label="Note tasks">
  {#each groups as group (group.path)}
    {@const expanded =
      query.trim() ||
      (group.current ? !currentCollapsed : expandedPaths.includes(group.path))}
    {@const visible = displayed(group.rows)}
    <section class="note-group" aria-label={group.path}>
      <div class="note-heading-row">
        <button
          class="note-heading"
          aria-expanded={Boolean(expanded)}
          onclick={() => {
            if (group.current) currentCollapsed = !currentCollapsed;
            else
              expandedPaths = expandedPaths.includes(group.path)
                ? expandedPaths.filter((path) => path !== group.path)
                : [...expandedPaths, group.path];
          }}
          type="button"
        >
          {#if expanded}<ChevronDown size={14} />{:else}<ChevronRight
              size={14}
            />{/if}
          <FileText size={14} />
          <span class="note-group-title"
            ><strong
              >{group.current
                ? "Current note"
                : group.path.split("/").pop()?.replace(/\.md$/, "")}</strong
            ><span title={group.path}>{group.path.replace(/\.md$/, "")}</span
            ></span
          >
          <span class="note-count"
            >{group.rows.filter((row) => !row.context).length}</span
          >
        </button>
        {#if !group.current}<button
            class="task-icon-button"
            aria-label={`Remove ${group.path} from scanned notes`}
            onclick={() => remove(group.path)}><X size={13} /></button
          >{/if}
      </div>
      {#if expanded}
        {#if !group.rows.length}<p class="note-empty">
            {query.trim()
              ? "No matching tasks"
              : showAdded && group.current
                ? "No active tasks in this note"
                : "No unscheduled tasks in this note"}
          </p>{/if}
        {#each visible.slice(0, limit) as row (key(row))}
          <div
            style:--note-depth={Math.min(row.depth, 6)}
            class="note-row"
            class:note-context={row.context}
            class:note-scheduled={row.scheduled}
            draggable={Boolean(noteDrag) &&
              !row.locked &&
              !row.candidate.completed}
            ondragend={() => noteDrag?.cancel()}
            ondragstart={(event) => startDrag(event, row)}
          >
            {#if row.hasChildren}<button
                class="task-icon-button note-tree-toggle"
                aria-expanded={!collapsedTasks.includes(key(row))}
                aria-label={`Subtasks of ${row.candidate.title}`}
                onclick={() => {
                  const id = key(row);
                  collapsedTasks = collapsedTasks.includes(id)
                    ? collapsedTasks.filter((item) => item !== id)
                    : [...collapsedTasks, id];
                }}
                >{#if collapsedTasks.includes(key(row))}<ChevronRight
                    size={12}
                  />{:else}<ChevronDown size={12} />{/if}</button
              >{/if}
            <span class="note-circle" aria-hidden="true"></span>
            <button
              class="note-open"
              onclick={() => openNote(row.candidate.path, row.candidate.line)}
              type="button"
              ><span class="note-title"
                >{row.candidate.title || "Untitled task"}</span
              ></button
            >
            {#if row.scheduled}<span class="note-status">Scheduled</span>{/if}
            {#if row.locked}<Lock
                class="note-lock"
                aria-label="Locked task"
                size={12}
              />{/if}
          </div>
        {/each}
        {#if visible.length > limit}<button
            class="task-text-button note-more"
            onclick={() => (limit += 50)}>Show more</button
          >{/if}
      {/if}
    </section>
  {/each}
  {#if !currentPath}<p class="note-empty">
      Open a note to see its tasks here.
    </p>{/if}
  <button class="note-scan" onclick={scan}
    ><ScanSearch size={15} />{scannedPaths.length
      ? "Refresh other notes"
      : "Scan other notes"}</button
  >
</section>

<style>
  .note-tasks {
    padding: 0 8px 14px;
  }

  .note-group {
    padding-bottom: 7px;
    border-bottom: 1px solid var(--tp-border);
  }

  .note-heading-row {
    display: flex;
    align-items: center;
    min-width: 0;
  }

  .note-heading {
    display: flex;
    flex: 1;
    gap: 6px;
    align-items: center;

    width: 100%;
    min-width: 0;
    padding: 12px 5px;

    text-align: left;
  }

  .note-group-title {
    display: grid;
    flex: 1;
    min-width: 0;
  }

  .note-group-title > span {
    overflow: hidden;

    font-size: 10px;
    color: var(--tp-muted);
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .note-count {
    font-size: 11px;
    color: var(--tp-muted);
  }

  .note-row {
    position: relative;

    display: flex;
    gap: 8px;
    align-items: flex-start;

    min-width: 0;
    padding: 8px 6px 8px calc(20px + var(--note-depth) * 13px);

    border-radius: 6px;
  }

  .note-row:hover {
    background: var(--tp-hover);
  }

  .note-context {
    color: var(--tp-muted);
  }

  .note-circle {
    flex: none;

    width: 13px;
    height: 13px;
    margin-top: 3px;

    border: 1px solid var(--tp-muted);
    border-radius: 50%;
  }

  .note-open {
    flex: 1;
    min-width: 0;
    padding: 0;
    text-align: left;
  }

  .note-title {
    overflow-wrap: anywhere;
  }

  .note-empty {
    padding: 10px 12px 15px;
    font-size: 12px;
    color: var(--tp-muted);
  }

  .note-status {
    flex: none;
    font-size: 10px;
    color: var(--tp-muted);
  }

  .note-scan {
    margin-top: 12px;
    color: var(--tp-accent);
  }

  .note-more {
    margin: 5px 20px;
  }

  :global(.note-tasks .note-tree-toggle) {
    position: absolute;
    top: 8px;
    left: calc(2px + var(--note-depth) * 13px);
    padding: 2px;
  }

  :global(.note-tasks .note-lock) {
    flex: none;
    margin-top: 4px;
    color: var(--tp-muted);
  }
</style>
