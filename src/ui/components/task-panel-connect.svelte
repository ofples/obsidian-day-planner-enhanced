<script lang="ts">
  import { onMount, tick, untrack } from "svelte";
  import { get } from "svelte/store";

  import type { TaskService } from "../../tasks/service";

  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- Svelte validates annotated component props.
  let {
    service,
    saved,
    cancel,
  }: { service: TaskService; saved: () => void; cancel: () => void } = $props();
  let token = $state("");
  const finish = untrack(() => saved);
  let replaceAccount = $state(false);
  let busy = $state(false);
  let error = $state("");
  const browserState = $derived(service.state);
  let editConnection = $state(untrack(() => !get(service.state).connected));
  let tokenInput = $state<HTMLInputElement>();
  let form: HTMLFormElement;
  onMount(() => (tokenInput ?? form.querySelector("button"))?.focus());
  async function edit() {
    editConnection = true;
    await tick();
    tokenInput?.focus();
  }
  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (busy) return;
    busy = true;
    error = "";
    try {
      await service.connect(token, replaceAccount);
      token = "";
      finish();
    } catch {
      error =
        get(service.state).error ||
        "Enter a valid Todoist API token and try again.";
    } finally {
      busy = false;
    }
  }
</script>

<form
  bind:this={form}
  class="task-panel-form"
  aria-label="Connect Todoist"
  onsubmit={submit}
>
  <h3>{$browserState.connected ? "Todoist connection" : "Connect Todoist"}</h3>
  {#if $browserState.connected && $browserState.snapshot}<div
      class="task-connected-account"
    >
      <p class="task-form-context">Connected account</p>
      <strong>{$browserState.snapshot.account.name}</strong><button
        class="task-text-button"
        onclick={() => {
          service.disconnect();
          saved();
        }}
        type="button">Disconnect</button
      >
    </div>{/if}
  {#if editConnection}
    <p class="task-form-context">
      Read and update your tasks beside your schedule.
    </p>
    <label
      >API token<input
        bind:this={tokenInput}
        aria-label="Todoist API token"
        autocomplete="off"
        disabled={busy}
        required
        type="password"
        bind:value={token}
      /></label
    >
    <a
      class="task-link"
      href="https://app.todoist.com/app/settings/integrations/developer"
      rel="noopener noreferrer"
      target="_blank">Find your API token</a
    >
    {#if $browserState.snapshot}<label class="task-check-label"
        ><input
          class="task-checkbox"
          disabled={busy}
          type="checkbox"
          bind:checked={replaceAccount}
        />Switch to a different account</label
      >{/if}
    {#if error}<p class="task-form-error" role="status">{error}</p>{/if}
  {/if}
  <div class="task-form-actions">
    {#if editConnection}<button
        class="task-primary"
        disabled={busy}
        type="submit">{busy ? "Connecting…" : "Connect"}</button
      >{:else}<button class="task-text-button" onclick={edit} type="button"
        >Reconnect or switch account</button
      >{/if}<button
      class="task-text-button"
      disabled={busy}
      onclick={cancel}
      type="button">Cancel</button
    >
  </div>
</form>
