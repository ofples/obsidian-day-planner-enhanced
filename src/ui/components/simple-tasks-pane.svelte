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
  import {
    get,
    readable,
    writable,
    type Readable,
    type Writable,
  } from "svelte/store";

  import type { AiPlanningService } from "../../ai-scheduling/service";
  import { tasksAddedToNote } from "../../tasks/added-to-note";
  import { planningTaskSelection } from "../../tasks/ai-task-view";
  import { taskDay, taskGroups, type TaskViewState } from "../../tasks/browser";
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
    completeTask,
    weakCompletionEnabled = true,
    openNote,
    planning,
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
    completeTask?: (task: ProviderTask) => void;
    weakCompletionEnabled?: boolean;
    openNote: (path: string, line: number) => void;
    planning?: AiPlanningService;
  } = $props();
  const planningState = $derived(planning?.state ?? readable(null));
  const taskView = $derived($planningState?.taskView ?? null);
  let selectedBucket = $state("");
  const curatedPreferences = writable<TaskViewState>({
    groupBy: "date",
    query: "",
    projectId: "",
    selectedId: null,
    collapsed: [],
  });
  const viewPreferences = $derived(taskView ? curatedPreferences : preferences);
  $effect(() => {
    if (taskView) {
      selectedBucket = taskView.buckets[0]?.id ?? "";
      curatedPreferences.set({
        ...get(preferences),
        source: "overview",
        query: "",
        projectId: "",
        collapsed: [],
      });
    }
  });
  const browser = $derived(service.state);
  const snapshot = $derived($browser.snapshot);
  const selection = $derived(
    taskView
      ? planningTaskSelection(
          taskView.tasks,
          new Set(
            taskView.buckets.find((bucket) => bucket.id === selectedBucket)
              ?.taskRefs ?? [],
          ),
          $noteTasks,
          $browser.snapshot,
        )
      : null,
  );
  const displayedNoteTasks = $derived(selection?.notes ?? $noteTasks);
  const curatedNotePaths = $derived([
    ...new Set(displayedNoteTasks.map((task) => task.path)),
  ]);
  const bucketCounts = $derived(
    new Map(
      (taskView?.buckets ?? []).map((bucket) => [
        bucket.id,
        planningTaskSelection(
          taskView?.tasks ?? [],
          new Set(bucket.taskRefs),
          $noteTasks,
          snapshot,
        ).activeRefs.size,
      ]),
    ),
  );
  const source = $derived($viewPreferences.source ?? "todoist");
  const emptyImports = readable<Record<string, ImportedTaskSource>>({});
  const imports = $derived(scheduler?.importer.imports ?? emptyImports);
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- Older pane hosts can omit drop feedback.
  const pendingDrops = $derived(scheduler?.dropFeedback?.state ?? readable([]));
  const addedIds = $derived.by(() => {
    void $imports;
    const added = snapshot
      ? tasksAddedToNote({
          snapshot,
          path: $noteContext.targetPath,
          candidates: $noteTasks,
          imports: scheduler?.importer.sources() ?? $imports,
          resolve: resolveImported,
        })
      : new Set<string>();
    for (const drop of $pendingDrops) {
      const path =
        "path" in drop.destination
          ? drop.destination.path
          : "parent" in drop.destination
            ? drop.destination.parent.path
            : drop.targetPath;
      if (path === $noteContext.targetPath)
        for (const id of drop.taskIds) added.add(id);
    }
    return added;
  });
  const providerExclusions = $derived.by(() => {
    const excluded = new Set($viewPreferences.showAdded ? [] : addedIds);
    if (selection)
      for (const task of snapshot?.tasks ?? []) {
        if (!selection.providerIds.has(task.id)) excluded.add(task.id);
      }
    return excluded;
  });
  const grouping = $derived($viewPreferences.groupBy);
  const groups = $derived.by(() => {
    if (snapshot && source === "overview" && !taskView) {
      const now = DateTime.now().setZone(snapshot.account.timezone);
      const today = now.toISODate() ?? "";
      const buckets = [
        {
          id: "priority",
          label: "High priority",
          matches: (task: ProviderTask) => task.priority === 4,
        },
        {
          id: "today",
          label: "Overdue and today",
          matches: (task: ProviderTask) => {
            const due = taskDay(task, snapshot.account.timezone);
            return Boolean(due && due <= today);
          },
        },
      ];
      return buckets.flatMap((bucket) => {
        const excluded = new Set(
          snapshot.tasks
            .filter(
              (task) =>
                !bucket.matches(task) || providerExclusions.has(task.id),
            )
            .map((task) => task.id),
        );
        return taskGroups(snapshot, $viewPreferences, now, excluded).map(
          (group) => ({
            ...group,
            id: `${bucket.id}:${group.id}`,
            label: `${bucket.label} · ${group.label}`,
          }),
        );
      });
    }
    return snapshot
      ? taskGroups(snapshot, $viewPreferences, undefined, providerExclusions)
      : [];
  });
  function scanOtherNotes() {
    $viewPreferences = {
      ...$viewPreferences,
      scannedNotePaths: [
        ...new Set(noteTaskRows($noteTasks).map((row) => row.candidate.path)),
      ].sort(),
    };
  }
  const completeGroups = $derived(
    source === "overview"
      ? groups
      : snapshot
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
      $viewPreferences.collapsed,
    ),
  );
  const projects = $derived(
    new Map(snapshot?.projects.map((project) => [project.id, project.name])),
  );
  function toggle(id: string) {
    const collapsed = $viewPreferences.collapsed;
    $viewPreferences = {
      ...$viewPreferences,
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
    $viewPreferences = { ...$viewPreferences, selectedId: task.id };
    schedule(task);
  }
</script>

<section class="simple-tasks-pane dp-task-panel" aria-label="Tasks">
  <header class="task-toolbar">
    <div class="task-heading">
      <h2>Tasks</h2>
      <div class="task-toolbar-actions">
        {#if planning}<button
            class="task-text-button"
            onclick={() => planning.show()}>Plan</button
          >{/if}
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
    {#if taskView}
      <div class="curated-heading">
        <strong>Suggested task view</strong><button
          class="task-text-button"
          onclick={() => planning?.clearTaskView()}>Clear view</button
        >
      </div>
      <div class="curated-buckets" aria-label="Suggested task buckets">
        {#each taskView.buckets as bucket (bucket.id)}
          <button
            class="curated-bucket"
            aria-pressed={selectedBucket === bucket.id}
            onclick={() => (selectedBucket = bucket.id)}
            >{bucket.title}<span>{bucketCounts.get(bucket.id) ?? 0}</span
            ></button
          >
        {/each}
      </div>
    {/if}
    <div class="task-source-tabs" aria-label="Task sources" role="tablist">
      <button
        aria-selected={source === "overview"}
        onclick={() =>
          ($viewPreferences = { ...$viewPreferences, source: "overview" })}
        role="tab">{taskView ? "All sources" : "Overview"}</button
      >
      <button
        aria-selected={source === "todoist"}
        onclick={() =>
          ($viewPreferences = { ...$viewPreferences, source: "todoist" })}
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
        onclick={() =>
          ($viewPreferences = { ...$viewPreferences, source: "notes" })}
        role="tab"><FileText size={15} />Notes</button
      >
    </div>
    <label class="task-search"
      ><Search size={16} />
      <input
        aria-label="Search tasks"
        placeholder={source === "notes" ? "Search note tasks" : "Search tasks"}
        type="search"
        bind:value={$viewPreferences.query}
      />
      {#if $viewPreferences.query}<button
          class="task-icon-button"
          aria-label="Clear search"
          onclick={() => {
            $viewPreferences = { ...$viewPreferences, query: "" };
          }}><X size={14} /></button
        >{/if}
    </label>
    {#if source === "todoist"}<div class="task-filter-row">
        <div class="task-grouping" aria-label="Group tasks">
          <button
            aria-pressed={$viewPreferences.groupBy === "date"}
            onclick={() => {
              $viewPreferences = { ...$viewPreferences, groupBy: "date" };
            }}>Date</button
          >
          <button
            aria-pressed={$viewPreferences.groupBy === "project"}
            onclick={() => {
              $viewPreferences = { ...$viewPreferences, groupBy: "project" };
            }}>Project</button
          >
        </div>
        <label class="task-project-filter"
          ><select
            aria-label="Filter by project"
            bind:value={$viewPreferences.projectId}
          >
            <option value="">All projects</option>
            {#each snapshot?.projects ?? [] as project (project.id)}<option
                value={project.id}>{project.name}</option
              >{/each}
          </select><ChevronDown size={13} /></label
        >
      </div>{/if}
    {#if source === "todoist" && $viewPreferences.groupBy === "project"}<label
        >Sort
        <select
          aria-label="Sort project tasks"
          onchange={(event: Event & { currentTarget: HTMLSelectElement }) =>
            ($viewPreferences = {
              ...$viewPreferences,
              sortBy: event.currentTarget.value as TaskViewState["sortBy"],
            })}
          value={$viewPreferences.sortBy ?? "defined"}
        >
          <option value="defined">Defined order</option><option value="priority"
            >Priority</option
          ><option value="due">Due date</option><option value="created"
            >Date added</option
          >
        </select></label
      >{/if}
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
        aria-pressed={Boolean($viewPreferences.showAdded)}
        onclick={() =>
          ($viewPreferences = {
            ...$viewPreferences,
            showAdded: !$viewPreferences.showAdded,
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
      {#if source === "overview"}<NoteTasksSection
          candidates={displayedNoteTasks}
          currentPath={$noteContext.currentPath}
          matchingKeys={selection?.noteKeys}
          {noteDrag}
          {openNote}
          query={$viewPreferences.query}
          remove={() => {}}
          scan={scanOtherNotes}
          scannedPaths={taskView ? curatedNotePaths : []}
          showAdded={Boolean($viewPreferences.showAdded)}
        />{/if}
      {#if source === "notes"}<NoteTasksSection
          candidates={displayedNoteTasks}
          currentPath={$noteContext.currentPath}
          matchingKeys={selection?.noteKeys}
          {noteDrag}
          {openNote}
          query={$viewPreferences.query}
          remove={(path) =>
            ($viewPreferences = {
              ...$viewPreferences,
              scannedNotePaths: (
                $viewPreferences.scannedNotePaths ?? []
              ).filter((item) => item !== path),
            })}
          scan={scanOtherNotes}
          scannedPaths={taskView
            ? curatedNotePaths
            : ($viewPreferences.scannedNotePaths ?? [])}
          showAdded={Boolean($viewPreferences.showAdded)}
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
              {!$viewPreferences.showAdded && addedIds.size
                ? "All matching tasks have been added to this note"
                : $viewPreferences.query || $viewPreferences.projectId
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
                  aria-expanded={!$viewPreferences.collapsed.includes(group.id)}
                  onclick={() => toggle(group.id)}
                >
                  {#if $viewPreferences.collapsed.includes(group.id)}<ChevronRight
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
                  class:task-selected={$viewPreferences.selectedId ===
                    row.task.id}
                  aria-label={row.task.title}
                  draggable={$browser.connected && !!scheduler}
                  hidden={renderedRow.hidden}
                  ondragend={() => scheduler?.drag.cancel()}
                  ondragstart={(event) => drag(event, row.task)}
                  role="group"
                >
                  {#if row.hasChildren}<button
                      class="task-tree-toggle task-icon-button"
                      aria-expanded={!$viewPreferences.collapsed.includes(
                        `task:${renderedGroup.id}:${row.task.id}`,
                      )}
                      aria-label={`Subtasks of ${row.task.title}`}
                      onclick={() =>
                        toggle(`task:${renderedGroup.id}:${row.task.id}`)}
                    >
                      {#if $viewPreferences.collapsed.includes(`task:${renderedGroup.id}:${row.task.id}`)}<ChevronRight
                          size={13}
                        />{:else}<ChevronDown size={13} />{/if}
                    </button>{/if}
                  <button
                    class="task-import-circle"
                    aria-checked="false"
                    aria-label={`Complete ${row.task.title}`}
                    disabled={!$browser.connected ||
                      !completeTask ||
                      !weakCompletionEnabled}
                    onclick={() => completeTask?.(row.task)}
                    role="checkbox"
                    title="Complete task"
                  ></button>
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

<style>
  .curated-heading {
    display: flex;
    gap: 8px;
    align-items: center;
    justify-content: space-between;

    margin: 10px 0 6px;
  }

  .curated-heading strong {
    font-size: 12px;
    color: var(--tp-muted);
  }

  .curated-buckets {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-bottom: 10px;
  }

  .curated-bucket {
    display: inline-flex;
    gap: 7px;
    align-items: center;

    padding: 6px 9px;

    font-size: 12px;
    color: var(--tp-text);

    background: var(--tp-surface);
    border: 1px solid var(--tp-line);
    border-radius: 7px;
  }

  .curated-bucket[aria-pressed="true"] {
    background: var(--tp-hover);
    border-color: var(--tp-accent);
  }

  .curated-bucket span {
    font-size: 11px;
    color: var(--tp-muted);
  }
</style>
