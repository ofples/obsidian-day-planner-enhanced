<script lang="ts">
  import { CalendarDays, ListTodo, X } from "lucide-svelte";
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
      await service.signIn(true);
    } catch (error) {
      todoistError =
        error instanceof Error
          ? error.message
          : "Could not sign in to Todoist.";
    } finally {
      todoistBusy = false;
    }
  }
  function signOutGoogle() {
    try {
      calendar.disconnect();
      googleConnected = calendar.isConnected();
    } catch (error) {
      googleError =
        error instanceof Error
          ? error.message
          : "Could not sign out of Google.";
    }
  }
  function signOutTodoist() {
    try {
      service.disconnect();
    } catch (error) {
      todoistError =
        error instanceof Error
          ? error.message
          : "Could not sign out of Todoist.";
    }
  }
</script>

<section class="dp-task-panel planner-connections" aria-label="Connections">
  <header>
    <h2>Connections</h2>
    <button
      class="close-button"
      aria-label="Close connections"
      onclick={close}
      type="button"><X size={18} /></button
    >
  </header>
  <div class="connection-card">
    <span class="account-icon google-icon"><CalendarDays size={19} /></span>
    <div class="account-info">
      <h3>Google Calendar</h3>
      <p>{googleConnected ? "Connected" : "Not connected"}</p>
    </div>
    <button
      bind:this={firstButton}
      class:connected={googleConnected}
      aria-busy={googleBusy}
      aria-label={googleConnected
        ? "Sign out of Google Calendar"
        : "Sign in with Google"}
      disabled={googleBusy}
      onclick={googleConnected ? signOutGoogle : signInGoogle}
      type="button"
      >{googleBusy
        ? "Signing in…"
        : googleConnected
          ? "Sign out"
          : "Sign in with Google"}</button
    >
    {#if googleError}<p class="connection-error" role="alert">
        {googleError}
      </p>{/if}
  </div>
  <div class="connection-card">
    <span class="account-icon todoist-icon"><ListTodo size={19} /></span>
    <div class="account-info">
      <h3>Todoist</h3>
      <p>
        {#if $taskState.connected}{`Connected${$taskState.snapshot?.account.name ? ` as ${$taskState.snapshot.account.name}` : ""}`}{:else}Not
          connected{/if}
      </p>
    </div>
    <button
      class:connected={$taskState.connected}
      aria-busy={todoistBusy}
      aria-label={$taskState.connected
        ? "Sign out of Todoist"
        : "Sign in with Todoist"}
      disabled={todoistBusy}
      onclick={$taskState.connected ? signOutTodoist : signInTodoist}
      type="button"
      >{todoistBusy
        ? "Signing in…"
        : $taskState.connected
          ? "Sign out"
          : "Sign in with Todoist"}</button
    >
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

  h3 {
    font-size: 13px;
    font-weight: 600;
  }

  .connection-card {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    gap: var(--size-4-2);
    align-items: center;

    padding: var(--size-4-3);

    border: 1px solid var(--tp-border);
    border-radius: var(--radius-m);
  }

  .account-icon {
    display: grid;
    place-items: center;

    width: 34px;
    height: 34px;

    color: var(--tp-accent);

    background: var(--tp-surface);
    border-radius: var(--radius-s);
  }

  .todoist-icon {
    color: var(--color-red);
  }

  .account-info {
    min-width: 0;
  }

  .connection-card button {
    color: var(--tp-text);
    background: var(--tp-accent-bg);
  }

  .connection-card button.connected {
    color: var(--tp-muted);
    background: var(--tp-surface);
  }

  .connection-error {
    grid-column: 2 / -1;
  }

  .close-button {
    padding: 4px;
    background: transparent;
    box-shadow: none;
  }

  .connection-card p {
    margin-top: 3px;
    font-size: 11px;
    color: var(--tp-muted);
    overflow-wrap: anywhere;
  }

  .connection-card .connection-error {
    color: var(--text-error);
  }
</style>
