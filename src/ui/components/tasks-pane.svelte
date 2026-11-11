<script lang="ts">
  import {
    ChevronDown,
    ChevronRight,
    ExternalLink,
    Plus,
    RefreshCw,
    Search,
    X,
  } from "lucide-svelte";
  import { readable, type Readable, type Writable } from "svelte/store";

  import { taskDay, taskGroups, type TaskViewState } from "../../tasks/browser";
  import type { TaskCapture, CaptureIssue } from "../../tasks/capture";
  import { operationTaskId } from "../../tasks/operations";
  import type { TaskScheduler } from "../../tasks/schedule";
  import type {
    ScheduleOperation,
    TaskProjection,
  } from "../../tasks/schedule-types";
  import type { TaskBrowserState, TaskService } from "../../tasks/service";
  import type { ProviderTask } from "../../tasks/types";

  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- Svelte validates these annotated props. ESLint's rune declaration returns any.
  let {
    service,
    preferences,
    connect,
    createTask,
    editTask,
    addSubtask,
    completeTask,
    reopenTask,
    retry,
    capture,
    captureSettings,
    routeCapture,
    scheduler,
    scheduleTask,
    revealTask,
    unscheduleTask,
    retrySchedule,
    taskMenu,
  }: {
    service: TaskService;
    preferences: Writable<TaskViewState>;
    connect: () => void;
    createTask: () => void;
    editTask: (task: ProviderTask) => void;
    addSubtask: (task: ProviderTask) => void;
    completeTask: (task: ProviderTask) => void;
    reopenTask: (task: ProviderTask) => void;
    retry: (id: string) => void;
    capture: TaskCapture;
    captureSettings: () => void;
    routeCapture: (issue: CaptureIssue) => void;
    scheduler?: TaskScheduler;
    scheduleTask: (task: ProviderTask) => void;
    revealTask: (task: ProviderTask) => void;
    unscheduleTask: (task: ProviderTask) => void;
    retrySchedule: (id: string) => void;
    taskMenu: (task: ProviderTask, position: { x: number; y: number }) => void;
  } = $props();
  const browserState: Readable<TaskBrowserState> = $derived(service.state);
  const captureState = $derived(capture.state);
  const emptySchedule = readable({
    operations: [] as ScheduleOperation[],
    projections: [] as TaskProjection[],
    error: "",
  });
  const scheduleState = $derived(scheduler?.state ?? emptySchedule);
  const selectedProjection = $derived(
    $scheduleState.projections.find(
      (projection) => projection.taskId === selected?.id,
    ),
  );
  function scheduleLabel(projection: TaskProjection) {
    return projection.interval
      ? new Date(projection.interval.start).toLocaleString([], {
          month: "short",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        })
      : "Linked note";
  }
  const groups = $derived(
    $browserState.snapshot
      ? taskGroups($browserState.snapshot, $preferences)
      : [],
  );
  const selected: ProviderTask | undefined = $derived(
    $browserState.snapshot?.tasks.find(
      (task) => task.id === $preferences.selectedId,
    ),
  );
  const pendingIds = $derived(
    new Set($browserState.operations.map(operationTaskId)),
  );
  $effect(() => {
    const selectedId = $preferences.selectedId;
    const alias = selectedId ? $browserState.aliases[selectedId] : undefined;
    if (alias) $preferences = { ...$preferences, selectedId: alias };
  });
  function toggleGroup(id: string) {
    const collapsed = new Set($preferences.collapsed);
    if (collapsed.has(id)) collapsed.delete(id);
    else collapsed.add(id);
    $preferences = { ...$preferences, collapsed: [...collapsed] };
  }
</script>

