<script lang="ts">
  import { RefreshCw, Settings, CalendarClock } from "lucide-svelte";
  import { DateTime } from "luxon";
  import { Notice } from "obsidian";
  import { readable, type Readable, type Writable } from "svelte/store";

  import { taskGroups, type TaskViewState } from "../../tasks/browser";
  import type { CaptureCandidate } from "../../tasks/capture-parser";
  import type { NoteTaskDrag } from "../../tasks/note-drag";
  import type { TaskScheduler } from "../../tasks/schedule";
  import type { TaskService } from "../../tasks/service";
  import type { ProviderTask } from "../../tasks/types";

  import NoteTasksSection from "./note-tasks-section.svelte";

  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- Svelte validates annotated component props.
  let {
    service,
    scheduler,
    preferences,
    noteTasks = readable<CaptureCandidate[]>([]),
    noteDrag,
    connections,
    schedule,
    openNote,
  }: {
    service: TaskService;
    scheduler?: TaskScheduler;
    preferences: Writable<TaskViewState>;
    noteTasks?: Readable<CaptureCandidate[]>;
    noteDrag?: NoteTaskDrag;
    connections?: () => void;
    schedule: (task: ProviderTask) => void;
    openNote: (path: string, line: number) => void;
  } = $props();
  const browser = $derived(service.state);
  const groups = $derived(
    $browser.snapshot ? taskGroups($browser.snapshot, $preferences) : [],
  );
  let query = $derived($preferences.query);
  const projects = $derived(
    new Map(
      $browser.snapshot?.projects.map((project) => [project.id, project.name]),
    ),
  );
  function toggle(id: string) {
    const collapsed = $preferences.collapsed;
    $preferences = {
      ...$preferences,
      collapsed: collapsed.includes(id)
        ? collapsed.filter((item) => item !== id)
        : [...collapsed, id],
    };
  }
  function dueDate(task: ProviderTask) {
    if (!task.due) return "";
    const date = DateTime.fromISO(task.due.date, {
      zone: task.due.timezone ?? $browser.snapshot?.account.timezone,
    });
    return date.toFormat(
      task.due.date.includes("T") ? "d MMM, HH:mm" : "d MMM",
    );
  }
  function drag(event: DragEvent, task: ProviderTask) {
    try {
      if (!event.dataTransfer || !scheduler)
        throw new Error("Reopen the planner before importing tasks.");
      scheduler.drag.start(task, event.dataTransfer);
    } catch (error) {
      event.preventDefault();
      new Notice(
        error instanceof Error ? error.message : "Could not drag this task.",
      );
    }
  }
</script>

