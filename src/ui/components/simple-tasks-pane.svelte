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
    ExternalLink,
    X,
  } from "lucide-svelte";
  import { DateTime } from "luxon";
  import { Notice } from "obsidian";
  import { untrack } from "svelte";
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
  import {
    taskDay,
    taskGroups,
    switchTaskSource,
    type TaskViewState,
  } from "../../tasks/browser";
  import type { CaptureCandidate } from "../../tasks/capture-parser";
  import { githubTaskView } from "../../tasks/github-view";
  import type { NoteTaskDrag } from "../../tasks/note-drag";
  import { noteTaskRows } from "../../tasks/note-list";
  import type { ImportedTaskSource } from "../../tasks/plain-import";
  import type { TaskScheduler } from "../../tasks/schedule";
  import type { TaskService } from "../../tasks/service";
  import type { TaskSource } from "../../tasks/source";
  import type { TaskSourceCollection } from "../../tasks/source-collection";
  import { canonicalSourceUrl } from "../../tasks/source-links";
  import { taskSourceOverview } from "../../tasks/source-overview";
  import {
    taskSourceKey,
    taskSourceReference,
  } from "../../tasks/source-references";
  import {
    taskSourceChoices,
    type TaskPaneSource,
  } from "../../tasks/source-settings";
  import type { TaskSourceReference } from "../../tasks/source-types";
  import type { TaskSnapshot } from "../../tasks/types";
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
    sources,
  }: {
    service: TaskService;
    scheduler?: TaskScheduler;
    preferences: Writable<TaskViewState>;
    noteTasks?: Readable<CaptureCandidate[]>;
    noteDrag?: NoteTaskDrag;
    noteContext?: Readable<{ currentPath: string; targetPath: string }>;
    resolveImported?: (uid: string) => TaskSource | undefined;
    connections?: () => void;
    schedule: (task: ProviderTask, reference?: TaskSourceReference) => void;
    completeTask?: (task: ProviderTask) => void;
    weakCompletionEnabled?: boolean;
    openNote: (path: string, line: number) => void;
    planning?: AiPlanningService;
    sources?: TaskSourceCollection;
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
  const source = $derived($viewPreferences.source ?? "todoist");
  const providerView = $derived(!["notes", "overview"].includes(source));
  const sourceLabel = $derived(
    taskSourceChoices.find((choice) => choice.id === source)?.label ?? "tasks",
  );
  const browser = $derived(sources?.browser(source) ?? service.state);
  const sourceSettings = $derived(sources?.settings ?? readable(null));
  const sourceSession = $derived(sources?.session(source));
  const sourceStatus = $derived(sourceSession?.state ?? readable(null));
  const nativeSnapshots = $derived(
    sources?.snapshots ?? readable<TaskSnapshot[]>([]),
  );
  const overview = $derived(taskSourceOverview($nativeSnapshots));
  const snapshot = $derived(
    source === "github" && $browser.snapshot
      ? githubTaskView($browser.snapshot, {
          kind: $viewPreferences.githubView ?? "assigned",
          id: $viewPreferences.githubContainerId,
          statusOptionIds: $viewPreferences.githubStatusIds,
        })
      : $browser.snapshot,
  );
  $effect(() => {
    const selected = source;
    if (selected === "overview")
      untrack(() => {
        void sources?.refresh("google-tasks");
        void sources?.refresh("github");
      });
    if (selected === "google-tasks" || selected === "github")
      untrack(() => {
        void sources?.refresh(selected);
      });
  });
  const selection = $derived(
    taskView
      ? planningTaskSelection(
          taskView.tasks,
          new Set(
            taskView.buckets.find((bucket) => bucket.id === selectedBucket)
              ?.taskRefs ?? [],
          ),
          $noteTasks,
          sources ? $nativeSnapshots : $browser.snapshot,
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
          sources ? $nativeSnapshots : snapshot,
        ).activeRefs.size,
      ]),
    ),
  );
  const emptyImports = readable<Record<string, ImportedTaskSource>>({});
  const imports = $derived(scheduler?.importer.imports ?? emptyImports);
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- Older pane hosts can omit drop feedback.
  const pendingDrops = $derived(scheduler?.dropFeedback?.state ?? readable([]));
  const addedIds = $derived.by(() => {
    void $imports;
    const added = new Set<string>();
    for (const native of source === "overview" && sources
      ? $nativeSnapshots
      : snapshot
        ? [snapshot]
        : []) {
      const ids = tasksAddedToNote({
        snapshot: native,
        path: $noteContext.targetPath,
        candidates: $noteTasks,
        imports: scheduler?.importer.sources() ?? $imports,
        resolve: resolveImported,
      });
      for (const id of ids)
        added.add(
          source === "overview" && sources
            ? taskSourceKey({
                provider: native.provider,
                accountId: native.account.id,
                itemId: id,
              })
            : id,
        );
    }
    for (const drop of $pendingDrops) {
      if (
        !snapshot ||
        (source !== "overview" &&
          (drop.source
            ? drop.source.provider !== snapshot.provider ||
              drop.source.accountId !== snapshot.account.id
            : snapshot.provider !== "todoist"))
      )
        continue;
      const path =
        "path" in drop.destination
          ? drop.destination.path
          : "parent" in drop.destination
            ? drop.destination.parent.path
            : drop.targetPath;
      if (path === $noteContext.targetPath)
        for (const id of drop.taskIds) {
          const provider = drop.source?.provider ?? "todoist";
          const accountId =
            drop.source?.accountId ??
            $nativeSnapshots.find((item) => item.provider === "todoist")
              ?.account.id ??
            snapshot.account.id;
          added.add(
            source === "overview" && sources
              ? taskSourceKey({ provider, accountId, itemId: id })
              : id,
          );
        }
    }
    return added;
  });
  const providerExclusions = $derived.by(() => {
    const excluded = new Set($viewPreferences.showAdded ? [] : addedIds);
    if (selection)
      for (const task of snapshot?.tasks ?? []) {
        if (
          !(source === "overview" && sources
            ? selection.providerKeys.has(task.id)
            : selection.providerKeys.has(
                taskSourceKey({
                  provider: snapshot!.provider,
                  accountId: snapshot!.account.id,
                  itemId: task.id,
                }),
              ))
        )
          excluded.add(task.id);
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
      scheduler.drag.start(
        nativeTask(task),
        event.dataTransfer,
        externalReference(task),
      );
    } catch (error) {
      event.preventDefault();
      new Notice(
        error instanceof Error ? error.message : "Could not drag this task.",
      );
    }
  }
  function choose(task: ProviderTask) {
    $viewPreferences = { ...$viewPreferences, selectedId: task.id };
    const ref = externalReference(task);
    if (ref) schedule(nativeTask(task), ref);
    else schedule(nativeTask(task));
  }
  function externalReference(task: ProviderTask) {
    if (source === "overview" && sources)
      return overview.origins.get(task.id)?.reference;
    return sources &&
      snapshot &&
      (source === "google-tasks" || source === "github")
      ? taskSourceReference(snapshot, task)
      : undefined;
  }
  function nativeTask(task: ProviderTask) {
    return source === "overview" && sources
      ? (overview.origins.get(task.id)?.task ?? task)
      : task;
  }
  function taskProvider(task: ProviderTask) {
    return externalReference(task)?.provider ?? "todoist";
  }
  function chooseSource(next: TaskPaneSource) {
    scheduler?.drag.cancel();
    $viewPreferences = switchTaskSource($viewPreferences, next);
  }
  function complete(task: ProviderTask) {
    const ref = externalReference(task);
    if (ref && ref.provider !== "todoist" && sources)
      void sources
        .complete(ref)
        .catch(
          (error: unknown) =>
            new Notice(
              error instanceof Error
                ? error.message
                : "Could not complete this task.",
            ),
        );
    else completeTask?.(nativeTask(task));
  }
  function completionEnabled(task: ProviderTask) {
    return taskProvider(task) === "google-tasks"
      ? !get(sources?.googleBrowser ?? browser).loading &&
          Boolean(
            (source === "overview"
              ? overview.origins.get(task.id)?.snapshot
              : snapshot
            )?.account.capabilities?.complete &&
              $sourceSettings?.taskSources.googleTasks.allowCompletion,
          )
      : taskProvider(task) !== "github" &&
          Boolean(completeTask && weakCompletionEnabled);
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
        {#if providerView}
          <button
            class="task-icon-button"
            aria-label="Refresh tasks"
            disabled={$browser.loading ||
              !$browser.connected ||
              ($browser.retryAt ?? 0) > Date.now()}
            onclick={() =>
              sources?.refresh(source, true) ?? service.refresh(true)}
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
    {#if sources}<label class="source-picker"
        >Source<select
          aria-label="Task source"
          onchange={(event: Event & { currentTarget: HTMLSelectElement }) =>
            chooseSource(event.currentTarget.value as TaskPaneSource)}
          value={source}
        >
          {#each taskSourceChoices as choice}<option value={choice.id}
              >{choice.label}</option
            >{/each}
        </select></label
      >{:else}<div
        class="task-source-tabs"
        aria-label="Task sources"
        role="tablist"
      >
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
      </div>{/if}
    {#if source === "github"}
      <div class="task-filter-row">
        <label
          >View<select
            aria-label="GitHub view"
            onchange={(event: Event & { currentTarget: HTMLSelectElement }) => {
              $viewPreferences = {
                ...$viewPreferences,
                githubView: event.currentTarget.value as
                  | "assigned"
                  | "repository"
                  | "project",
                githubContainerId: "",
                projectId: "",
                githubStatusIds: [],
              };
            }}
            value={$viewPreferences.githubView ?? "assigned"}
            ><option value="assigned">Assigned to me</option><option
              value="repository">Repositories</option
            ><option value="project">Projects</option></select
          ></label
        >
        {#if $viewPreferences.githubView === "repository"}<label
            >Repository<select
              aria-label="GitHub repository"
              onchange={(event) => {
                $viewPreferences = {
                  ...$viewPreferences,
                  githubContainerId: event.currentTarget.value,
                  projectId: "",
                };
              }}
              value={$viewPreferences.githubContainerId ?? ""}
              ><option value="">Choose repository</option
              >{#each $sourceSettings?.taskSources.github.repositories ?? [] as repo}<option
                  value={repo}>{repo}</option
                >{/each}</select
            ></label
          >
        {:else if $viewPreferences.githubView === "project"}<label
            >Project<select
              aria-label="GitHub Project"
              onchange={(event) => {
                $viewPreferences = {
                  ...$viewPreferences,
                  githubContainerId: event.currentTarget.value,
                  projectId: "",
                  githubStatusIds: [],
                };
              }}
              value={$viewPreferences.githubContainerId ?? ""}
              ><option value="">Choose Project</option
              >{#each $sourceSettings?.taskSources.github.projects ?? [] as project}<option
                  value={project.id}>{project.title}</option
                >{/each}</select
            ></label
          >{/if}
      </div>
      {#if $viewPreferences.githubView === "project" && $viewPreferences.githubContainerId}
        {@const project = $sourceSettings?.taskSources.github.projects.find(
          (item) => item.id === $viewPreferences.githubContainerId,
        )}
        {@const status = snapshot?.projects
          .find((item) => item.id === project?.id)
          ?.source?.fields?.find(
            (field) => field.id === project?.statusFieldId,
          )}
        {#if status}<label
            >Status<select
              aria-label="GitHub Project status"
              onchange={(event) => {
                $viewPreferences = {
                  ...$viewPreferences,
                  githubStatusIds: event.currentTarget.value
                    ? [event.currentTarget.value]
                    : [],
                };
              }}
              value={$viewPreferences.githubStatusIds?.[0] ?? ""}
              ><option value="">All statuses</option
              >{#each status.options ?? [] as option}<option value={option.id}
                  >{option.name}</option
                >{/each}</select
            ></label
          >{/if}
      {/if}
    {/if}
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
    {#if providerView}<div class="task-filter-row">
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
        {#if source !== "github"}<label class="task-project-filter"
            ><select
              aria-label="Filter by project"
              bind:value={$viewPreferences.projectId}
            >
              <option value=""
                >{source === "google-tasks"
                  ? "All lists"
                  : "All projects"}</option
              >
              {#each snapshot?.projects ?? [] as project (project.id)}<option
                  value={project.id}>{project.name}</option
                >{/each}
            </select><ChevronDown size={13} /></label
          >{/if}
      </div>{/if}
    {#if providerView && $viewPreferences.groupBy === "project"}<label
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
          <option value="defined">Defined order</option
          >{#if source === "todoist"}<option value="priority">Priority</option
            >{/if}<option value="due"
            >{source === "google-tasks"
              ? "Scheduled date"
              : source === "github"
                ? "Target date"
                : "Due date"}</option
          >{#if source !== "google-tasks"}<option value="created"
              >Date added</option
            >{/if}
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
  {#if (providerView || source === "overview") && $browser.error}<div
      class="task-review task-connection-error"
      role="status"
    >
      <AlertCircle size={16} />
      <p>{$browser.error}</p>
      <button class="task-text-button" onclick={connections}>Connections</button
      >
    </div>{/if}
  {#if providerView && $sourceStatus?.coverage && (!$sourceStatus.coverage.complete || $sourceStatus.coverage.unavailableItems)}<div
      class="task-review"
      role="status"
    >
      <p>
        {#if !$sourceStatus.coverage.complete}Showing cached and available
          tasks. {$sourceStatus.coverage.streams.find((stream) => stream.error)
            ?.error ?? "More tasks are available."}{/if}
        {#if $sourceStatus.coverage.unavailableItems}{$sourceStatus.coverage
            .unavailableItems} items are unavailable or excluded by your access settings.{/if}
      </p>
      {#if $sourceStatus.coverage.streams.some((stream) => !stream.complete && !stream.error)}<button
          disabled={$browser.loading}
          onclick={() => sources?.refresh(source, true, true)}>Load more</button
        >{/if}
    </div>{/if}
  {#if $sourceStatus?.verificationRequired.length}<div
      class="task-review"
      role="status"
    >
      <p>Check task completion</p>
      {#each $sourceStatus.verificationRequired as itemId}<button
          onclick={() =>
            sourceSession?.verify({
              provider: source,
              accountId: $sourceStatus.snapshot?.account.id ?? "",
              itemId,
            })}
          >Verify {snapshot?.tasks.find((item) => item.id === itemId)?.title ??
            "task"}</button
        >{/each}
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
              >{sources
                ? `Connect ${sourceLabel}`
                : "Sign in with Todoist"}</button
            >
          </div>{/if}
        {#if snapshot && !groups.length}<div class="task-empty">
            <Search size={25} />
            <p>
              {!$viewPreferences.showAdded && addedIds.size
                ? "All matching tasks have been added to this note"
                : $viewPreferences.query || $viewPreferences.projectId
                  ? `No matching ${sourceLabel} tasks`
                  : `No active ${sourceLabel} tasks`}
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
                      !completionEnabled(row.task)}
                    onclick={() => complete(row.task)}
                    role="checkbox"
                    title={taskProvider(row.task) === "github"
                      ? "Open in GitHub to change its state"
                      : "Complete task"}
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
                      {#if source === "overview" && sources}<span
                          class="task-label-chip"
                          >{taskSourceChoices.find(
                            (choice) => choice.id === taskProvider(row.task),
                          )?.label ?? taskProvider(row.task)}</span
                        >{/if}
                      {#if row.task.source?.kind && row.task.source.kind !== "task"}<span
                          class="task-label-chip"
                          >{row.task.source.kind}{row.task.source.number
                            ? ` #${row.task.source.number}`
                            : ""}</span
                        >{/if}
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
                  <div class="task-row-actions">
                    {#if canonicalSourceUrl(row.task.source?.url ?? "")}<a
                        class="task-icon-button"
                        aria-label={`Open ${row.task.title} in ${sourceLabel}`}
                        href={canonicalSourceUrl(row.task.source?.url ?? "")}
                        rel="noopener noreferrer"
                        target="_blank"
                        title={`Open in ${sourceLabel}`}
                        ><ExternalLink size={14} /></a
                      >{/if}
                    <button
                      class="task-icon-button task-row-schedule"
                      aria-label={`Schedule ${row.task.title}`}
                      onclick={() => choose(row.task)}
                      title="Add to schedule"
                      ><CalendarClock size={16} /></button
                    >
                  </div>
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