<section class="task-pane" aria-label="Tasks">
  <header>
    <h2>Tasks</h2>
    <div class="task-source">
      <span>Todoist</span>
      {#if $browserState.writable}<button
          aria-label="New task"
          onclick={createTask}
          title="New task"><Plus size={17} /></button
        >{/if}
      <button
        aria-label="Refresh tasks"
        disabled={!$browserState.connected ||
          $browserState.loading ||
          ($browserState.retryAt ?? 0) > Date.now()}
        onclick={() => {
          void service.refresh();
        }}
        title="Refresh tasks"><RefreshCw size={17} /></button
      >
      <button onclick={connect}
        >{$browserState.connected ? "Connection" : "Connect"}</button
      >
    </div>
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
    <label class="task-search"
      ><Search size={16} /><input
        aria-label="Search tasks"
        placeholder="Search tasks"
        type="search"
        bind:value={$preferences.query}
      /></label
    >
    {#if $browserState.snapshot}
      <select
        aria-label="Filter by project"
        bind:value={$preferences.projectId}
      >
        <option value="">All projects</option>
        {#each $browserState.snapshot.projects as project (project.id)}<option
            value={project.id}>{project.name}</option
          >{/each}
      </select>
    {/if}
  </header>
  {#if $captureState.error}<p role="status">{$captureState.error}</p>{/if}
  {#if $captureState.issues.length}
    <details class="task-changes" open>
      <summary
        >{$captureState.issues.length} capture {$captureState.issues.length ===
        1
          ? "needs"
          : "need"} review</summary
      >
      {#each $captureState.issues as issue (`${issue.candidate.path}:${issue.candidate.from}`)}
        <div class="task-change">
          <span>{issue.candidate.title}</span><small>{issue.message}</small>
          <button onclick={() => routeCapture(issue)}>Choose project</button>
        </div>
      {/each}
    </details>
  {/if}
  <div class="task-status" aria-live="polite" role="status">
    {#if $browserState.loading}Refreshing tasks…
    {:else if $browserState.error}<span>{$browserState.error}</span>
      {#if $browserState.needsReconnect || !$browserState.connected}
        <button onclick={connect}>Reconnect</button>
      {:else}
        <button
          disabled={($browserState.retryAt ?? 0) > Date.now()}
          onclick={() => {
            void service.refresh();
          }}>Retry</button
        >
      {/if}
    {:else if !$browserState.connected && $browserState.snapshot}<span
        >Cached tasks · Disconnected</span
      >
    {:else if $browserState.snapshot}<span
        >{$browserState.snapshot.account.name} · Updated {new Date(
          $browserState.snapshot.fetchedAt,
        ).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span
      >{/if}
  </div>
  {#if $browserState.operations.length}
    <details class="task-changes">
      <summary
        >{$browserState.operations.length} saved {$browserState.operations
          .length === 1
          ? "change"
          : "changes"}</summary
      >
      {#each $browserState.operations as operation (operation.id)}
        <div class="task-change">
          <span
            >{operation.mutation.kind === "create"
              ? operation.mutation.task.title
              : (operation.base?.title ?? "Task change")}</span
          >
          <small>{operation.error ?? "Pending sync"}</small>
          {#if operation.status !== "conflict"}<button
              onclick={() => retry(operation.id)}>Retry</button
            >{/if}
        </div>
      {/each}
    </details>
  {/if}
  {#if $scheduleState.error}<p role="status">{$scheduleState.error}</p>{/if}
  {#if $scheduleState.operations.length}<details class="task-changes" open>
      <summary
        >{$scheduleState.operations.length} saved schedule {$scheduleState
          .operations.length === 1
          ? "change"
          : "changes"}</summary
      >
      {#each $scheduleState.operations as operation (operation.id)}<div
          class="task-change"
        >
          <span>{operation.task.title}</span><small
            >{operation.error ??
              (operation.phase === "calendar-pending"
                ? "Google Calendar pending"
                : "Saving schedule…")}</small
          >{#if operation.phase !== "conflict"}<button
              onclick={() => retrySchedule(operation.id)}>Retry</button
            >{/if}
        </div>{/each}
    </details>{/if}
  {#if !$browserState.snapshot}
    <div class="task-empty">
      <h3>Connect Todoist</h3>
      <p>Browse your tasks alongside your schedule.</p>
      <button class="mod-cta" onclick={connect}>Connect Todoist</button>
    </div>
  {:else if !groups.length}
    <div class="task-empty">
      <p>
        {$preferences.query || $preferences.projectId
          ? "No tasks match your filters."
          : "No active tasks."}
      </p>
      {#if $preferences.query || $preferences.projectId}<button
          onclick={() => {
            $preferences = { ...$preferences, query: "", projectId: "" };
          }}>Clear filters</button
        >{/if}
    </div>
  {:else}
    <div class="task-groups">
      {#each groups as group (group.id)}
        <section class="task-group" aria-label={group.label}>
          <button
            class="task-group-heading"
            aria-expanded={!$preferences.collapsed.includes(group.id)}
            onclick={() => toggleGroup(group.id)}
          >
            {#if $preferences.collapsed.includes(group.id)}<ChevronRight
                size={16}
              />{:else}<ChevronDown size={16} />{/if}
            <strong>{group.label}</strong><span>{group.count}</span>
          </button>
          {#if !$preferences.collapsed.includes(group.id)}
            {#each group.rows as row (row.task.id)}
              {@const projection = $scheduleState.projections.find(
                (item) => item.taskId === row.task.id,
              )}
              <div
                style:--task-depth={Math.min(row.depth, 6)}
                class="task-row-container"
              >
                {#if row.hasChildren}
                  <button
                    class="task-tree-toggle"
                    aria-expanded={!$preferences.collapsed.includes(
                      `task:${group.id}:${row.task.id}`,
                    )}
                    aria-label={`Toggle subtasks for ${row.task.title}`}
                    onclick={() =>
                      toggleGroup(`task:${group.id}:${row.task.id}`)}
                  >
                    {#if $preferences.collapsed.includes(`task:${group.id}:${row.task.id}`)}<ChevronRight
                        size={14}
                      />{:else}<ChevronDown size={14} />{/if}
                  </button>
                {/if}
                <input
                  class="task-checkbox"
                  aria-label={`Complete ${row.task.title}`}
                  checked={row.task.completed}
                  disabled={!$browserState.writable ||
                    pendingIds.has(row.task.id) ||
                    row.task.id.startsWith("local-")}
                  onchange={() => completeTask(row.task)}
                  type="checkbox"
                />
                <div class="task-row-content">
                  <button
                    class="task-row"
                    class:task-context={row.context}
                    class:task-selected={selected?.id === row.task.id}
                    draggable={!!scheduler &&
                      $browserState.writable &&
                      !pendingIds.has(row.task.id)}
                    onclick={() => {
                      $preferences = {
                        ...$preferences,
                        selectedId: row.task.id,
                      };
                    }}
                    oncontextmenu={(event) => {
                      event.preventDefault();
                      taskMenu(row.task, {
                        x: event.clientX,
                        y: event.clientY,
                      });
                    }}
                    ondragend={() => scheduler?.drag.cancel()}
                    ondragstart={(event) => {
                      if (scheduler && event.dataTransfer)
                        scheduler.drag.start(row.task, event.dataTransfer);
                    }}
                    onkeydown={(event) => {
                      if (
                        event.key === "ContextMenu" ||
                        (event.shiftKey && event.key === "F10")
                      ) {
                        event.preventDefault();
                        const rect =
                          event.currentTarget.getBoundingClientRect();
                        taskMenu(row.task, { x: rect.left, y: rect.bottom });
                      }
                    }}
                  >
                    <span class="task-copy"
                      ><span>{row.task.title || "Untitled task"}</span><small
                        >{$browserState.snapshot?.projects.find(
                          (project) => project.id === row.task.projectId,
                        )?.name ?? "Unavailable project"}</small
                      ></span
                    >
                    {#if row.task.due && !projection?.interval}<small
                        class="task-date"
                        >{taskDay(
                          row.task,
                          $browserState.snapshot?.account.timezone ?? "UTC",
                        )}</small
                      >{/if}
                    {#if pendingIds.has(row.task.id)}<small class="task-pending"
                        >Pending</small
                      >{/if}
                  </button>
                  {#if projection?.interval}<button
                      class="task-schedule-chip"
                      onclick={() => revealTask(row.task)}
                      title="Open schedule">{scheduleLabel(projection)}</button
                    >{/if}
                </div>
              </div>
            {/each}
          {/if}
        </section>
      {/each}
    </div>
  {/if}
  {#if $browserState.completed.length}
    <details class="task-completed">
      <summary>Completed {$browserState.completed.length}</summary>
      {#each $browserState.completed as task (task.id)}<div
          class="task-completed-row"
        >
          <span>{task.title}</span><button
            disabled={!$browserState.writable}
            onclick={() => reopenTask(task)}>Reopen</button
          >
        </div>{/each}
    </details>
  {/if}
  {#if selected}
    <section class="task-details" aria-label="Task details">
      <div class="task-detail-heading">
        <h3>{selected.title}</h3>
        <button
          aria-label="Close task details"
          onclick={() => {
            $preferences = { ...$preferences, selectedId: null };
          }}><X size={17} /></button
        >
      </div>
      {#if $browserState.writable && !pendingIds.has(selected.id) && !selected.id.startsWith("local-")}
        <div class="task-actions">
          <button onclick={() => editTask(selected)}>Edit task</button><button
            onclick={() => addSubtask(selected)}>Add subtask</button
          >
          {#if scheduler}<button onclick={() => scheduleTask(selected)}
              >{selectedProjection?.interval
                ? "Move schedule"
                : "Schedule"}</button
            >{/if}
          {#if selectedProjection?.interval}<button
              onclick={() => unscheduleTask(selected)}
              >Remove from schedule</button
            >{/if}
        </div>
      {/if}
      <dl>
        {#if selectedProjection}<dt>
            {selectedProjection.interval ? "Scheduled" : "Note"}
          </dt>
          <dd>
            <button onclick={() => revealTask(selected)}
              >{scheduleLabel(selectedProjection)}</button
            >
          </dd>{/if}
        <dt>Project</dt>
        <dd>
          {$browserState.snapshot?.projects.find(
            (project) => project.id === selected.projectId,
          )?.name ?? "Unavailable project"}
        </dd>
        <dt>Date</dt>
        <dd>{selected.due?.text || selected.due?.date || "No date"}</dd>
        {#if selected.duration}<dt>Duration</dt>
          <dd>
            {selected.duration.amount}
            {selected.duration.unit === "minute" ? "min" : "days"}
          </dd>{/if}
        {#if selected.due?.recurring}<dt>Repeats</dt>
          <dd>{selected.due.text}</dd>{/if}
        {#if selected.labels.length}<dt>Labels</dt>
          <dd>{selected.labels.join(", ")}</dd>{/if}
      </dl>
      {#if selected.description}<p class="task-description">
          {selected.description}
        </p>{/if}
      {#if $browserState.snapshot?.provider === "todoist"}<a
          href={`https://app.todoist.com/app/task/${encodeURIComponent(selected.id)}`}
          rel="noopener noreferrer"
          target="_blank"><ExternalLink size={14} /> Open in Todoist</a
        >{/if}
    </section>
  {/if}
  {#if $browserState.connected}<footer>
      <button onclick={captureSettings}>Capture and routing</button>
      <button onclick={() => service.disconnect()}>Disconnect Todoist</button>
    </footer>{/if}
</section>

<style>
  .task-schedule-chip {
    max-width: 100%;
    height: auto;
    font-size: var(--font-ui-smaller);
    white-space: normal;
  }

  .task-pane {
    display: flex;
    flex-direction: column;

    min-width: 0;
    height: 100%;

    font-family: var(--font-interface, "Inter"), system-ui, sans-serif;
    color: var(--text-normal);
  }

  header {
    display: grid;
    gap: var(--size-4-3);
    padding: var(--size-4-4);
    border-bottom: 1px solid var(--background-modifier-border);
  }

  h2,
  h3,
  p {
    margin: 0;
  }

  h2 {
    font-size: var(--font-ui-large);
  }

  button {
    cursor: pointer;
    font-family: inherit;
  }

  input,
  select {
    font-family: inherit;
  }

  .task-row-container {
    display: flex;
    flex-wrap: wrap;
    align-items: start;
    padding-inline-start: calc(var(--task-depth) * 14px);
  }

  .task-row-content {
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: var(--size-2-1);

    min-width: 0;
  }

  .task-row-content .task-schedule-chip {
    align-self: start;
    margin-inline-start: var(--size-4-2);
  }

  .task-tree-toggle {
    flex-shrink: 0;

    margin-top: var(--size-4-3);
    padding: var(--size-2-1);

    background: transparent;
    box-shadow: none;
  }

  .task-source,
  .task-grouping,
  .task-search,
  .task-detail-heading {
    display: flex;
    gap: var(--size-4-2);
    align-items: center;
  }

  .task-source span {
    flex: 1;
  }

  .task-grouping button[aria-pressed="true"] {
    background: var(--background-modifier-hover);
  }

  .task-search input {
    width: 100%;
    min-width: 0;
  }

  .task-status {
    padding: var(--size-4-2) var(--size-4-4);
    font-size: var(--font-ui-smaller);
    color: var(--text-muted);
  }

  .task-status:empty {
    display: none;
  }

  .task-status button {
    margin-top: var(--size-4-2);
  }

  .task-empty {
    display: grid;
    gap: var(--size-4-4);
    justify-items: start;
    padding: var(--size-4-6);
  }

  .task-groups {
    overflow: auto;
    flex: 1;
    min-height: 100px;
  }

  .task-group {
    padding: var(--size-4-2);
    border-bottom: 1px solid var(--background-modifier-border);
  }

  .task-group-heading {
    display: flex;
    gap: var(--size-4-2);
    align-items: center;

    width: 100%;

    text-align: start;

    background: transparent;
    box-shadow: none;
  }

  .task-group-heading span {
    color: var(--text-muted);
  }

  .task-row {
    display: flex;
    flex: none;
    flex-wrap: wrap;
    gap: var(--size-4-2);
    align-items: start;

    width: 100%;
    min-width: 0;
    height: auto;
    padding: var(--size-4-3);

    text-align: start;
    white-space: normal;

    background: transparent;
    box-shadow: none;
  }

  .task-row > :global(svg) {
    flex-shrink: 0;
    margin-top: 3px;
    color: var(--text-muted);
  }

  .task-copy {
    display: grid;
    flex: 1;
    flex-basis: 100px;
    gap: var(--size-2-1);

    min-width: 0;

    overflow-wrap: anywhere;
  }

  .task-copy small,
  .task-date {
    font-size: var(--font-ui-smaller);
    color: var(--text-muted);
  }

  .task-date {
    flex-shrink: 0;
  }

  .task-row:hover,
  .task-selected {
    background: var(--background-modifier-hover);
  }

  .task-context .task-copy {
    color: var(--text-muted);
  }

  .task-details {
    overflow: auto;
    max-height: 45%;
    padding: var(--size-4-4);
    border-top: 1px solid var(--background-modifier-border);
  }

  .task-detail-heading h3 {
    flex: 1;
    font-size: var(--font-ui-medium);
    overflow-wrap: anywhere;
  }

  dl {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: var(--size-4-2) var(--size-4-4);
    font-size: var(--font-ui-small);
  }

  dt {
    color: var(--text-muted);
  }

  dd {
    margin: 0;
    overflow-wrap: anywhere;
  }

  .task-description {
    margin-block: var(--size-4-3);
    overflow-wrap: anywhere;
    white-space: pre-wrap;
  }

  a {
    display: inline-flex;
    gap: var(--size-4-2);
    align-items: center;
  }

  footer {
    padding: var(--size-4-2) var(--size-4-4);
  }

  .task-checkbox {
    flex-shrink: 0;
    margin-block-start: var(--size-4-3);
  }

  .task-changes,
  .task-completed {
    padding: var(--size-4-3) var(--size-4-4);
    font-size: var(--font-ui-small);
    border-bottom: 1px solid var(--background-modifier-border);
  }

  .task-change {
    display: grid;
    gap: var(--size-4-2);
    margin-block: var(--size-4-3);
  }

  .task-change small,
  .task-pending {
    color: var(--text-muted);
  }

  .task-completed-row,
  .task-actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--size-4-2);
    align-items: center;

    padding-block: var(--size-4-2);
  }

  .task-completed-row span {
    flex: 1;
    min-width: 0;
    text-decoration: line-through;
    overflow-wrap: anywhere;
  }
</style>