<section class="simple-tasks-pane" aria-label="Tasks">
  <header>
    <h2>Tasks</h2>
    <button
      aria-label="Refresh tasks"
      disabled={$browser.loading || !$browser.connected}
      onclick={() => service.refresh(true)}
      title="Refresh tasks"
      ><RefreshCw
        class={$browser.loading ? "spinning" : ""}
        size={16}
      /></button
    >
    <button
      aria-label="Accounts"
      onclick={connections}
      title="Accounts and sign-in"><Settings size={16} /></button
    >
  </header>
  <div class="sources">
    <button onclick={connections}>Todoist</button><button onclick={connections}
      >Google</button
    >
  </div>
  <label class="search"
    ><input
      aria-label="Search tasks"
      oninput={(event) => {
        $preferences = { ...$preferences, query: event.currentTarget.value };
      }}
      placeholder="Search tasks"
      type="search"
      value={query}
    /></label
  >
  <div class="filters">
    <select aria-label="Filter by project" bind:value={$preferences.projectId}>
      <option value="">All projects</option>
      {#each $browser.snapshot?.projects ?? [] as project (project.id)}
        <option value={project.id}>{project.name}</option>
      {/each}
    </select>
    <select aria-label="Group tasks" bind:value={$preferences.groupBy}>
      <option value="date">By date</option><option value="project"
        >By project</option
      >
    </select>
  </div>
  {#if $browser.error}<div class="connection-error" role="status">
      {$browser.error}<button onclick={connections}>Sign in</button>
    </div>{/if}
  <div class="task-sources">
    <NoteTasksSection candidates={$noteTasks} {noteDrag} {openNote} {query} />
    {#if !$browser.connected}<button class="signin" onclick={connections}
        >Sign in with Todoist</button
      >{/if}
    {#each groups as group (group.id)}
      <details
        ontoggle={(event) => {
          if (
            event.currentTarget.open ===
            $preferences.collapsed.includes(group.id)
          )
            toggle(group.id);
        }}
        open={!$preferences.collapsed.includes(group.id)}
      >
        <summary>{group.label}<span>{group.count}</span></summary>
        {#each group.rows as row (row.task.id)}
          <div
            style:padding-left={`${8 + row.depth * 12}px`}
            class="import-task"
            aria-label={row.task.title}
            draggable={$browser.connected}
            ondragend={() => scheduler?.drag.cancel()}
            ondragstart={(event) => drag(event, row.task)}
            role="group"
          >
            {#if row.hasChildren}<button
                class="expand-task"
                aria-expanded={!$preferences.collapsed.includes(
                  `task:${group.id}:${row.task.id}`,
                )}
                aria-label={`Subtasks of ${row.task.title}`}
                onclick={() => toggle(`task:${group.id}:${row.task.id}`)}
                >{$preferences.collapsed.includes(
                  `task:${group.id}:${row.task.id}`,
                )
                  ? "›"
                  : "⌄"}</button
              >{/if}
            <div class="task-content">
              <button
                class="task-title"
                onclick={() => {
                  $preferences = { ...$preferences, selectedId: row.task.id };
                  schedule(row.task);
                }}>{row.task.title}</button
              >
              <div class="task-meta">
                {#if row.depth === 0}<span
                    >{projects.get(row.task.projectId) ??
                      "Unavailable project"}</span
                  >{/if}
                {#if row.task.due}<span>{dueDate(row.task)}</span>{/if}
                {#each row.task.labels as label (label)}<span>#{label}</span
                  >{/each}
              </div>
            </div>
            <button
              class="schedule-task"
              aria-label={`Schedule ${row.task.title}`}
              onclick={() => schedule(row.task)}
              title="Add to schedule"><CalendarClock size={15} /></button
            >
          </div>
        {/each}
      </details>
    {/each}
  </div>
</section>

<style>
  .simple-tasks-pane {
    display: flex;
    flex-direction: column;

    min-width: 0;
    height: 100%;
    padding: 0;

    font-size: var(--font-ui-small);
    color: var(--text-normal);

    background: var(--background-primary);
  }

  header {
    display: flex;
    gap: 6px;
    align-items: center;
    padding: 10px 8px 8px;
  }

  h2 {
    flex: 1;
    margin: 0;
    font-size: 18px;
  }

  button {
    cursor: pointer;

    height: auto;
    padding: 5px;

    color: var(--text-muted);

    background: transparent;
    border: 0;
    box-shadow: none;
  }

  .sources {
    display: flex;
    gap: 8px;
    padding: 0 8px 8px;
  }

  .sources button {
    padding: 4px 8px;
    border: 1px solid var(--background-modifier-border);
    border-radius: 5px;
  }

  .search {
    padding: 0 8px 10px;
  }

  .search input {
    width: 100%;
  }

  .filters {
    display: flex;
    gap: 6px;
    padding: 0 8px 8px;
  }

  .filters select {
    min-width: 0;
    max-width: 100%;
    font-size: var(--font-ui-smaller);
  }

  .filters select:first-child {
    flex: 1;
  }

  .task-sources {
    overflow: auto;
    min-height: 0;
  }

  summary {
    cursor: pointer;
    padding: 9px 8px;
    font-weight: 600;
  }

  summary span {
    margin-left: 8px;
    font-size: 11px;
    color: var(--text-muted);
  }

  .import-task {
    display: flex;
    gap: 5px;
    align-items: flex-start;
    padding: 4px 6px;
  }

  .import-task:hover {
    background: var(--background-modifier-hover);
  }

  .task-content {
    flex: 1;
    min-width: 0;
  }

  .task-title {
    width: 100%;
    color: var(--text-normal);
    text-align: left;
  }

  .task-meta {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;

    padding: 0 5px 4px;

    font-size: var(--font-ui-smaller);
    color: var(--text-muted);
  }

  .task-meta span {
    padding: 0 4px;
    border: 1px solid var(--background-modifier-border);
    border-radius: 4px;
  }

  .expand-task {
    flex-shrink: 0;
    width: 18px;
  }

  .schedule-task {
    flex-shrink: 0;
  }

  .connection-error {
    margin: 0 8px 8px;
    color: var(--text-error);
  }

  .signin {
    margin: 10px;
    color: var(--text-accent);
  }

  :global(.simple-tasks-pane .spinning) {
    animation: spin 1s linear infinite;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
</style>
