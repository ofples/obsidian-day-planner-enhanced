<script lang="ts">
  /* eslint-disable @typescript-eslint/no-floating-promises, @typescript-eslint/no-misused-promises, @typescript-eslint/no-redundant-type-constituents, @typescript-eslint/no-unnecessary-condition, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-enum-comparison, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return -- Obsidian community scorecard can run type-aware rules without resolving plugin source dependencies; tsc and svelte-check cover this source. */
  import { Notice } from "obsidian";
  import { derived, get, readable } from "svelte/store";
  import { isNotVoid } from "typed-assert";

  import { getObsidianContext } from "../../context/obsidian-context";
  import { currentTimeSignal, isToday } from "../../global-store/current-time";
  import {
    getAvailableTimelineColumns,
    getVisibleHours,
    snap,
  } from "../../global-store/derived-settings";
  import { layoutRecurringPreviews } from "../../overlap/recurring-preview-layout";
  import { selectLogTimeBlocksForDay } from "../../redux";
  import { selectLogEntriesById } from "../../redux/index/index-slice";
  import { selectRecurringPreviewsForDay } from "../../redux/index/recurring-preview-selectors";
  import { taskDragMime } from "../../tasks/drag";
  import { noteTaskDragMime } from "../../tasks/note-drag";
  import type { ProviderTask } from "../../tasks/types";
  import type {
    LogTimeBlock,
    TimeBlock,
    WithDuration,
    WithPlacing,
  } from "../../time-block-types";
  import {
    getClientOffsetY,
    getIsomorphicClientY,
    getPointerOffsetY,
    isTouchEvent,
    listenForAutoScrollPointerMove,
    offsetYToMinutes,
  } from "../../util/dom";
  import {
    getMinutesSinceMidnight,
    minutesToMomentOfDay,
  } from "../../util/moment";
  import type { Moment } from "../../util/obsidian-moment";
  import {
    getBlockProps,
    getDayKey,
    getEndMinutes,
    getRenderKey,
  } from "../../util/time-block-utils";
  import { createGestures } from "../actions/gestures";
  import { createActiveClockMenu } from "../active-clock-menu";
  import { createCompletedClockMenu } from "../completed-clock-menu";
  import {
    getDragPointerDateTime,
    shouldUpdateDateTimePointer,
    withDragScrollOffset,
  } from "../hooks/use-edit/drag-pointer";
  import type { EditOperation } from "../hooks/use-edit/types";

  import Column from "./column.svelte";
  import LocalTimeBlock from "./local-time-block.svelte";
  import Needle from "./needle.svelte";
  import PositionedTimeBlock from "./positioned-time-block.svelte";
  import RecurringTaskPreviews from "./recurring-task-previews.svelte";
  import Selectable from "./selectable.svelte";
  import UnscheduledTimeBlock from "./unscheduled-time-block.svelte";

  const {
    day,
    autoScrollBlocked = false,
    isInSidebar = false,
    showNeedleMarker = true,
  }: {
    autoScrollBlocked?: boolean;
    day: Moment;
    isInSidebar?: boolean;
    showNeedleMarker?: boolean;
  } = $props();

  const {
    settingsStore,
    editContext: {
      confirmEdit,
      handlers: { handleContainerMouseDown },
      getDisplayedTimeBlocksForTimeline,
      editOperation,
    },
    pointerDateTime,
    settingsSignal,
    useSelector,
    logEntryEditor,
    workspaceFacade,
    openLogEntryEditModal,
    taskScheduler,
    noteTaskDrag,
  } = getObsidianContext();
  const providerDraggedTask =
    taskScheduler?.drag.state ?? readable<ProviderTask | null>(null);
  const noteDraggedTask = noteTaskDrag?.state ?? readable(null);
  const draggedTask = derived(
    [providerDraggedTask, noteDraggedTask],
    ([provider, note]) => provider ?? note,
  );
  let taskDropPreview: { start: Moment; end: Moment; title: string } | null =
    $state(null);
  let subtaskDropTarget: string | null = $state(null);
  $effect(() => {
    if (!$draggedTask) {
      taskDropPreview = null;
      subtaskDropTarget = null;
    }
  });

  function taskIntervalAt(event: DragEvent) {
    const task = taskScheduler?.drag.current();
    const note = noteTaskDrag?.current();
    if ((!task && !note) || !taskScheduler || !el) return null;
    const settings = $settingsStore;
    const minutes = offsetYToMinutes(
      snap(event.clientY - el.getBoundingClientRect().top, settings),
      settings.zoomLevel,
      settings.startHour,
    );
    const start = minutesToMomentOfDay(minutes, day);
    return {
      start,
      end: start
        .clone()
        .add(
          task
            ? taskScheduler.duration(task, settings.defaultDurationMinutes)
            : (note?.durationMinutes ?? settings.defaultDurationMinutes),
          "minutes",
        ),
      title: task?.title ?? note?.title ?? "Note task",
    };
  }

  function taskDragOver(event: DragEvent) {
    if (!event.dataTransfer || !acceptsTaskDrag(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    subtaskDropTarget = null;
    taskDropPreview = taskIntervalAt(event);
  }

  function acceptsTaskDrag(event: DragEvent) {
    return Boolean(
      event.dataTransfer &&
        ((event.dataTransfer.types.includes(taskDragMime) &&
          taskScheduler?.drag.current()) ||
          (event.dataTransfer.types.includes(noteTaskDragMime) &&
            noteTaskDrag?.current())),
    );
  }

  function subtaskDragOver(event: DragEvent, id: string) {
    if (!event.dataTransfer || !acceptsTaskDrag(event)) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "move";
    taskDropPreview = null;
    subtaskDropTarget = id;
  }

  async function dropSubtask(
    event: DragEvent,
    block: {
      path: string;
      position: { start: { line: number } };
      text: string;
    },
  ) {
    if (!event.dataTransfer || !acceptsTaskDrag(event) || !taskScheduler)
      return;
    event.preventDefault();
    event.stopPropagation();
    try {
      const parent = {
        path: block.path,
        line: block.position.start.line,
        text: block.text,
      };
      if (event.dataTransfer.types.includes(noteTaskDragMime) && noteTaskDrag) {
        const drop = noteTaskDrag.accept(event.dataTransfer);
        await taskScheduler.nestNote(drop.reference, parent, drop.id);
      } else {
        const drop = taskScheduler.drag.accept(event.dataTransfer);
        await (
          taskScheduler.nestFromPane?.bind(taskScheduler) ??
          taskScheduler.nest.bind(taskScheduler)
        )(drop.task.id, parent, drop.id);
      }
    } catch (error) {
      new Notice(
        error instanceof Error ? error.message : "Could not add this subtask.",
      );
    } finally {
      taskScheduler.drag.cancel();
      noteTaskDrag?.cancel();
      subtaskDropTarget = null;
      taskDropPreview = null;
    }
  }

  async function dropTask(event: DragEvent) {
    if (!event.dataTransfer || !acceptsTaskDrag(event) || !taskScheduler)
      return;
    event.preventDefault();
    event.stopPropagation();
    try {
      const interval = taskIntervalAt(event);
      if (interval) {
        const target = {
          start: interval.start.toISOString(),
          end: interval.end.toISOString(),
        };
        if (
          event.dataTransfer.types.includes(noteTaskDragMime) &&
          noteTaskDrag
        ) {
          const drop = noteTaskDrag.accept(event.dataTransfer);
          await taskScheduler.placeNote(drop.reference, target, drop.id);
        } else {
          const drop = taskScheduler.drag.accept(event.dataTransfer);
          await (
            taskScheduler.place?.bind(taskScheduler) ??
            taskScheduler.schedule.bind(taskScheduler)
          )(drop.task.id, target, drop.id);
        }
      }
    } catch (error) {
      new Notice(
        error instanceof Error
          ? error.message
          : "Could not save this task drop.",
      );
    } finally {
      taskScheduler.drag.cancel();
      noteTaskDrag?.cancel();
      taskDropPreview = null;
    }
  }

  const displayedTimeBlocksForTimeline = $derived(
    getDisplayedTimeBlocksForTimeline(day),
  );
  const dayKey = $derived(getDayKey(day));
  const recurringPreviews = useSelector((state) =>
    selectRecurringPreviewsForDay(state, dayKey),
  );
  const showRecurringPreviews = $derived(
    settingsSignal.current.showRecurringTaskPreviews &&
      !day.isBefore(currentTimeSignal.current, "day"),
  );
  const plannerLayout = $derived(
    layoutRecurringPreviews(
      $displayedTimeBlocksForTimeline.withTime,
      showRecurringPreviews ? recurringPreviews.current : [],
    ),
  );
  const timelineColumns = $derived(getAvailableTimelineColumns($settingsStore));

  const logEntriesForDay = useSelector((state) =>
    selectLogTimeBlocksForDay(state, dayKey, currentTimeSignal.current),
  );
  const logEntriesById = useSelector(selectLogEntriesById);

  // todo: separate LogTimeBlockView (clamped) & LogTimeBlock
  function showLogBlockMenu(
    event: MouseEvent | PointerEvent | TouchEvent,
    timeBlockView: LogTimeBlock,
  ) {
    const logEntry = logEntriesById.current[timeBlockView.id];

    isNotVoid(logEntry, `No log entry found for block id ${timeBlockView.id}`);

    const isCompleted = logEntry.end;

    if (isCompleted) {
      createCompletedClockMenu({
        event,
        timeBlock: timeBlockView,
        logEntry: logEntry,
        logEntryEditor,
        workspaceFacade,
        openLogEntryEditModal,
      });
    } else {
      createActiveClockMenu({
        event,
        timeBlock: timeBlockView,
        logEntryEditor,
        workspaceFacade,
        // pass the raw entry so "Edit..." targets the real (unclamped) entry
        openLogEntryEditModal: (timeBlock) =>
          openLogEntryEditModal(timeBlock, logEntry),
      });
    }
  }

  interface SeparatorVisibility {
    showBottomSeparator: boolean;
    showTopSeparator: boolean;
  }

  function createSeparatorVisibilityLookup(
    tasks: Array<WithPlacing<WithDuration<TimeBlock>>>,
  ) {
    const separatorVisibilityByRenderKey = new Map<
      string,
      SeparatorVisibility
    >();
    const tasksByStartMinute = new Map<
      number,
      Array<WithPlacing<WithDuration<TimeBlock>>>
    >();

    tasks.forEach((task) => {
      const startMinute = getMinutesSinceMidnight(task.startTime);
      const tasksStartingAtMinute = tasksByStartMinute.get(startMinute) ?? [];

      tasksStartingAtMinute.push(task);
      tasksByStartMinute.set(startMinute, tasksStartingAtMinute);

      separatorVisibilityByRenderKey.set(getRenderKey(task), {
        showBottomSeparator: true,
        showTopSeparator: !startsOnTimelineGridLine(task),
      });
    });

    tasks.forEach((task) => {
      const nextTasks = tasksByStartMinute.get(getEndMinutes(task)) ?? [];
      const nextTaskCoveringTaskHorizontally = nextTasks.find((nextTask) =>
        coversHorizontalRange(nextTask, task),
      );

      if (
        nextTaskCoveringTaskHorizontally &&
        !startsOnTimelineGridLine(nextTaskCoveringTaskHorizontally)
      ) {
        const currentVisibility = separatorVisibilityByRenderKey.get(
          getRenderKey(task),
        );

        separatorVisibilityByRenderKey.set(getRenderKey(task), {
          showBottomSeparator: false,
          showTopSeparator: currentVisibility?.showTopSeparator ?? true,
        });
      }
    });

    return separatorVisibilityByRenderKey;
  }

  function coversHorizontalRange(
    candidate: WithPlacing<WithDuration<TimeBlock>>,
    task: WithPlacing<WithDuration<TimeBlock>>,
  ) {
    const epsilon = 0.0001;
    const candidateStart = candidate.placing.offsetPercent;
    const candidateEnd = candidateStart + candidate.placing.spanPercent;
    const taskStart = task.placing.offsetPercent;
    const taskEnd = taskStart + task.placing.spanPercent;

    return (
      candidateStart <= taskStart + epsilon && candidateEnd >= taskEnd - epsilon
    );
  }

  function startsOnTimelineGridLine(task: WithDuration<TimeBlock>) {
    return getMinutesSinceMidnight(task.startTime) % 30 === 0;
  }

  const plannerSeparatorVisibility = $derived(
    createSeparatorVisibilityLookup(plannerLayout.realBlocks),
  );
  const logEntrySeparatorVisibility = $derived(
    createSeparatorVisibilityLookup(logEntriesForDay.current),
  );

  let el: HTMLElement | undefined = $state();

  function setDateTimePointer(dateTime: Moment) {
    const previousPointerDateTime = get(pointerDateTime);

    if (shouldUpdateDateTimePointer(previousPointerDateTime, dateTime)) {
      pointerDateTime.set({ dateTime, type: "dateTime" });
    }
  }

  function updatePointerDateTime(event: MouseEvent | TouchEvent) {
    isNotVoid(el);

    const newOffsetY = snap(getPointerOffsetY(el, event), $settingsStore);
    const minutesSinceMidnight = offsetYToMinutes(
      newOffsetY,
      settingsSignal.current.zoomLevel,
      settingsSignal.current.startHour,
    );
    const dateTime = minutesToMomentOfDay(
      minutesSinceMidnight,
      window.moment(day),
    );

    setDateTimePointer(dateTime);
  }

  function handleContainerPointerDown(event: MouseEvent | TouchEvent) {
    updatePointerDateTime(event);
    handleContainerMouseDown();
  }

  function updateDragPointerDateTime(
    clientY: number,
    operation: EditOperation,
  ) {
    isNotVoid(el);

    const dateTime = getDragPointerDateTime({
      clientY,
      day: window.moment(day),
      operation,
      settings: settingsSignal.current,
      timelineOffsetY: getClientOffsetY(el, clientY),
    });

    setDateTimePointer(dateTime);
  }

  function handleContainerPointerMove(event: MouseEvent | TouchEvent) {
    const currentEditOperation = get(editOperation);

    if (!currentEditOperation) {
      return;
    }

    updateDragPointerDateTime(
      getIsomorphicClientY(event),
      currentEditOperation,
    );
  }

  function updateDragPointerOnAutoScroll(node: HTMLElement) {
    return listenForAutoScrollPointerMove(node, ({ clientY, scrollDeltaY }) => {
      let currentEditOperation = get(editOperation);

      if (!currentEditOperation) {
        return;
      }

      const scrolledEditOperation = withDragScrollOffset(
        currentEditOperation,
        scrollDeltaY,
      );

      if (scrolledEditOperation !== currentEditOperation) {
        currentEditOperation = scrolledEditOperation;
        editOperation.set(currentEditOperation);
      }

      updateDragPointerDateTime(clientY, currentEditOperation);
    });
  }

  const timelineGestures = createGestures({
    onlongpress: (event) => {
      if (event.target !== el) {
        return;
      }

      handleContainerPointerDown(event);
    },
    onpanmove: handleContainerPointerMove,
    onpanend: confirmEdit,
    options: { mouseSupport: false },
  });
</script>

<div class={["timeline", isInSidebar && "is-in-sidebar"]}>
  {#if $isToday(day)}
    <Needle {autoScrollBlocked} showMarker={showNeedleMarker} />
  {/if}

  {#if timelineColumns.planner}
    <Column visibleHours={getVisibleHours($settingsStore)}>
      <div
        bind:this={el}
        class="tasks absolute-stretch-x"
        ondragenter={taskDragOver}
        ondragleave={(event) => {
          if (
            !event.relatedTarget ||
            !el?.contains(event.relatedTarget as Node)
          )
            taskDropPreview = null;
        }}
        ondragover={taskDragOver}
        ondrop={dropTask}
        onpointerdown={(event) => {
          if (isTouchEvent(event) || event.target !== el) {
            return;
          }

          handleContainerPointerDown(event);
        }}
        onpointermove={handleContainerPointerMove}
        onpointerup={confirmEdit}
        use:timelineGestures
        use:updateDragPointerOnAutoScroll
      >
        {#if taskDropPreview}<div
            style:top="{(getMinutesSinceMidnight(taskDropPreview.start) -
              $settingsStore.startHour * 60) *
              $settingsStore.zoomLevel}px"
            style:height="{taskDropPreview.end.diff(
              taskDropPreview.start,
              'minutes',
            ) * $settingsStore.zoomLevel}px"
            class="task-drop-preview"
            aria-hidden="true"
          >
            <strong>{taskDropPreview.title}</strong><small
              >{taskDropPreview.start.format(
                $settingsStore.timestampFormat,
              )}–{taskDropPreview.end.format(
                $settingsStore.timestampFormat,
              )}</small
            >
          </div>{/if}
        {#if showRecurringPreviews}
          <RecurringTaskPreviews
            {dayKey}
            placings={plannerLayout.previewPlacings}
          />
        {/if}
        {#each plannerLayout.realBlocks as timeBlock (getRenderKey(timeBlock))}
          {@const separatorVisibility = plannerSeparatorVisibility.get(
            getRenderKey(timeBlock),
          )}
          <PositionedTimeBlock
            showBottomSeparator={separatorVisibility?.showBottomSeparator}
            showTopSeparator={separatorVisibility?.showTopSeparator}
            {timeBlock}
          >
            <UnscheduledTimeBlock {timeBlock}>
              {#snippet bottomDecoration()}
                {getBlockProps(timeBlock, settingsSignal.current)}
              {/snippet}
            </UnscheduledTimeBlock>
            {#if $draggedTask && (timeBlock.source === "dailyNoteDate" || timeBlock.source === "tasksPluginProp")}
              <div
                class="task-subtask-drop-target"
                class:active={subtaskDropTarget === timeBlock.id}
                aria-label="Add task as subtask"
                ondragenter={(event) => subtaskDragOver(event, timeBlock.id)}
                ondragleave={() => {
                  if (subtaskDropTarget === timeBlock.id)
                    subtaskDropTarget = null;
                }}
                ondragover={(event) => subtaskDragOver(event, timeBlock.id)}
                ondrop={(event) => dropSubtask(event, timeBlock)}
                role="group"
              >
                <span>Add as subtask</span>
              </div>
            {/if}
          </PositionedTimeBlock>
        {/each}
      </div>
    </Column>
  {/if}

  {#if timelineColumns.timeTracker}
    <Column visibleHours={getVisibleHours($settingsStore)}>
      <div class="tasks absolute-stretch-x">
        {#each logEntriesForDay.current as timeBlock (timeBlock.id)}
          {@const separatorVisibility = logEntrySeparatorVisibility.get(
            getRenderKey(timeBlock),
          )}
          <PositionedTimeBlock
            showBottomSeparator={separatorVisibility?.showBottomSeparator}
            showTopSeparator={separatorVisibility?.showTopSeparator}
            {timeBlock}
          >
            <Selectable
              onSecondarySelect={(event) => showLogBlockMenu(event, timeBlock)}
            >
              {#snippet children({ use, onpointerup, state })}
                <LocalTimeBlock
                  isActive={state === "secondary"}
                  {onpointerup}
                  {timeBlock}
                  {use}
                >
                  {#snippet bottomDecoration()}
                    {getBlockProps(timeBlock, settingsSignal.current)}
                  {/snippet}
                </LocalTimeBlock>
              {/snippet}
            </Selectable>
          </PositionedTimeBlock>
        {/each}
      </div>
    </Column>
  {/if}
</div>

<!-- eslint-enable @typescript-eslint/no-floating-promises, @typescript-eslint/no-misused-promises, @typescript-eslint/no-redundant-type-constituents, @typescript-eslint/no-unnecessary-condition, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-enum-comparison, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return -- Re-enable scorecard compatibility suppressions after this file. -->

<style>
  .task-subtask-drop-target {
    position: absolute;
    z-index: 20;
    top: var(--time-block-top);
    left: calc(var(--time-block-left) + var(--time-block-width) / 2);

    display: flex;
    align-items: center;
    justify-content: flex-end;

    box-sizing: border-box;
    width: calc(var(--time-block-width) / 2);
    height: var(--time-block-height);
    padding: 0 6px;

    background: color-mix(in srgb, var(--interactive-accent) 12%, transparent);
    border: 1px dashed var(--interactive-accent);
  }

  .task-subtask-drop-target.active {
    background: color-mix(in srgb, var(--interactive-accent) 30%, transparent);
    outline: 1px solid var(--interactive-accent);
  }

  .task-subtask-drop-target span {
    pointer-events: none;

    overflow: hidden;

    padding: 1px 4px;

    font-size: var(--font-smallest);
    color: var(--text-normal);
    text-overflow: ellipsis;
    white-space: nowrap;

    background: var(--background-primary);
    border-radius: 3px;
  }

  .task-drop-preview {
    pointer-events: none;

    position: absolute;
    z-index: 6;
    inset-inline: 3px;

    overflow: hidden;
    display: flex;
    flex-direction: column;

    padding: 4px 8px;

    color: var(--text-normal);

    background: var(--background-secondary);
    border: 2px dashed var(--interactive-accent);
    border-radius: var(--radius-s);
  }

  .timeline {
    isolation: isolate;
    position: relative;

    display: flex;
    flex: 1 1 0;

    height: fit-content;

    border-inline-end: var(--timeline-border-inline-end);
  }

  .timeline.is-in-sidebar {
    --timeline-time-block-inline-start-overlap: -1px;
    --timeline-time-block-inline-end-inset: 2px;
  }

  .tasks {
    z-index: 2;
    top: 0;
    bottom: 0;

    display: flex;
    flex-direction: column;

    margin-inline: var(--timeline-time-block-inline-start-overlap, 0)
      var(--timeline-time-block-inline-end-inset, 0);
  }

  .tasks :global(.planner-sticky-block-content) {
    position: sticky;
    top: 0;
    max-height: 100%;
  }
</style>
