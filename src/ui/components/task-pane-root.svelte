<script lang="ts">
  import type { ComponentProps } from "svelte";
  import { readable, type Readable } from "svelte/store";

  import type { DayPlannerSettings } from "../../settings";
  import type { CaptureCandidate } from "../../tasks/capture-parser";
  import type { NoteTaskDrag } from "../../tasks/note-drag";
  import type { ProviderTask } from "../../tasks/types";

  import SimpleTasksPane from "./simple-tasks-pane.svelte";
  import TasksPane from "./tasks-pane.svelte";

  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- Svelte validates annotated component props.
  let {
    noteTasks,
    noteDrag,
    openConnections,
    scheduleImported,
    openNote,
    ...legacy
  }: ComponentProps<typeof TasksPane> & {
    noteTasks?: Readable<CaptureCandidate[]>;
    noteDrag?: NoteTaskDrag;
    openConnections?: () => void;
    scheduleImported?: (task: ProviderTask) => void;
    openNote?: (path: string, line: number) => void;
  } = $props();
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- Svelte validates the annotated derived store.
  const settings: Readable<DayPlannerSettings | undefined> = $derived(
    legacy.settings ?? readable<DayPlannerSettings | undefined>(undefined),
  );
  // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- svelte-check verifies the auto-subscribed store type.
  const simpleMode = $derived(
    Boolean(legacy.settings && !$settings?.experimentalTodoistSync),
  );
</script>

{#if simpleMode}
  <SimpleTasksPane
    connections={openConnections}
    {noteDrag}
    {noteTasks}
    openNote={openNote ?? (() => {})}
    preferences={legacy.preferences}
    schedule={scheduleImported ?? (() => {})}
    scheduler={legacy.scheduler}
    service={legacy.service}
  />
{:else}
  <TasksPane {...legacy} />
{/if}
