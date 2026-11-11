<script lang="ts">
  import { onDestroy, onMount, untrack } from "svelte";
  import { get, type Writable } from "svelte/store";

  import type { GoogleCalendarSync } from "../../google-calendar/service";
  import type { DayPlannerSettings } from "../../settings";
  import {
    taskAccountKey,
    taskAccountSettings,
  } from "../../tasks/capture-settings";
  import type { TaskService } from "../../tasks/service";

  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- Svelte validates annotated component props.
  let {
    service,
    calendar,
    settings,
    saved,
    cancel,
  }: {
    service: TaskService;
    calendar: Pick<GoogleCalendarSync, "calendars">;
    settings: Writable<DayPlannerSettings>;
    saved: () => void;
    cancel: () => void;
  } = $props();
  const opened = untrack(() => ({
    snapshot: get(service.state).snapshot,
    config: structuredClone(get(settings)),
  }));
  const account = opened.snapshot
    ? taskAccountSettings(opened.config.taskCapture, opened.snapshot)
    : null;
  const policy = account?.calendarDisplay;
  let enabled = $state(policy?.enabled ?? false);
  let syncTaskDate = $state(account?.syncScheduleToTaskDate !== false);
  let googleIds = $state([...(policy?.googleCalendarIds ?? [])]);
  let icalUrls = $state([...(policy?.icalUrls ?? [])]);
  let calendars = $state(
    (policy?.googleCalendarIds ?? []).map((id) => ({
      id,
      summary: "Saved Google calendar",
    })),
  );
  const feeds = [
    ...new Map([
      ...opened.config.icals.map((feed) => [feed.url, feed.name] as const),
      ...(policy?.icalUrls ?? [])
        .filter((url) => !opened.config.icals.some((feed) => feed.url === url))
        .map((url) => [url, "Unavailable saved internet calendar"] as const),
    ]),
  ].map(([url, name]) => ({ url, name }));
  let loading = $state(false);
  let loaded = $state(false);
  let error = $state("");
  let closed = false;
  let form: HTMLFormElement;
  onMount(() => form.querySelector<HTMLElement>("input, button")?.focus());
  onDestroy(() => {
    closed = true;
  });

  function currentAccount() {
    const current = get(service.state).snapshot;
    if (
      !opened.snapshot ||
      current?.provider !== opened.snapshot.provider ||
      current.account.id !== opened.snapshot.account.id
    )
      throw new Error("Reopen task calendar settings for the current account.");
    return opened.snapshot;
  }
  async function loadCalendars() {
    if (loading) return;
    loading = true;
    error = "";
    try {
      currentAccount();
      const available = await calendar.calendars();
      if (closed) return;
      currentAccount();
      calendars = [
        ...available,
        ...googleIds
          .filter((id) => !available.some((item) => item.id === id))
          .map((id) => ({ id, summary: "Unavailable saved Google calendar" })),
      ];
      loaded = true;
    } catch (failure) {
      if (!closed)
        error =
          failure instanceof Error
            ? failure.message
            : "Connect Google Calendar, then load calendars again.";
    } finally {
      loading = false;
    }
  }
  function submit(event: SubmitEvent) {
    event.preventDefault();
    error = "";
    try {
      const snapshot = currentAccount();
      settings.update((value) => ({
        ...value,
        taskCapture: {
          ...value.taskCapture,
          accounts: {
            ...value.taskCapture.accounts,
            [taskAccountKey(snapshot)]: {
              ...taskAccountSettings(value.taskCapture, snapshot),
              syncScheduleToTaskDate: syncTaskDate,
              calendarDisplay: {
                enabled,
                googleCalendarIds: googleIds,
                icalUrls,
              },
            },
          },
        },
      }));
      saved();
    } catch (failure) {
      error =
        failure instanceof Error
          ? failure.message
          : "Could not save task calendar settings.";
    }
  }
</script>

<form
  bind:this={form}
  class="task-panel-form"
  aria-label="Task calendar feeds"
  onsubmit={submit}
>
  <h3>Task calendars</h3>
  {#if opened.snapshot}
    <label class="task-check-label"
      ><input
        class="task-toggle"
        role="switch"
        type="checkbox"
        bind:checked={syncTaskDate}
      />Sync schedule start to task date</label
    >
    <p class="task-form-context">
      The planner keeps the full time range when Todoist duration is
      unavailable.
    </p>
    <label class="task-check-label"
      ><input
        class="task-toggle"
        role="switch"
        type="checkbox"
        bind:checked={enabled}
      />Hide selected task feeds</label
    >
    <p class="task-form-context">
      Selected feeds are hidden while this task account is connected.
      Disconnecting restores their display.
    </p>
    <fieldset class="task-routing-projects">
      <legend>Google calendars</legend>
      <button
        class="task-text-button"
        disabled={loading}
        onclick={loadCalendars}
        type="button"
        >{loading ? "Loading calendars…" : "Load calendars"}</button
      >
      {#each calendars as item (item.id)}
        <label class="task-check-label"
          ><input type="checkbox" value={item.id} bind:group={googleIds} /><span
            >{item.summary}<br /><span class="task-form-context">{item.id}</span
            ></span
          ></label
        >
      {/each}
      {#if loaded && !calendars.length}<p
          class="task-form-context"
          role="status"
        >
          No Google calendars are available.
        </p>{/if}
    </fieldset>
    {#if feeds.length}<fieldset class="task-routing-projects">
        <legend>Internet calendars</legend>
        {#each feeds as feed (feed.url)}
          <label class="task-check-label"
            ><input
              type="checkbox"
              value={feed.url}
              bind:group={icalUrls}
            />{feed.name}</label
          >
        {/each}
      </fieldset>{/if}
    {#if error}<p class="task-form-error" role="status">{error}</p>{/if}
    <div class="task-form-actions">
      <button class="task-primary" disabled={loading} type="submit"
        >Save settings</button
      ><button class="task-text-button" onclick={cancel} type="button"
        >Cancel</button
      >
    </div>
  {:else}<p class="task-form-context">
      Connect a task account to configure its calendar feeds.
    </p>
    <button class="task-text-button" onclick={cancel} type="button"
      >Close</button
    >{/if}
</form>
