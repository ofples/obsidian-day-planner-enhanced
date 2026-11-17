<script lang="ts">
  import { EllipsisVertical, LoaderCircle } from "lucide-svelte";
  import { Menu } from "obsidian";
  import { readable } from "svelte/store";

  import { getDateRangeContext } from "../../context/date-range-context";
  import { getIsInSidebarContext } from "../../context/is-in-sidebar-context";
  import { getObsidianContext } from "../../context/obsidian-context";
  import { settingsStore } from "../../global-store/settings";
  import { getFullWeek } from "../../util/range";
  import { addTimelineViewMenuItems } from "../timeline-view-menu";

  import ControlButton from "./control-button.svelte";
  import DayOfWeekPicker from "./day-of-week-picker.svelte";
  import { ChevronLeft, ChevronRight } from "./lucide";
  import PlannerDayCount from "./planner-day-count.svelte";

  const {
    openAiPlanning,
    exportSchedule,
    workspaceFacade,
    periodicNotes,
    reSync,
    googleSyncing = readable(false),
    googleConflictCount = readable(0),
    forceSyncNote,
    openReviewSyncConflicts,
    initWeeklyView,
    openTimelineSettingsModal,
  } = getObsidianContext();
  const dateRange = getDateRangeContext();
  const isInSidebar = getIsInSidebarContext();

  const selectedDay = $derived(dateRange.first);
  const week = $derived(
    getFullWeek(selectedDay, $settingsStore.firstDayOfWeek),
  );

  function goToToday() {
    dateRange.set([window.moment()]);
  }

  function goBack() {
    dateRange.set([selectedDay.clone().subtract(1, "day")]);
  }

  function goForward() {
    dateRange.set([selectedDay.clone().add(1, "day")]);
  }

  async function goToNoteForDay(day: typeof selectedDay) {
    const note = await periodicNotes.createDailyNoteIfNeeded(day);

    await workspaceFacade.openFileInEditor(note);
  }

  async function handleDayClick(day: typeof selectedDay) {
    if (day.isSame(selectedDay, "day")) {
      await goToNoteForDay(day);

      return;
    }

    dateRange.set([day]);
  }

  function handleMenuClick(event: MouseEvent) {
    const menu = new Menu();

    addTimelineViewMenuItems(menu, {
      exportSchedule,
      reSync,
      openReviewSyncConflicts,
      forceSyncNote,
      initWeeklyView,
      openTimelineSettingsModal,
      settingsStore,
      openFileForDay: (day) => workspaceFacade.openFileForDay(day),
      getSelectedDay: () => selectedDay,
    });

    menu.showAtMouseEvent(event);
  }
</script>

<div class="controls planner-timeline-controls">
  <div class="header">
    <div class="buttons-left">
      <ControlButton label="Go to previous day" onclick={goBack}>
        <ChevronLeft />
      </ControlButton>
      <ControlButton
        classes="today-button"
        label="Go to today"
        onclick={goToToday}>Today</ControlButton
      >
      <ControlButton label="Go to next day" onclick={goForward}>
        <ChevronRight />
      </ControlButton>
    </div>

    {#if $isInSidebar}
      <div class="period">{selectedDay.format("MMM YYYY")}</div>
    {/if}
    <div class="buttons-right">
      {#if openAiPlanning}
        <ControlButton label="Plan with AI" onclick={openAiPlanning}
          >Plan</ControlButton
        >
      {/if}
      <PlannerDayCount />
      {#if $isInSidebar}
        <button
          class="clickable-icon sync-button"
          aria-busy={$googleSyncing}
          aria-label="Sync"
          onclick={reSync}
          type="button"
        >
          {#if $googleSyncing}<LoaderCircle
              class="is-spinning svg-icon"
            />{:else}Sync{/if}
        </button>
        <ControlButton label="More options" onclick={handleMenuClick}>
          <EllipsisVertical class="svg-icon" />
        </ControlButton>
      {/if}
      {#if $googleConflictCount > 0}
        <button
          class="sync-conflicts clickable-icon"
          aria-label={`Review ${$googleConflictCount} calendar sync conflicts`}
          onclick={openReviewSyncConflicts}
          title={`Review ${$googleConflictCount} calendar sync conflicts`}
          type="button"
        >
          <span class="conflict-dot" aria-hidden="true"></span>
          {$googleConflictCount}
        </button>
      {/if}
    </div>
  </div>

  <DayOfWeekPicker onDayClick={handleDayClick} {selectedDay} {week} />
</div>

<style>
  .sync-conflicts {
    gap: 4px;
    font-size: var(--font-ui-small);
    color: var(--text-error);
  }

  .conflict-dot {
    width: 7px;
    height: 7px;
    background: var(--text-error);
    border-radius: 50%;
  }

  :global(.mod-error) {
    color: var(--text-error);
  }

  .buttons-right,
  .buttons-left {
    display: flex;
    align-items: center;
  }

  .header,
  .buttons-left,
  .buttons-right {
    gap: var(--size-2-1);
  }

  .header {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);
    align-items: center;
    padding-right: var(--size-4-3);
  }

  .buttons-right {
    grid-column: 3;
    justify-self: end;
  }

  .period {
    justify-self: center;

    font-family: var(--file-header-font);
    font-size: var(--file-header-font-size);
    font-weight: var(--font-medium);
    color: var(--text-muted);
    white-space: nowrap;
  }

  .buttons-left :global(.today-button) {
    font-size: var(--font-ui-small);
    font-weight: var(--font-medium);
    color: var(--text-muted);
  }

  .controls {
    container-type: inline-size;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    gap: var(--size-4-2);

    padding: var(--size-4-2) 0 var(--size-4-2) var(--size-4-3);

    font-size: var(--font-ui-small);
  }

  @container (width <= 420px) {
    .header {
      display: flex;
      flex-wrap: wrap;
      justify-content: space-between;
    }

    .buttons-right {
      flex-basis: 100%;
      justify-content: flex-end;
    }
  }
</style>
