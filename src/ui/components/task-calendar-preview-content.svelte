<script lang="ts">
  import { Notice } from "obsidian";

  import { getObsidianContext } from "../../context/obsidian-context";
  import type { RemoteTimeBlock } from "../../time-block-types";
  import { isWithDuration } from "../../util/time-block-utils";

  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- Svelte validates annotated component props.
  const { timeBlock }: { timeBlock: RemoteTimeBlock } = $props();
  const { taskScheduler, editTaskPreview, settingsSignal } =
    getObsidianContext();
  const duration = $derived(
    isWithDuration(timeBlock)
      ? timeBlock.durationMinutes
      : settingsSignal.current.defaultDurationMinutes,
  );

  function startDrag(event: DragEvent) {
    try {
      if (!taskScheduler || !timeBlock.taskSource || !event.dataTransfer)
        throw new Error(
          "Reopen the task account before dragging this preview.",
        );
      const task = taskScheduler.previewTask(timeBlock.taskSource);
      taskScheduler.drag.start(task, event.dataTransfer);
    } catch (error) {
      event.preventDefault();
      new Notice(
        error instanceof Error ? error.message : "Could not drag this task.",
      );
    }
  }

  function edit(event: MouseEvent) {
    event.stopPropagation();
    try {
      if (!editTaskPreview)
        throw new Error("Reopen the planner to edit this task.");
      editTaskPreview(timeBlock);
    } catch (error) {
      new Notice(
        error instanceof Error ? error.message : "Could not edit this task.",
      );
    }
  }
</script>

<div
  class="task-calendar-preview"
  aria-label={`${timeBlock.calendar.name} task: ${timeBlock.summary}`}
  draggable={Boolean(taskScheduler)}
  ondragend={() => taskScheduler?.drag.cancel()}
  ondragstart={startDrag}
  onpointerdown={(event) => event.stopPropagation()}
  role="group"
>
  <div class="task-preview-heading">
    {#if !timeBlock.isAllDayEvent}
      <span
        >{timeBlock.startTime.format(
          settingsSignal.current.timestampFormat,
        )}–{timeBlock.startTime
          .clone()
          .add(duration, "minutes")
          .format(settingsSignal.current.timestampFormat)}</span
      >
    {/if}
    <span class="task-preview-provider">{timeBlock.calendar.name}</span>
    <button class="task-preview-edit" onclick={edit} type="button"
      >{timeBlock.isAllDayEvent ? "Schedule" : "Edit schedule"}</button
    >
  </div>
  <div class="task-preview-title">{timeBlock.summary}</div>
</div>

<style>
  .task-calendar-preview {
    cursor: grab;

    overflow: hidden;

    width: 100%;
    height: 100%;
    padding: 3px 8px;

    border-left: 3px solid var(--interactive-accent);
  }

  .task-preview-heading {
    display: flex;
    flex-wrap: wrap;
    gap: 3px 8px;
    align-items: center;

    font-size: var(--font-smallest);
    color: var(--text-muted);
  }

  .task-preview-provider {
    text-transform: capitalize;
  }

  .task-preview-edit {
    height: auto;
    margin-left: auto;
    padding: 0 3px;

    font-size: inherit;
    color: var(--text-accent);

    background: transparent;
    border: 0;
    box-shadow: none;
  }

  .task-preview-title {
    overflow: hidden;
    font-weight: var(--font-semibold);
    text-overflow: ellipsis;
  }
</style>
