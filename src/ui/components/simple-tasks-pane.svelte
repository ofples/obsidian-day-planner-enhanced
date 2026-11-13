<script lang="ts">
  import {
    AlertCircle,
    CalendarClock,
    ChevronDown,
    ChevronRight,
    Flag,
    FileText,
    CheckCheck,
    ListChecks,
    RefreshCw,
    Search,
    Settings,
    X,
  } from "lucide-svelte";
  import { DateTime } from "luxon";
  import { Notice } from "obsidian";
  import { readable, type Readable, type Writable } from "svelte/store";

  import { tasksAddedToNote } from "../../tasks/added-to-note";
  import { taskGroups, type TaskViewState } from "../../tasks/browser";
  import type { CaptureCandidate } from "../../tasks/capture-parser";
  import type { NoteTaskDrag } from "../../tasks/note-drag";
  import { noteTaskRows } from "../../tasks/note-list";
  import type { ImportedTaskSource } from "../../tasks/plain-import";
  import type { TaskScheduler } from "../../tasks/schedule";
  import type { TaskService } from "../../tasks/service";
  import type { TaskSource } from "../../tasks/source";
  import type { ProviderTask } from "../../tasks/types";
  import { TaskRenderCache } from "../task-render-cache";
  import "../task-panel.css";

  import NoteTasksSection from "./note-tasks-section.svelte";

  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- Svelte validates annotated component props.
  let {
    service,
    scheduler,
    preferences,
    noteTasks = readable<CaptureCandidate[]>([]),
    noteDrag,
    noteContext = readable({ currentPath: "", targetPath: "" }),
    resolveImported,
    connections,
    schedule,
    openNote,
  }: {
    service: TaskService;
    scheduler?: TaskScheduler;
    preferences: Writable<TaskViewState>;
    noteTasks?: Readable<CaptureCandidate[]>;
    noteDrag?: NoteTaskDrag;
    noteContext?: Readable<{ currentPath: string; targetPath: string }>;
    resolveImported?: (uid: string) => TaskSource | undefined;
    connections?: () => void;
    schedule: (task: ProviderTask) => void;
    openNote: (path: string, line: number) => void;
  } = $props();
  const browser = $derived(service.state);
  const snapshot = $derived($browser.snapshot);
  const source = $derived($preferences.source ?? "todoist");
  const emptyImports = readable<Record<string, ImportedTaskSource>>({});
  const imports = $derived(scheduler?.importer.imports ?? emptyImports);
  const addedIds = $derived.by(() => {
    void $imports;
    return snapshot
      ? tasksAddedToNote({
          snapshot,
          path: $noteContext.targetPath,
          candidates: $noteTasks,
          imports: scheduler?.importer.sources() ?? $imports,
          resolve: resolveImported,
        })
      : new Set<string>();
  });
  const grouping = $derived($preferences.groupBy);
  const groups = $derived(
    snapshot
      ? taskGroups(
          snapshot,
          $preferences,
          undefined,
          $preferences.showAdded ? undefined : addedIds,
        )
      : [],
  );
  function scanOtherNotes() {
    $preferences = {
      ...$preferences,
      scannedNotePaths: [
        ...new Set(noteTaskRows($noteTasks).map((row) => row.candidate.path)),
      ].sort(),
    };
  }
  const completeGroups = $derived(
    snapshot
      ? taskGroups(snapshot, {
          groupBy: grouping,
          query: "",
          projectId: "",
          selectedId: null,
          collapsed: [],
        })
      : [],
  );
  const rowCache = new TaskRenderCache();
  const renderedGroups = $derived(
    rowCache.project(
      JSON.stringify([snapshot?.provider, snapshot?.account.id, grouping]),
      completeGroups,
      groups,
      $preferences.collapsed,
    ),
  );
  const projects = $derived(
    new Map(snapshot?.projects.map((project) => [project.id, project.name])),
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
    const zone = snapshot?.account.timezone ?? "UTC";
    const date = DateTime.fromISO(task.due.date, {
      zone: task.due.timezone ?? zone,
    }).setZone(zone);
    const today = DateTime.now().setZone(zone);
    const label = date.hasSame(today, "day")
      ? "Today"
      : date.hasSame(today.plus({ days: 1 }), "day")
        ? "Tomorrow"
        : date.toFormat("d MMM");
    return task.due.date.includes("T")
      ? `${label}, ${date.toFormat("HH:mm")}`
      : label;
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
  function choose(task: ProviderTask) {
    $preferences = { ...$preferences, selectedId: task.id };
    schedule(task);
  }
</script>

<section class="simple-tasks-pane dp-task-panel" aria-label="Tasks">
  <header class="task-toolbar">
    <div class="task-heading">
      <h2>Tasks</h2>
      <div class="task-toolbar-actions">
        {#if source === "todoist"}
          <button
            class="task-icon-button"
            aria-label="Refresh tasks"
            disabled={$browser.loading ||
              !$browser.connected ||
              ($browser.retryAt ?? 0) > Date.now()}
            onclick={() => service.refresh(true)}
            title="Refresh tasks"
          >
            <RefreshCw
              class={$browser.loading ? "task-spinning" : ""}
              size={17}
            />
          </button>
        {/if}
        <button
          class="task-icon-button"
          aria-label="Connections"
          onclick={connections}
          title="Accounts and connections"><Settings size={17} /></button
        >
      </div>
    </div>
    <div class="task-source-tabs" aria-label="Task sources" role="tablist">
      <button
        aria-selected={source === "todoist"}
        onclick={() => ($preferences = { ...$preferences, source: "todoist" })}
        role="tab"
        ><span class="task-source-mark"><ListChecks size={15} /></span>Todoist
        <span
          class="task-connection-dot"
          class:connected={$browser.connected}
          aria-label={$browser.connected
            ? "Todoist connected"
            : "Todoist disconnected"}
          role="img"
        ></span>
      </button>
      <button
        aria-selected={source === "notes"}
        onclick={() => ($preferences = { ...$preferences, source: "notes" })}
        role="tab"><FileText size={15} />Notes</button
      >
    </div>
    <label class="task-search"
      ><Search size={16} />
      <input
        aria-label="Search tasks"
        placeholder={source === "notes" ? "Search note tasks" : "Search tasks"}
        type="search"
        bind:value={$preferences.query}
      />
      {#if $preferences.query}<button
          class="task-icon-button"
          aria-label="Clear search"
          onclick={() => {
            $preferences = { ...$preferences, query: "" };
          }}><X size={14} /></button
        >{/if}
    </label>
    {#if source === "todoist"}<div class="task-filter-row">
        <div class="task-grouping" aria-label="Group tasks">
          <button
            aria-pressed={$preferences.groupBy === "date"}
            onclick={() => {
              $preferences = { ...$preferences, groupBy: "date" };
            }}>Date</button
          >
          <button
            aria-pressed={$preferences.groupBy === "project"}
            onclick={() => {
              $preferences = { ...$preferences, groupBy: "project" };
            }}>Project</button
          >
        </div>
        <label class="task-project-filter"
          ><select
            aria-label="Filter by project"
            bind:value={$preferences.projectId}
          >
            <option value="">All projects</option>
            {#each snapshot?.projects ?? [] as project (project.id)}<option
                value={project.id}>{project.name}</option
              >{/each}
          </select><ChevronDown size={13} /></label
        >
      </div>{/if}
    <div class="task-note-filter">
      <span
        title={source === "notes"
          ? $noteContext.currentPath
          : $noteContext.targetPath}
        >{(source === "notes"
          ? $noteContext.currentPath
          : $noteContext.targetPath
        )
          .split("/")
          .pop()
          ?.replace(/\.md$/, "") || "No note selected"}</span
      >
      <button
        aria-label={source === "notes"
          ? "Show scheduled note tasks"
          : "Show tasks already added to this note"}
        aria-pressed={Boolean($preferences.showAdded)}
        onclick={() =>
          ($preferences = {
            ...$preferences,
            showAdded: !$preferences.showAdded,
          })}
        ><CheckCheck size={14} />{source === "notes"
          ? "Show scheduled"
          : "Show added"}</button
      >
    </div>
  </header>
  {#if source === "todoist" && $browser.error}<div
      class="task-review task-connection-error"
      role="status"
    >
      <AlertCircle size={16} />
      <p>{$browser.error}</p>
      <button class="task-text-button" onclick={connections}>Connections</button
      >
    </div>{/if}
  <div class="task-body">
    <div class="task-list-area">
      {#if source === "notes"}<NoteTasksSection
          candidates={$noteTasks}
          currentPath={$noteContext.currentPath}
          {noteDrag}
          {openNote}
          query={$preferences.query}
          remove={(path) =>
            ($preferences = {
              ...$preferences,
              scannedNotePaths: ($preferences.scannedNotePaths ?? []).filter(
                (item) => item !== path,
              ),
            })}
          scan={scanOtherNotes}
          scannedPaths={$preferences.scannedNotePaths ?? []}
          showAdded={Boolean($preferences.showAdded)}
        />{:else}
        {#if !$browser.connected}<div class="task-empty">
            <ListChecks size={28} />
            <h3>Bring your tasks here</h3>
            <button class="task-primary" onclick={connections}
              >Sign in with Todoist</button
            >
          </div>{/if}
        {#if snapshot && !groups.length}<div class="task-empty">
            <Search size={25} />
            <p>
              {!$preferences.showAdded && addedIds.size
                ? "All matching tasks have been added to this note"
                : $preferences.query || $preferences.projectId
                  ? "No matching Todoist tasks"
                  : "No active Todoist tasks"}
            </p>
          </div>{/if}
        <div class="task-groups">
          {#each renderedGroups as renderedGroup (renderedGroup.id)}
            {@const group = renderedGroup.group}
            <section
              class="task-group"
              aria-label={group?.label}
              hidden={!group}
            >
              {#if group}<button
                  class="task-group-heading"
                  aria-expanded={!$preferences.collapsed.includes(group.id)}
                  onclick={() => toggle(group.id)}
                >
                  {#if $preferences.collapsed.includes(group.id)}<ChevronRight
                      size={15}
                    />{:else}<ChevronDown size={15} />{/if}
                  <strong>{group.label}</strong><span>{group.count}</span
                  ></button
                >{/if}
              {#each renderedGroup.rows as renderedRow (renderedRow.row.task.id)}
                {@const row = renderedRow.row}
                <div
                  style:--task-depth={Math.min(row.depth, 6)}
                  class="import-task task-row-container"
                  class:task-added={addedIds.has(row.task.id)}
                  class:task-nested={row.depth > 0}
                  class:task-selected={$preferences.selectedId === row.task.id}
                  aria-label={row.task.title}
                  draggable={$browser.connected && !!scheduler}
                  hidden={renderedRow.hidden}
                  ondragend={() => scheduler?.drag.cancel()}
                  ondragstart={(event) => drag(event, row.task)}
                  role="group"
                >
                  {#if row.hasChildren}<button
                      class="task-tree-toggle task-icon-button"
                      aria-expanded={!$preferences.collapsed.includes(
                        `task:${renderedGroup.id}:${row.task.id}`,
                      )}
                      aria-label={`Subtasks of ${row.task.title}`}
                      onclick={() =>
                        toggle(`task:${renderedGroup.id}:${row.task.id}`)}
                    >
                      {#if $preferences.collapsed.includes(`task:${renderedGroup.id}:${row.task.id}`)}<ChevronRight
                          size={13}
                        />{:else}<ChevronDown size={13} />{/if}
                    </button>{/if}
                  <span class="task-import-circle" aria-hidden="true"></span>
                  <div class="task-row-content">
                    <button
                      class="task-row"
                      class:task-context={row.context}
                      onclick={() => choose(row.task)}
                    >
                      <span class="task-title"
                        >{row.task.title || "Untitled task"}</span
                      ></button
                    >
                    <div class="task-row-meta">
                      {#if addedIds.has(row.task.id)}<span
                          class="task-added-chip">Added</span
                        >{/if}
                      {#if row.depth === 0}<span class="task-project-chip"
                          >{projects.get(row.task.projectId) ??
                            "Unavailable project"}</span
                        >{/if}
                      {#if row.task.due}<span class="task-date"
                          >{dueDate(row.task)}</span
                        >{/if}
                      {#each row.task.labels as label (label)}<span
                          class="task-label-chip">#{label}</span
                        >{/each}
                      {#if row.task.priority > 1}<span
                          class="task-priority"
                          title={`Priority ${5 - row.task.priority}`}
                          ><Flag size={12} /></span
                        >{/if}
                    </div>
                  </div>
                  <button
                    class="task-icon-button task-row-schedule"
                    aria-label={`Schedule ${row.task.title}`}
                    onclick={() => choose(row.task)}
                    title="Add to schedule"><CalendarClock size={16} /></button
                  >
                </div>
              {/each}
            </section>
          {/each}
        </div>
      {/if}
    </div>
  </div>
</section>
