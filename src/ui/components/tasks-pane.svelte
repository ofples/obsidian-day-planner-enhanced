<script lang="ts">
  import {
    AlertCircle,
    ArrowLeft,
    Calendar,
    CalendarClock,
    CalendarMinus,
    Check,
    ChevronDown,
    ChevronRight,
    Clock,
    ExternalLink,
    Flag,
    ListChecks,
    MoreHorizontal,
    Pencil,
    Plus,
    RefreshCw,
    Search,
    Settings,
    Tag,
    Unlink,
    Trash2,
    X,
  } from "lucide-svelte";
  import { DateTime } from "luxon";
  import { tick } from "svelte";
  import { readable, type Readable, type Writable } from "svelte/store";

  import type { GoogleCalendarSync } from "../../google-calendar/service";
  import type { DayPlannerSettings } from "../../settings";
  import {
    taskDay,
    taskGroups,
    taskSubtree,
    type TaskViewState,
  } from "../../tasks/browser";
  import type { TaskCapture } from "../../tasks/capture";
  import type {
    TaskDeletionController,
    TaskDeletionReview,
  } from "../../tasks/deletion";
  import type { TaskDeletionRecord } from "../../tasks/deletion-types";
  import { operationTaskId } from "../../tasks/operations";
  import type { TaskReconciler } from "../../tasks/reconcile";
  import type { TaskScheduler } from "../../tasks/schedule";
  import {
    scheduleBlocksTask,
    type ScheduleOperation,
    type TaskProjection,
  } from "../../tasks/schedule-types";
  import type { TaskBrowserState, TaskService } from "../../tasks/service";
  import type { ProviderTask } from "../../tasks/types";
  import type { TaskPanelAction } from "../task-panel-state";
  import "../task-panel.css";

  import TaskPanelCalendars from "./task-panel-calendars.svelte";
  import TaskPanelCaptureSettings from "./task-panel-capture-settings.svelte";
  import TaskPanelConflict from "./task-panel-conflict.svelte";
  import TaskPanelConnect from "./task-panel-connect.svelte";
  import TaskPanelDelete from "./task-panel-delete.svelte";
  import TaskPanelDeleted from "./task-panel-deleted.svelte";
  import TaskPanelEditor from "./task-panel-editor.svelte";
  import TaskPanelOccurrence from "./task-panel-occurrence.svelte";
  import TaskPanelRoute from "./task-panel-route.svelte";
  import TaskPanelSchedule from "./task-panel-schedule.svelte";

  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- Svelte validates annotated component props.
  let {
    service,
    capture,
    preferences,
    action,
    reconciler,
    scheduler,
    defaultDuration = 30,
    captureSettings,
    settings,
    calendar,
    deleter,
    openSavedNote,
    completeTask,
    reopenTask,
    retry,
    retrySchedule,
    revealTask,
  }: {
    service: TaskService;
    capture: TaskCapture;
    preferences: Writable<TaskViewState>;
    action: Writable<TaskPanelAction | null>;
    reconciler?: TaskReconciler;
    scheduler?: TaskScheduler;
    defaultDuration?: number;
    captureSettings: () => void;
    settings?: Writable<DayPlannerSettings>;
    calendar?: Pick<GoogleCalendarSync, "calendars">;
    deleter?: TaskDeletionController;
    openSavedNote?: (path: string) => void;
    completeTask: (task: ProviderTask) => void;
    reopenTask: (task: ProviderTask) => void;
    retry: (id: string) => void;
    retrySchedule: (id: string) => void;
    revealTask: (task: ProviderTask) => void;
  } = $props();
  const browserState: Readable<TaskBrowserState> = $derived(service.state);
  const occurrenceHistory = $derived(
    ($browserState.occurrences ?? [])
      .filter(
        (record) =>
          record.verifiedAt &&
          (!$preferences.projectId ||
            record.before.task.projectId === $preferences.projectId) &&
          !["cancelled", "undone"].includes(record.phase) &&
          record.before.task.title
            .toLowerCase()
            .includes($preferences.query.toLowerCase()),
      )
      .toReversed(),
  );
  const pendingOccurrences = $derived(
    ($browserState.occurrences ?? []).filter(
      (record) =>
        ["pending", "freezing"].includes(record.phase) ||
        (record.undo && !["complete", "cancelled"].includes(record.undo.phase)),
    ),
  );
  const selectedOccurrence = $derived.by(() => {
    const current = $action;
    return current?.kind === "occurrence"
      ? ($browserState.occurrences ?? []).find(
          (record) => record.id === current.id,
        )
      : undefined;
  });
  const captureState = $derived(capture.state);
  const deletionState = $derived(
    deleter?.state ??
      readable({ records: [] as TaskDeletionRecord[], error: "" }),
  );
  const pendingDeletions = $derived(
    $deletionState.records.filter(
      (item) => !["complete", "cancelled"].includes(item.phase),
    ),
  );
  const deletionHistory = $derived(
    $deletionState.records.filter(
      (item) =>
        ["complete", "cancelled"].includes(item.phase) &&
        item.tasks[0]!.title.toLowerCase().includes(
          $preferences.query.toLowerCase(),
        ),
    ),
  );
  const regularOperations = $derived(
    $browserState.operations.filter((item) => item.mutation.kind !== "delete"),
  );
  const reconcileState = $derived(
    reconciler?.state ?? readable({ issues: [], error: "" }),
  );
  const emptySchedule = readable({
    operations: [] as ScheduleOperation[],
    projections: [] as TaskProjection[],
    error: "",
  });
  const scheduleState = $derived(scheduler?.state ?? emptySchedule);
  const snapshot = $derived($browserState.snapshot);
  const groups = $derived(snapshot ? taskGroups(snapshot, $preferences) : []);
  const selected = $derived(
    snapshot?.tasks.find((task) => task.id === $preferences.selectedId),
  );
  const selectedProjection = $derived(
    $scheduleState.projections.find(
      (projection) => projection.taskId === selected?.id,
    ),
  );
  const children = $derived(
    selected && snapshot ? taskSubtree(snapshot, selected) : [],
  );
  const pendingIds = $derived(
    new Set([
      ...$browserState.operations.map(operationTaskId),
      ...pendingDeletions.flatMap((item) => item.tasks.map((task) => task.id)),
      ...pendingOccurrences.flatMap((record) =>
        [
          record.before.task,
          ...record.before.children,
          ...(record.undo?.children ?? []),
        ].map((task) => task.id),
      ),
    ]),
  );
  const attentionCount = $derived(
    new Set([
      ...$browserState.operations.map(operationTaskId),
      ...pendingDeletions.map((item) => item.taskId),
      ...pendingOccurrences.map((record) => record.before.task.id),
      ...$scheduleState.operations.map((operation) => operation.task.id),
      ...$reconcileState.issues.map((issue) => issue.taskId),
      ...$captureState.issues.map(
        (issue) => `${issue.candidate.path}:${issue.candidate.from}`,
      ),
    ]).size,
  );
  const syncError = $derived(
    $deletionState.error ||
      $browserState.error ||
      $captureState.error ||
      $reconcileState.error ||
      $scheduleState.error,
  );
  const needsReview = $derived(
    $reconcileState.issues.length > 0 ||
      pendingDeletions.some((item) => item.error) ||
      pendingOccurrences.some((item) => item.error || item.undo?.error) ||
      $captureState.issues.length > 0 ||
      $browserState.operations.some(
        (operation) =>
          operation.status === "conflict" || operation.status === "failed",
      ) ||
      $scheduleState.operations.some(
        (operation) =>
          operation.phase === "conflict" || Boolean(operation.error),
      ),
  );
  const workflow = $derived(!!$action && $action.kind !== "create");
  const canEditSelected = $derived(
    !!selected &&
      $browserState.writable &&
      !pendingIds.has(selected.id) &&
      !selected.id.startsWith("local-"),
  );
  const paneId = crypto.randomUUID();
  let showDetails = $state(false);
  let reviewOpen = $state(false);
  let menuLeft = $state(0);
  let menuTop = $state(0);
  let busy = $state(false);
  let restoringLink = $state(false);
  let actionError = $state("");
  let paneElement = $state<HTMLElement>();
  let actionOrigin: HTMLElement | undefined;
  let menuTrigger: HTMLElement | undefined;
  $effect(() => {
    const id = $preferences.selectedId;
    const alias = id ? $browserState.aliases[id] : undefined;
    if (alias) $preferences = { ...$preferences, selectedId: alias };
  });
  $effect(() => {
    if (!selected) showDetails = false;
  });
  $effect(() => {
    if ($action || showDetails) reviewOpen = false;
  });

  function toggleGroup(id: string) {
    const collapsed = new Set($preferences.collapsed);
    if (collapsed.has(id)) collapsed.delete(id);
    else collapsed.add(id);
    $preferences = { ...$preferences, collapsed: [...collapsed] };
  }
  function chooseTask(task: ProviderTask) {
    $preferences = { ...$preferences, selectedId: task.id };
    $action = null;
    showDetails = true;
  }
  function startAction(value: TaskPanelAction) {
    if (busy) return;
    if (
      $action?.kind === "unlink" &&
      $action.restoreTagOnCancel &&
      reconciler
    ) {
      void restoreLink($action, value);
      return;
    }
    openAction(value);
  }
  async function confirmTaskDeletion(review: TaskDeletionReview) {
    if (!deleter) throw new Error("Reopen Tasks before confirming deletion.");
    busy = true;
    try {
      return await deleter.confirm(review);
    } finally {
      busy = false;
    }
  }
  function reviewDeletion(id: string, taskId: string) {
    const task =
      snapshot?.tasks.find((item) => item.id === taskId) ??
      $deletionState.records.find((item) => item.id === id)?.tasks[0];
    if (task) startAction({ kind: "delete", task, replaces: id });
  }
  function openAction(value: TaskPanelAction) {
    const focused = paneElement?.ownerDocument.activeElement as
      | HTMLElement
      | undefined;
    actionOrigin = focused?.closest(".task-menu") ? menuTrigger : focused;
    actionError = "";
    $action = value;
    if (value.kind === "create") showDetails = false;
    for (const menu of Array.from(
      paneElement?.querySelectorAll<HTMLElement>(".task-menu") ?? [],
    ))
      menu.hidePopover();
    if (value.kind === "unschedule" || value.kind === "unlink")
      void tick().then(() => {
        if ($action === value)
          paneElement
            ?.querySelector<HTMLButtonElement>(
              ".task-action-area .task-primary",
            )
            ?.focus();
      });
  }
  function closeAction() {
    const origin = actionOrigin;
    actionOrigin = undefined;
    $action = null;
    actionError = "";
    void tick().then(() => {
      const fallback = showDetails
        ? paneElement?.querySelector<HTMLButtonElement>(
            ".task-detail-navigation button",
          )
        : (paneElement?.querySelector<HTMLButtonElement>(
            ".task-selected .task-row",
          ) ??
          paneElement?.querySelector<HTMLButtonElement>(".task-add-button"));
      const target =
        origin?.isConnected && origin.getClientRects().length
          ? origin
          : fallback;
      target?.focus();
    });
  }
  function finishAction(expected: TaskPanelAction, id?: string) {
    if ($action !== expected) return;
    if (id) $preferences = { ...$preferences, selectedId: id };
    closeAction();
  }
  function actionSaved(expected: TaskPanelAction) {
    return (id?: string) => finishAction(expected, id);
  }
  function cancelAction() {
    if (busy) return;
    if ($action?.kind === "unlink" && $action.restoreTagOnCancel && reconciler)
      void restoreLink($action);
    else closeAction();
  }
  async function restoreLink(
    opened: Extract<TaskPanelAction, { kind: "unlink" }>,
    next?: TaskPanelAction,
  ) {
    if (!reconciler) return;
    busy = true;
    restoringLink = true;
    actionError = "";
    try {
      await reconciler.keepLinked(opened.linkUid);
      if ($action !== opened) return;
      if (next) openAction(next);
      else closeAction();
    } catch (failure) {
      if ($action === opened)
        actionError =
          failure instanceof Error
            ? failure.message
            : "Could not restore the capture tag. Retry this decision.";
    } finally {
      busy = false;
      restoringLink = false;
    }
  }
  function projectName(task: ProviderTask) {
    return (
      snapshot?.projects.find((project) => project.id === task.projectId)
        ?.name ?? "Unavailable project"
    );
  }
  function scheduleLabel(projection: TaskProjection) {
    if (!projection.interval) return "Linked note";
    const start = DateTime.fromISO(projection.interval.start).toLocal();
    const end = DateTime.fromISO(projection.interval.end).toLocal();
    const day = start.hasSame(DateTime.now(), "day")
      ? "Today"
      : start.toFormat("d MMM");
    return `${day} · ${start.toFormat("HH:mm")}–${end.toFormat("HH:mm")}`;
  }
  function dateLabel(task: ProviderTask) {
    const zone = snapshot?.account.timezone ?? "UTC";
    const day = taskDay(task, zone);
    if (!day) return "No date";
    const today = DateTime.now().setZone(zone);
    if (day === today.toISODate()) return "Today";
    if (day === today.plus({ days: 1 }).toISODate()) return "Tomorrow";
    return DateTime.fromISO(day, { zone }).toFormat("d MMM");
  }
  function menuId(task: ProviderTask) {
    return `${paneId}-task-${task.id}`;
  }
  function positionMenu(event: MouseEvent | KeyboardEvent) {
    menuTrigger = event.currentTarget as HTMLElement;
    const rect = menuTrigger.getBoundingClientRect();
    const viewport = menuTrigger.ownerDocument.defaultView ?? window;
    menuLeft = Math.max(
      8,
      Math.min(rect.right - 210, viewport.innerWidth - 218),
    );
    menuTop = Math.max(
      8,
      Math.min(rect.bottom + 5, viewport.innerHeight - 156),
    );
  }
  function contextMenu(task: ProviderTask, event: MouseEvent | KeyboardEvent) {
    event.preventDefault();
    positionMenu(event);
    const menu = menuTrigger?.ownerDocument.getElementById(menuId(task));
    menu?.showPopover();
    menu?.querySelector("button")?.focus();
  }
  function menuKeydown(event: KeyboardEvent) {
    const menu = event.currentTarget as HTMLElement;
    if (event.key === "Escape") {
      event.preventDefault();
      menu.hidePopover();
      menuTrigger?.focus();
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const buttons = Array.from(
      menu.querySelectorAll<HTMLElement>('[role="menuitem"]'),
    ).filter((item) => !item.matches(":disabled"));
    const index = buttons.indexOf(
      menu.ownerDocument.activeElement as HTMLElement,
    );
    const target =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? buttons.length - 1
          : (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) %
            buttons.length;
    buttons[target]?.focus();
  }
  async function removeSchedule() {
    if ($action?.kind !== "unschedule" || !scheduler || busy) return;
    const openedAction = $action;
    busy = true;
    actionError = "";
    try {
      await scheduler.unschedule(openedAction.task.id);
      finishAction(openedAction);
    } catch (failure) {
      if ($action !== openedAction) return;
      actionError =
        failure instanceof Error
          ? failure.message
          : "Could not remove this schedule. Try again.";
    } finally {
      busy = false;
    }
  }
  async function unlinkNote() {
    if ($action?.kind !== "unlink" || !reconciler || busy) return;
    const openedAction = $action;
    busy = true;
    actionError = "";
    try {
      await reconciler.unlink(openedAction.linkUid);
      finishAction(openedAction);
    } catch (failure) {
      if ($action !== openedAction) return;
      actionError =
        failure instanceof Error
          ? failure.message
          : "Could not unlink this note. Try again.";
    } finally {
      busy = false;
    }
  }
</script>

<section
  bind:this={paneElement}
  class="task-pane dp-task-panel"
  class:has-details={showDetails && !!selected}
  class:has-workflow={workflow}
  aria-label="Tasks"
  onkeydown={(event) => {
    if (
      event.key === "Escape" &&
      !event.isComposing &&
      !event.defaultPrevented &&
      $action &&
      !busy
    ) {
      event.preventDefault();
      cancelAction();
    }
  }}
  tabindex="-1"
>
  <header class="task-toolbar">
    <div class="task-heading">
      <h2>Tasks</h2>
      <div class="task-toolbar-actions">
        <button
          class="task-icon-button"
          aria-label="Refresh tasks"
          disabled={!$browserState.connected ||
            $browserState.loading ||
            ($browserState.retryAt ?? 0) > Date.now()}
          onclick={() => {
            void service.refresh();
          }}
          title="Refresh tasks"
          ><RefreshCw
            class={$browserState.loading ? "task-spinning" : ""}
            size={17}
          /></button
        >
        <button
          class="task-icon-button"
          aria-label="Capture and routing"
          onclick={() =>
            settings ? startAction({ kind: "settings" }) : captureSettings()}
          title="Capture and routing"><Settings size={17} /></button
        >
        <button
          class="task-icon-button task-add-button"
          aria-label="New task"
          disabled={!$browserState.writable}
          onclick={() => startAction({ kind: "create" })}
          title="New task"><Plus size={19} /></button
        >
      </div>
    </div>
    <button
      class="task-source-button"
      onclick={() => startAction({ kind: "connect" })}
      title="Todoist connection"
      ><span class="task-source-mark"><ListChecks size={15} /></span><span
        >Todoist</span
      ><ChevronDown size={13} /></button
    >
    <label class="task-search"
      ><Search size={16} /><input
        aria-label="Search tasks"
        placeholder="Search tasks"
        type="search"
        bind:value={$preferences.query}
      />{#if $preferences.query}<button
          class="task-icon-button"
          aria-label="Clear search"
          onclick={() => {
            $preferences = { ...$preferences, query: "" };
          }}><X size={14} /></button
        >{/if}</label
    >
    <div class="task-filter-row">
      <div class="task-grouping" aria-label="Group tasks">
        <button
          aria-pressed={$preferences.groupBy === "date"}
          onclick={() => {
            $preferences = { ...$preferences, groupBy: "date" };
          }}>Date</button
        ><button
          aria-pressed={$preferences.groupBy === "project"}
          onclick={() => {
            $preferences = { ...$preferences, groupBy: "project" };
          }}>Project</button
        >
      </div>
      {#if snapshot}<label class="task-project-filter"
          ><select
            aria-label="Filter by project"
            bind:value={$preferences.projectId}
            ><option value="">All projects</option
            >{#each snapshot.projects as project (project.id)}<option
                value={project.id}>{project.name}</option
              >{/each}</select
          ><ChevronDown size={13} /></label
        >{/if}
    </div>
  </header>

  {#if attentionCount || syncError}<details
      class="task-review"
      bind:open={reviewOpen}
    >
      <summary
        ><AlertCircle size={16} /><span
          >{attentionCount
            ? needsReview
              ? `${attentionCount} ${attentionCount === 1 ? "needs" : "need"} review`
              : `${attentionCount} pending`
            : "Sync needs attention"}</span
        ><ChevronDown size={14} /></summary
      >
      <div class="task-review-content">
        {#if syncError}<p class="task-form-error" role="status">{syncError}</p>
          {#if $browserState.needsReconnect}<button
              class="task-text-button"
              onclick={() => startAction({ kind: "connect" })}
              >Reconnect Todoist</button
            >{:else if $browserState.error}<button
              class="task-text-button"
              disabled={($browserState.retryAt ?? 0) > Date.now()}
              onclick={() => {
                void service.refresh();
              }}>Retry sync</button
            >{/if}{/if}
        {#each $reconcileState.issues as issue (issue.id)}<div
            class="task-review-row"
          >
            <div>
              <strong
                >{issue.source?.title ??
                  issue.remote?.title ??
                  "Linked task"}</strong
              ><small>{issue.message}</small>
            </div>
            {#if issue.fields.includes("unlink")}<button
                class="task-text-button"
                disabled={!$browserState.writable}
                onclick={() =>
                  startAction({
                    kind: "unlink",
                    linkUid: issue.linkUid,
                    title:
                      issue.source?.title ??
                      issue.remote?.title ??
                      "Linked task",
                    restoreTagOnCancel: true,
                  })}>Review link</button
              >{:else if !issue.fields.some( (field) => ["source", "task", "recurrence"].includes(field), )}<button
                class="task-text-button"
                disabled={!$browserState.writable ||
                  $browserState.loading ||
                  $scheduleState.operations.some(
                    (operation) =>
                      operation.linkUid === issue.linkUid &&
                      scheduleBlocksTask(operation),
                  )}
                onclick={() =>
                  startAction({ kind: "conflict", id: issue.id, source: true })}
                >Review</button
              >{:else}<button
                class="task-text-button"
                onclick={() => {
                  void reconciler?.scan();
                }}>Recheck</button
              >{/if}
            {#if issue.source && reconciler && issue.fields.includes("task")}<button
                class="task-text-button"
                disabled={!$browserState.writable}
                onclick={() =>
                  startAction({
                    kind: "unlink",
                    linkUid: issue.linkUid,
                    title: issue.source?.title ?? "Linked task",
                  })}>Unlink</button
              >{/if}
          </div>{/each}
        {#each $captureState.issues as issue (`${issue.candidate.path}:${issue.candidate.from}`)}<div
            class="task-review-row"
          >
            <div>
              <strong>{issue.candidate.title}</strong><small
                >{issue.message}</small
              >
            </div>
            {#if issue.occurrenceId}<button
                class="task-text-button"
                onclick={() =>
                  startAction({ kind: "occurrence", id: issue.occurrenceId! })}
                >View occurrence</button
              >
            {:else if issue.deletionId && deleter}<button
                class="task-text-button"
                onclick={() =>
                  startAction({
                    kind: "deleted-record",
                    id: issue.deletionId!,
                  })}>Review saved task</button
              >{:else if issue.kind === "identity"}<button
                class="task-text-button"
                onclick={() => capture.scan()}>Recheck link</button
              >{:else}<button
                class="task-text-button"
                onclick={() => startAction({ kind: "route", issue })}
                >Choose project</button
              >{/if}
          </div>{/each}
        {#each regularOperations as operation (operation.id)}<div
            class="task-review-row"
          >
            <div>
              <strong
                >{operation.mutation.kind === "create"
                  ? operation.mutation.task.title
                  : (operation.base?.title ?? "Task change")}</strong
              ><small>{operation.error ?? "Pending sync"}</small>
            </div>
            {#if operation.recurringUndo}<button
                class="task-text-button"
                onclick={() =>
                  startAction({
                    kind: "occurrence",
                    id: operation.recurringUndo!.occurrenceId,
                  })}>Review occurrence</button
              >{:else if operation.status === "conflict"}<button
                class="task-text-button"
                disabled={!$browserState.writable || $browserState.loading}
                onclick={() =>
                  startAction({
                    kind: "conflict",
                    id: operation.id,
                    source: false,
                  })}>Review</button
              >{:else}<button
                class="task-text-button"
                onclick={() => retry(operation.id)}>Retry</button
              >{/if}
          </div>{/each}
        {#each $scheduleState.operations as operation (operation.id)}<div
            class="task-review-row"
          >
            <div>
              <strong>{operation.task.title}</strong><small
                >{operation.error ??
                  (operation.phase === "calendar-pending"
                    ? "Google Calendar pending"
                    : "Saving schedule…")}</small
              >
            </div>
            {#if operation.phase !== "conflict" || operation.occurrenceId || operation.occurrenceUndoId}<button
                class="task-text-button"
                onclick={() => retrySchedule(operation.id)}>Retry</button
              >{/if}
          </div>{/each}
        {#each pendingOccurrences.filter((record) => record.phase === "freezing" || record.undo) as record (record.id)}<div
            class="task-review-row"
          >
            <div>
              <strong>{record.before.task.title}</strong><small
                >{record.undo?.error ??
                  record.error ??
                  (record.undo
                    ? "Restoring occurrence"
                    : "Saving occurrence history")}</small
              >
            </div>
            <button
              class="task-text-button"
              onclick={() => startAction({ kind: "occurrence", id: record.id })}
              >Review occurrence</button
            >
          </div>{/each}
        {#each pendingDeletions as record (record.id)}<div
            class="task-review-row"
          >
            <div>
              <strong>{record.tasks[0]!.title}</strong><small
                >{record.error ?? "Finishing saved task deletion"}</small
              >
            </div>
            <button
              class="task-text-button"
              onclick={() =>
                startAction({ kind: "deleted-record", id: record.id })}
              >Review deletion</button
            >
          </div>{/each}
      </div>
    </details>{/if}

  {#if $action}<div class="task-action-area">
      <button
        class="task-icon-button task-close-action"
        aria-label="Close task form"
        disabled={busy}
        onclick={cancelAction}><X size={17} /></button
      >
      {#key $action}
        {#if $action.kind === "connect"}<TaskPanelConnect
            cancel={cancelAction}
            saved={actionSaved($action)}
            {service}
          />
        {:else if $action.kind === "delete" && deleter}<TaskPanelDelete
            cancel={cancelAction}
            confirm={confirmTaskDeletion}
            controller={deleter}
            replaces={$action.replaces}
            saved={actionSaved($action)}
            taskId={$action.task.id}
          />
        {:else if $action.kind === "occurrence"}{#if selectedOccurrence}<TaskPanelOccurrence
              openNote={openSavedNote}
              pendingCalendar={$scheduleState.operations.some(
                (operation) =>
                  operation.occurrenceId === selectedOccurrence.id ||
                  operation.occurrenceUndoId === selectedOccurrence.id,
              )}
              record={selectedOccurrence}
              retry={reconciler
                ? (id: string) => reconciler!.retryOccurrence(id)
                : undefined}
              setBusy={(value: boolean) => {
                busy = value;
              }}
              timezone={snapshot?.account.timezone ?? "local"}
              undoCommand={$browserState.operations.find(
                (operation) => operation.id === selectedOccurrence.undo?.id,
              )}
              undoController={reconciler?.occurrenceUndo}
              writable={$browserState.writable && !$browserState.loading}
            />
          {:else}<div class="task-panel-form">
              <p class="task-form-error" role="status">
                Reconnect the original task account to view this occurrence's
                history.
              </p>
            </div>{/if}
        {:else if $action.kind === "deleted-record" && deleter}<TaskPanelDeleted
            id={$action.id}
            close={cancelAction}
            controller={deleter}
            {openSavedNote}
            {reviewDeletion}
            {service}
          />
        {:else if $action.kind === "settings" && settings}<TaskPanelCaptureSettings
            calendarSettings={calendar
              ? () => startAction({ kind: "calendars" })
              : undefined}
            cancel={cancelAction}
            {capture}
            saved={actionSaved($action)}
            {service}
            {settings}
          />
        {:else if $action.kind === "calendars" && settings && calendar}<TaskPanelCalendars
            {calendar}
            cancel={cancelAction}
            saved={actionSaved($action)}
            {service}
            {settings}
          />
        {:else if $action.kind === "route"}<TaskPanelRoute
            cancel={cancelAction}
            {capture}
            issue={$action.issue}
            saved={actionSaved($action)}
            {service}
          />
        {:else if ($action.kind === "create" || $action.kind === "edit") && snapshot}<TaskPanelEditor
            cancel={cancelAction}
            parent={$action.kind === "create" ? $action.parent : undefined}
            saved={actionSaved($action)}
            {service}
            {snapshot}
            task={$action.kind === "edit" ? $action.task : undefined}
          />
        {:else if $action.kind === "schedule" && scheduler}<TaskPanelSchedule
            cancel={cancelAction}
            {defaultDuration}
            saved={actionSaved($action)}
            {scheduler}
            task={$action.task}
          />
        {:else if $action.kind === "conflict"}{#if $action.source && reconciler}<TaskPanelConflict
              id={$action.id}
              cancel={cancelAction}
              controller={reconciler}
              saved={actionSaved($action)}
              {snapshot}
            />{:else}<TaskPanelConflict
              id={$action.id}
              cancel={cancelAction}
              controller={service}
              saved={actionSaved($action)}
              {snapshot}
            />{/if}
        {:else if $action.kind === "unlink" && reconciler}<div
            class="task-panel-form"
          >
            <h3>Unlink note and Todoist?</h3>
            <p class="task-form-context">{$action.title}</p>
            <p>
              Keep the note as a local task and manage the Todoist task
              separately.{" "}{#if $action.restoreTagOnCancel}
                Cancel restores #todoist and continues task sync.{:else}
                Remove its #todoist capture tag.{/if}
            </p>
            {#if actionError}<p class="task-form-error" role="status">
                {actionError}
              </p>{/if}
            <div class="task-form-actions">
              <button class="task-primary" disabled={busy} onclick={unlinkNote}
                >{restoringLink
                  ? "Restoring link…"
                  : busy
                    ? "Unlinking…"
                    : "Unlink note"}</button
              >
              <button
                class="task-text-button"
                disabled={busy}
                onclick={cancelAction}>Cancel</button
              >
            </div>
          </div>
        {:else if $action.kind === "unschedule"}<div class="task-panel-form">
            <h3>Remove from schedule?</h3>
            <p class="task-form-context">{$action.task.title}</p>
            <p>Remove the time block and its managed Google event.</p>
            {#if actionError}<p class="task-form-error" role="status">
                {actionError}
              </p>{/if}
            <div class="task-form-actions">
              <button
                class="task-primary"
                disabled={busy}
                onclick={removeSchedule}
                >{busy ? "Removing…" : "Remove from schedule"}</button
              ><button
                class="task-text-button"
                disabled={busy}
                onclick={cancelAction}>Cancel</button
              >
            </div>
          </div>{/if}
      {/key}
    </div>{/if}

  <div class="task-body">
    <div class="task-list-area">
      {#if !snapshot}<div class="task-empty">
          <ListChecks size={28} />
          <h3>Bring your tasks here</h3>
          <p>Connect Todoist to plan your day.</p>
          <button
            class="task-primary"
            onclick={() => startAction({ kind: "connect" })}
            >Connect Todoist</button
          >
        </div>
      {:else if !groups.length}<div class="task-empty">
          <Search size={25} />
          <h3>
            {$preferences.query || $preferences.projectId
              ? "No matching tasks"
              : "All clear"}
          </h3>
          {#if $preferences.query || $preferences.projectId}<button
              class="task-text-button"
              onclick={() => {
                $preferences = { ...$preferences, query: "", projectId: "" };
              }}>Clear filters</button
            >{:else}<p>Your active tasks appear here.</p>{/if}
        </div>
      {:else}<div class="task-groups">
          {#each groups as group (group.id)}<section
              class="task-group"
              aria-label={group.label}
            >
              <button
                class="task-group-heading"
                aria-expanded={!$preferences.collapsed.includes(group.id)}
                onclick={() => toggleGroup(group.id)}
                >{#if $preferences.collapsed.includes(group.id)}<ChevronRight
                    size={15}
                  />{:else}<ChevronDown size={15} />{/if}<strong
                  >{group.label}</strong
                ><span>{group.count}</span></button
              >
              {#if !$preferences.collapsed.includes(group.id)}{#each group.rows as row (row.task.id)}
                  {@const projection = $scheduleState.projections.find(
                    (item) => item.taskId === row.task.id,
                  )}
                  <div
                    style:--task-depth={Math.min(row.depth, 6)}
                    class="task-row-container"
                    class:task-nested={row.depth > 0}
                    class:task-selected={selected?.id === row.task.id}
                  >
                    {#if row.hasChildren}<button
                        class="task-tree-toggle task-icon-button"
                        aria-expanded={!$preferences.collapsed.includes(
                          `task:${group.id}:${row.task.id}`,
                        )}
                        aria-label={`Toggle subtasks for ${row.task.title}`}
                        onclick={() =>
                          toggleGroup(`task:${group.id}:${row.task.id}`)}
                        >{#if $preferences.collapsed.includes(`task:${group.id}:${row.task.id}`)}<ChevronRight
                            size={13}
                          />{:else}<ChevronDown size={13} />{/if}</button
                      >{/if}
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
                        draggable={!!scheduler &&
                          $browserState.writable &&
                          !pendingIds.has(row.task.id)}
                        onclick={() => chooseTask(row.task)}
                        oncontextmenu={(event) => contextMenu(row.task, event)}
                        ondragend={() => scheduler?.drag.cancel()}
                        ondragstart={(event) => {
                          if (scheduler && event.dataTransfer)
                            scheduler.drag.start(row.task, event.dataTransfer);
                        }}
                        onkeydown={(event) => {
                          if (
                            event.key === "ContextMenu" ||
                            (event.shiftKey && event.key === "F10")
                          )
                            contextMenu(row.task, event);
                        }}
                        ><span class="task-title"
                          >{row.task.title || "Untitled task"}</span
                        ></button
                      >
                      <div class="task-row-meta">
                        {#if row.depth === 0}<span class="task-project-chip"
                            >{projectName(row.task)}</span
                          >{/if}{#if projection?.interval}<button
                            class="task-schedule-chip"
                            onclick={() => revealTask(row.task)}
                            title="Open schedule"
                            ><Calendar size={12} />{scheduleLabel(
                              projection,
                            )}</button
                          >{:else if row.task.due}<span class="task-date"
                            >{dateLabel(row.task)}</span
                          >{/if}{#if row.task.priority > 1}<span
                            class="task-priority"
                            title={`Priority ${5 - row.task.priority}`}
                            ><Flag size={12} /></span
                          >{/if}{#if pendingIds.has(row.task.id)}<span
                            class="task-pending">Pending</span
                          >{/if}
                      </div>
                    </div>
                    <button
                      class="task-icon-button task-row-more"
                      aria-label={`Actions for ${row.task.title}`}
                      onclick={positionMenu}
                      onkeydown={(event) => {
                        if (event.key === "ArrowDown")
                          contextMenu(row.task, event);
                      }}
                      popovertarget={menuId(row.task)}
                      ><MoreHorizontal size={16} /></button
                    >
                    <div
                      id={menuId(row.task)}
                      style:left={`${menuLeft}px`}
                      style:top={`${menuTop}px`}
                      class="task-menu"
                      aria-label={`Actions for ${row.task.title}`}
                      onkeydown={menuKeydown}
                      popover="auto"
                      role="menu"
                      tabindex="-1"
                    >
                      {#if scheduler}<button
                          disabled={!$browserState.writable ||
                            pendingIds.has(row.task.id)}
                          onclick={() =>
                            startAction({ kind: "schedule", task: row.task })}
                          role="menuitem"
                          ><CalendarClock size={15} />{projection?.interval
                            ? "Move schedule"
                            : "Schedule"}</button
                        >{/if}
                      <button
                        disabled={!$browserState.writable ||
                          pendingIds.has(row.task.id)}
                        onclick={() =>
                          startAction({ kind: "edit", task: row.task })}
                        role="menuitem"><Pencil size={15} />Edit task</button
                      ><a
                        href={`https://app.todoist.com/app/task/${encodeURIComponent(row.task.id)}`}
                        rel="noopener noreferrer"
                        role="menuitem"
                        target="_blank"
                        ><ExternalLink size={15} />Open in Todoist</a
                      >
                      {#if deleter && snapshot?.account.capabilities?.delete}<button
                          disabled={!$browserState.writable ||
                            pendingIds.has(row.task.id)}
                          onclick={() =>
                            startAction({ kind: "delete", task: row.task })}
                          role="menuitem"
                          ><Trash2 size={15} />Delete from Todoist</button
                        >{/if}
                    </div>
                  </div>
                {/each}{/if}
            </section>{/each}
        </div>{/if}
      {#if $browserState.completed.length}<details class="task-completed">
          <summary
            ><Check size={14} />Completed<span
              >{$browserState.completed.length}</span
            ></summary
          >{#each $browserState.completed as task (task.id)}<div
              class="task-completed-row"
            >
              <span>{task.title}</span><button
                class="task-text-button"
                disabled={!$browserState.writable}
                onclick={() => reopenTask(task)}>Reopen</button
              >
            </div>{/each}
        </details>{/if}
      {#if occurrenceHistory.length}<details class="task-completed">
          <summary
            ><Check size={14} />Completed occurrences<span
              >{occurrenceHistory.length}</span
            ></summary
          >
          {#each occurrenceHistory as record (record.id)}<div
              class="task-completed-row task-occurrence-row"
            >
              <span
                ><span>{record.before.task.title}</span><small
                  >{record.before.task.due?.date.slice(0, 10)}</small
                ></span
              >
              <button
                class="task-text-button"
                onclick={() =>
                  startAction({ kind: "occurrence", id: record.id })}
                >Details</button
              >
            </div>{/each}
        </details>{/if}
      {#if deletionHistory.length}<details class="task-completed">
          <summary
            ><Trash2 size={14} />Deletion history<span
              >{deletionHistory.length}</span
            ></summary
          >{#each deletionHistory as record (record.id)}<div
              class="task-completed-row"
            >
              <span>{record.tasks[0]!.title}</span><button
                class="task-text-button"
                onclick={() =>
                  startAction({ kind: "deleted-record", id: record.id })}
                >Review</button
              >
            </div>{/each}
        </details>{/if}
    </div>

    {#if showDetails && selected}<section
        class="task-details"
        aria-label="Task details"
      >
        <div class="task-detail-navigation">
          <button
            class="task-text-button"
            onclick={() => {
              showDetails = false;
            }}><ArrowLeft size={16} />All tasks</button
          ><a
            class="task-icon-button"
            aria-label="Open in Todoist"
            href={`https://app.todoist.com/app/task/${encodeURIComponent(selected.id)}`}
            rel="noopener noreferrer"
            target="_blank"><ExternalLink size={16} /></a
          ><button
            class="task-icon-button"
            aria-label="Edit task"
            disabled={!canEditSelected}
            onclick={() => startAction({ kind: "edit", task: selected })}
            ><Pencil size={16} /></button
          >
        </div>
        <div class="task-detail-title">
          <input
            class="task-checkbox"
            aria-label={`Complete ${selected.title}`}
            disabled={!canEditSelected}
            onchange={() => completeTask(selected)}
            type="checkbox"
          />
          <h3>{selected.title}</h3>
        </div>
        {#if selectedProjection?.interval}<div class="task-schedule-card">
            <button onclick={() => revealTask(selected)}
              ><CalendarClock size={18} /><span
                >{scheduleLabel(selectedProjection)}</span
              ></button
            ><button
              class="task-text-button"
              disabled={!canEditSelected}
              onclick={() => startAction({ kind: "schedule", task: selected })}
              >Move</button
            >
          </div>{:else if scheduler}<button
            class="task-schedule-card task-unscheduled-action"
            disabled={!canEditSelected}
            onclick={() => startAction({ kind: "schedule", task: selected })}
            ><CalendarClock size={17} />Schedule task<Plus size={15} /></button
          >{/if}
        <dl class="task-properties">
          <div>
            <dt><ListChecks size={15} />Project</dt>
            <dd>{projectName(selected)}</dd>
          </div>
          <div>
            <dt><Calendar size={15} />Date</dt>
            <dd>{dateLabel(selected)}</dd>
          </div>
          <div>
            <dt><Flag size={15} />Priority</dt>
            <dd>
              {selected.priority === 1
                ? "Normal"
                : `Priority ${5 - selected.priority}`}
            </dd>
          </div>
          {#if selected.labels.length}<div>
              <dt><Tag size={15} />Labels</dt>
              <dd>
                {#each selected.labels as label (label)}<span
                    class="task-label-chip">{label}</span
                  >{/each}
              </dd>
            </div>{/if}{#if selected.due?.recurring}<div>
              <dt><RefreshCw size={15} />Repeats</dt>
              <dd>{selected.due.text}</dd>
            </div>{/if}{#if selected.duration}<div>
              <dt><Clock size={15} />Duration</dt>
              <dd>
                {selected.duration.amount}
                {selected.duration.unit === "minute" ? "min" : "days"}
              </dd>
            </div>{/if}{#if selectedProjection && !selectedProjection.interval}<div
            >
              <dt><ExternalLink size={15} />Note</dt>
              <dd>
                <button
                  class="task-text-button"
                  onclick={() => revealTask(selected)}>Open linked note</button
                >
              </dd>
            </div>{/if}
        </dl>
        {#if selected.description}<section class="task-detail-section">
            <h4>Description</h4>
            <p class="task-description">{selected.description}</p>
          </section>{/if}
        <section class="task-detail-section">
          <div class="task-subtask-heading">
            <h4>
              Subtasks{#if children.length}<span>{children.length}</span>{/if}
            </h4>
            <button
              class="task-icon-button"
              aria-label="Add subtask"
              disabled={!canEditSelected}
              onclick={() => startAction({ kind: "create", parent: selected })}
              ><Plus size={16} /></button
            >
          </div>
          {#each children as child (child.task.id)}<div
              style:--task-depth={Math.min(child.depth - 1, 5)}
              class="task-detail-child"
            >
              <input
                class="task-checkbox"
                aria-label={`Complete ${child.task.title}`}
                disabled={!$browserState.writable ||
                  pendingIds.has(child.task.id)}
                onchange={() => completeTask(child.task)}
                type="checkbox"
              /><button
                class="task-text-button"
                onclick={() => chooseTask(child.task)}
                >{child.task.title}</button
              >
            </div>{/each}<button
            class="task-text-button task-add-subtask"
            disabled={!canEditSelected}
            onclick={() => startAction({ kind: "create", parent: selected })}
            ><Plus size={14} />Add subtask</button
          >
        </section>
        {#if selectedProjection}<div class="task-note-actions">
            {#if selectedProjection.interval}<button
                class="task-text-button"
                disabled={!canEditSelected}
                onclick={() =>
                  startAction({ kind: "unschedule", task: selected })}
                ><CalendarMinus size={17} />Remove from schedule</button
              >{/if}
            {#if reconciler}<button
                class="task-text-button"
                disabled={!canEditSelected}
                onclick={() =>
                  startAction({
                    kind: "unlink",
                    linkUid: selectedProjection.linkUid,
                    title: selected.title,
                  })}><Unlink size={16} />Unlink note</button
              >{/if}
          </div>{/if}
        {#if deleter && snapshot?.account.capabilities?.delete}<button
            class="task-text-button task-delete-button"
            disabled={!canEditSelected}
            onclick={() => startAction({ kind: "delete", task: selected })}
            ><Trash2 size={16} />Delete from Todoist</button
          >{/if}
      </section>{/if}
  </div>

  <footer class="task-panel-footer" aria-live="polite" role="status">
    <span
      class="task-sync-indicator"
      class:task-sync-warning={!!syncError ||
        !$browserState.connected ||
        attentionCount > 0}
    ></span><span
      >{$browserState.loading
        ? "Refreshing…"
        : !$browserState.connected
          ? snapshot
            ? "Cached · Disconnected"
            : "Not connected"
          : syncError
            ? "Sync needs attention"
            : needsReview
              ? "Needs review"
              : attentionCount
                ? "Changes saved"
                : "Synced"}</span
    >{#if snapshot}<button
        class="task-account-button"
        onclick={() => startAction({ kind: "connect" })}
        title={`Updated ${new Date(snapshot.fetchedAt).toLocaleString()}`}
        >{snapshot.account.name}<ChevronDown size={12} /></button
      >{/if}
  </footer>
</section>
