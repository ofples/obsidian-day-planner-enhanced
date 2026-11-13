<script lang="ts">
  import { onMount, untrack } from "svelte";

  import type { GoogleCalendarSync } from "../../google-calendar/service";
  import type { TaskService } from "../../tasks/service";

  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- Svelte validates annotated component props.
  const {
    service,
    calendar,
    close,
  }: { service: TaskService; calendar: GoogleCalendarSync; close: () => void } =
    $props();
  const taskState = untrack(() => service.state);
  let googleConnected = $state(untrack(() => calendar.isConnected()));
  let googleBusy = $state(false);
  let todoistBusy = $state(false);
  let googleError = $state("");
  let todoistError = $state("");
  let replaceAccount = $state(false);
  let firstButton: HTMLButtonElement;
  onMount(() => firstButton.focus());

  async function signInGoogle() {
    if (googleBusy) return;
    googleBusy = true;
    googleError = "";
    try {
      await calendar.connect(true);
      googleConnected = calendar.isConnected();
    } catch (error) {
      googleError =
        error instanceof Error ? error.message : "Could not sign in to Google.";
    } finally {
      googleBusy = false;
    }
  }
  async function signInTodoist() {
    if (todoistBusy) return;
    todoistBusy = true;
    todoistError = "";
    try {
      await service.signIn(replaceAccount);
    } catch (error) {
      todoistError =
        error instanceof Error
          ? error.message
          : "Could not sign in to Todoist.";
    } finally {
      todoistBusy = false;
    }
  }
</script>

<section class="planner-connections" aria-label="Connections">
  <header>
    <h2>Connections</h2>
    <button aria-label="Close connections" onclick={close} type="button"
      >Close</button
    >
  </header>
  <div class="connection-card">
    <h3>Google Calendar</h3>
    <p>
      {googleConnected
        ? "Connected"
        : "Connect your calendar to see events and sync your schedule."}
    </p>
    <button
      bind:this={firstButton}
      aria-busy={googleBusy}
      disabled={googleBusy}
      onclick={signInGoogle}
      type="button">{googleBusy ? "Signing in…" : "Sign in with Google"}</button
    >
    {#if googleError}<p class="connection-error" role="alert">
        {googleError}
      </p>{/if}
  </div>
  <div class="connection-card">
    <h3>Todoist</h3>
    <p>
      {#if $taskState.connected}{`Connected${$taskState.snapshot?.account.name ? ` as ${$taskState.snapshot.account.name}` : ""}`}{:else}Connect
        Todoist to see your tasks.{/if}
    </p>
    <button
      aria-busy={todoistBusy}
      disabled={todoistBusy}
      onclick={signInTodoist}
      type="button"
      >{todoistBusy ? "Signing in…" : "Sign in with Todoist"}</button
    >
    {#if $taskState.snapshot}<label
        ><input
          disabled={todoistBusy}
          type="checkbox"
          bind:checked={replaceAccount}
        />Switch to a different Todoist account</label
      >{/if}
    {#if todoistError}<p class="connection-error" role="alert">
        {todoistError}
      </p>{/if}
  </div>
</section>

<style>
  .planner-connections {
    display: grid;
    gap: var(--size-4-3);
    padding: var(--size-4-3);
  }

  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  h2,
  h3,
  p {
    margin: 0;
  }

  .connection-card {
    display: grid;
    gap: var(--size-4-2);
    justify-items: start;

    padding: var(--size-4-3);

    border: 1px solid var(--background-modifier-border);
    border-radius: var(--radius-m);
  }

  .connection-card p {
    color: var(--text-muted);
  }

  .connection-card .connection-error {
    color: var(--text-error);
  }
</style>
