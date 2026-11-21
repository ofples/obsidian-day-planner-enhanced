<script lang="ts">
  import type { ComponentProps } from "svelte";
  import { readable, type Readable, type Writable } from "svelte/store";

  import type { AiPlanningService } from "../../ai-scheduling/service";
  import type { DayPlannerSettings } from "../../settings";
  import { switchTaskSource, type TaskViewState } from "../../tasks/browser";
  import type { CaptureCandidate } from "../../tasks/capture-parser";
  import type { NoteCollectionsPort } from "../../tasks/note-collections";
  import type { NoteTaskDrag } from "../../tasks/note-drag";
  import type { TaskScheduler } from "../../tasks/schedule";
  import type { TaskSource } from "../../tasks/source";
  import type { TaskSourceCollection } from "../../tasks/source-collection";
  import {
    taskSourceChoices,
    type TaskPaneSource,
  } from "../../tasks/source-settings";
  import type { TaskSourceReference } from "../../tasks/source-types";
  import type { ProviderTask } from "../../tasks/types";

  import AiPlanningPanel from "./ai-planning-panel.svelte";
  import SimpleTasksPane from "./simple-tasks-pane.svelte";
  import TasksPane from "./tasks-pane.svelte";

  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- Svelte validates annotated component props.
  let {
    noteTasks,
    noteDrag,
    noteCollections,
    noteContext,
    resolveImported,
    openConnections,
    scheduleImported,
    addToNote,
    openNote,
    planning,
    sources,
    ...legacy
  }: ComponentProps<typeof TasksPane> & {
    noteTasks?: Readable<CaptureCandidate[]>;
    noteDrag?: NoteTaskDrag;
    noteCollections?: NoteCollectionsPort;
    noteContext?: Readable<{ currentPath: string; targetPath: string }>;
    resolveImported?: (uid: string) => TaskSource | undefined;
    openConnections?: () => void;
    scheduleImported?: (
      task: ProviderTask,
      reference?: TaskSourceReference,
    ) => void;
    addToNote?: (
      task: ProviderTask,
      reference?: TaskSourceReference,
    ) => Promise<void>;
    openNote?: (path: string, line: number) => void;
    planning?: AiPlanningService;
    sources?: TaskSourceCollection;
  } = $props();
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- Svelte validates the annotated derived store.
  const settings: Readable<DayPlannerSettings | undefined> = $derived(
    legacy.settings ?? readable<DayPlannerSettings | undefined>(undefined),
  );
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access -- svelte-check verifies the annotated legacy component props.
  const viewPreferences: Writable<TaskViewState> = $derived(legacy.preferences);
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access -- svelte-check verifies the annotated legacy component props.
  const sourceScheduler: TaskScheduler | undefined = $derived(legacy.scheduler);
  // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- svelte-check verifies the legacy component props.
  const simpleMode = $derived(
    Boolean(
      legacy.settings &&
        (!$settings?.experimentalTodoistSync ||
          ($viewPreferences.source ?? "todoist") !== "todoist"),
    ),
  );
  const planningVisible = $derived(planning?.visible ?? readable(false));
</script>

<div class="tasks-root">
  {#if planning}<AiPlanningPanel planner={planning} />{/if}
  {#if !$planningVisible && simpleMode}
    <SimpleTasksPane
      {addToNote}
      completeTask={legacy.completeTask}
      connections={openConnections}
      {noteCollections}
      {noteContext}
      {noteDrag}
      {noteTasks}
      openNote={openNote ?? (() => {})}
      {planning}
      preferences={legacy.preferences}
      {resolveImported}
      schedule={scheduleImported ?? (() => {})}
      scheduler={legacy.scheduler}
      service={legacy.service}
      {sources}
      weakCompletionEnabled={Boolean($settings?.weakTodoistSync)}
    />
  {:else if !$planningVisible}
    {#if sources}<label class="legacy-source-picker"
        >Source<select
          aria-label="Task source"
          onchange={(event: Event & { currentTarget: HTMLSelectElement }) => {
            sourceScheduler?.drag.cancel();
            $viewPreferences = switchTaskSource(
              $viewPreferences,
              event.currentTarget.value as TaskPaneSource,
            );
          }}
          value={$viewPreferences.source ?? "todoist"}
          >{#each taskSourceChoices as choice}<option value={choice.id}
              >{choice.label}</option
            >{/each}</select
        ></label
      >{/if}
    {#if planning}<button
        class="legacy-plan-button"
        onclick={() => planning.show()}>Plan</button
      >{/if}
    <TasksPane {...legacy} />
  {/if}
</div>

<style>
  .tasks-root {
    overflow: hidden;
    display: flex;
    flex-direction: column;

    height: 100%;
    min-height: 0;
  }

  .legacy-plan-button {
    align-self: flex-end;
    margin: 8px;
  }

  .legacy-source-picker {
    display: flex;
    gap: 8px;
    align-items: center;
    margin: 8px;
  }
</style>
