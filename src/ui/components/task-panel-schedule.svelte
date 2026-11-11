<script lang="ts">
  import { DateTime } from "luxon";
  import { onMount, untrack } from "svelte";
  import { z } from "zod";

  import type { TaskScheduler } from "../../tasks/schedule";
  import {
    resolveScheduleInput,
    type ScheduleInterval,
  } from "../../tasks/schedule-types";
  import type { ProviderTask } from "../../tasks/types";

  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- Svelte validates annotated component props.
  let {
    scheduler,
    task,
    defaultDuration,
    initial,
    saved,
    cancel,
  }: {
    scheduler: TaskScheduler;
    task: ProviderTask;
    defaultDuration: number;
    initial?: ScheduleInterval;
    saved: () => void;
    cancel: () => void;
  } = $props();
  const finish = untrack(() => saved);
  const opened = untrack(() => ({
    task,
    projection: scheduler.projection(task.id),
    interval: initial ?? scheduler.projection(task.id)?.interval,
  }));
  const zone = DateTime.local().zoneName;
  const start = opened.interval
    ? DateTime.fromISO(opened.interval.start).setZone(zone)
    : DateTime.now().setZone(zone).startOf("hour").plus({ hours: 1 });
  let date = $state(start.toISODate() ?? "");
  let time = $state(start.toFormat("HH:mm"));
  let duration = $state(
    untrack(() =>
      opened.interval
        ? (Date.parse(opened.interval.end) -
            Date.parse(opened.interval.start)) /
          60_000
        : scheduler.duration(task, defaultDuration),
    ),
  );
  let offset = $state<string>(opened.interval ? String(start.offset) : "");
  const offsets = $derived(
    DateTime.fromISO(`${date}T${time}`, { zone }).getPossibleOffsets(),
  );
  let busy = $state(false);
  let error = $state("");
  let dateInput: HTMLInputElement;
  const id = crypto.randomUUID();
  onMount(() => dateInput.focus());
  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (busy) return;
    busy = true;
    error = "";
    try {
      await scheduler.schedule(
        opened.task.id,
        resolveScheduleInput(
          date,
          time,
          duration,
          zone,
          offset ? Number(offset) : undefined,
        ),
        id,
      );
      finish();
    } catch (failure) {
      error =
        failure instanceof z.ZodError
          ? (failure.issues[0]?.message ?? "Choose a valid schedule.")
          : failure instanceof Error
            ? failure.message
            : "Could not save this schedule. Try again.";
    } finally {
      busy = false;
    }
  }
</script>

<form class="task-panel-form" aria-label="Schedule task" onsubmit={submit}>
  <div class="task-form-heading">
    <h3>{opened.projection?.interval ? "Move schedule" : "Schedule task"}</h3>
  </div>
  <p class="task-form-context">{task.title}</p>
  <label
    >Date<input
      bind:this={dateInput}
      aria-label="Schedule date"
      disabled={busy}
      oninput={() => {
        offset = "";
      }}
      required
      type="date"
      bind:value={date}
    /></label
  >
  <div class="task-form-grid">
    <label
      >Start<input
        aria-label="Schedule start"
        disabled={busy}
        oninput={() => {
          offset = "";
        }}
        required
        type="time"
        bind:value={time}
      /></label
    >
    <label
      >Minutes<input
        aria-label="Schedule duration"
        disabled={busy}
        max="1440"
        min="1"
        required
        step="1"
        type="number"
        bind:value={duration}
      /></label
    >
  </div>
  <p class="task-form-context">{zone}</p>
  {#if offsets.length > 1}<label
      >Time offset<select
        aria-label="Time offset"
        disabled={busy}
        bind:value={offset}
        ><option value="">Choose an offset</option
        >{#each offsets as choice (choice.offset)}<option
            value={String(choice.offset)}>UTC{choice.toFormat("ZZ")}</option
          >{/each}</select
      ></label
    >{/if}
  {#if error}<p class="task-form-error" role="status">{error}</p>{/if}
  <div class="task-form-actions">
    <button class="task-primary" disabled={busy} type="submit"
      >{busy
        ? "Saving…"
        : opened.projection?.interval
          ? "Move schedule"
          : "Schedule"}</button
    ><button
      class="task-text-button"
      disabled={busy}
      onclick={cancel}
      type="button">Cancel</button
    >
  </div>
</form>
