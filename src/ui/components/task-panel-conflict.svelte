<script lang="ts">
  import { onMount, onDestroy, tick } from "svelte";

  import type {
    TaskConflictChoices,
    TaskConflictController,
    TaskConflictDisplay,
  } from "../../tasks/conflict";
  import type { TaskSnapshot } from "../../tasks/types";
  import {
    taskConflictFieldName,
    taskConflictValue,
  } from "../task-conflict-values";

  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- Svelte validates annotated component props.
  let {
    controller,
    id,
    snapshot,
    saved,
    cancel,
  }: {
    controller: TaskConflictController<TaskConflictDisplay>;
    id: string;
    snapshot: TaskSnapshot | null;
    saved: () => void;
    cancel: () => void;
  } = $props();
  let review = $state<TaskConflictDisplay | null>(null);
  let choices = $state<TaskConflictChoices>({});
  let busy = $state(false);
  let error = $state("");
  let changed = $state(false);
  let closed = false;
  let form: HTMLFormElement;
  onDestroy(() => {
    closed = true;
  });
  const incomplete = $derived(
    !review || review.fields.some((field) => !choices[field.key]),
  );
  function setReview(value: TaskConflictDisplay) {
    review = value;
    choices = Object.fromEntries(
      value.fields
        .filter((field) => !field.conflict)
        .map((field) => [field.key, field.localAllowed ? "local" : "remote"]),
    );
  }
  async function load() {
    busy = true;
    error = "";
    try {
      const value = await controller.inspectConflict(id);
      if (!closed) setReview(value);
    } catch (failure) {
      if (!closed)
        error =
          failure instanceof Error
            ? failure.message
            : "Could not load the comparison. Try again.";
    } finally {
      if (!closed) {
        busy = false;
        await tick();
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- Unmount may run while the Svelte update is pending.
        if (!closed)
          form.querySelector<HTMLElement>("input:not(:disabled)")?.focus();
      }
    }
  }
  onMount(() => {
    void load();
  });
  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (!review || incomplete || busy) return;
    busy = true;
    error = "";
    try {
      const result = await controller.resolveConflict(review, choices);
      if (closed) return;
      if (result.kind === "changed") {
        setReview(result.review);
        changed = true;
      } else saved();
    } catch (failure) {
      if (!closed)
        error =
          failure instanceof Error
            ? failure.message
            : "Could not save these choices. Try again.";
    } finally {
      if (!closed) busy = false;
    }
  }
</script>

<form
  bind:this={form}
  class="task-panel-form task-comparison"
  aria-label="Review task changes"
  onsubmit={submit}
>
  <h3>Review changes</h3>
  {#if changed}<p class="task-form-context" role="status">
      The task changed. Review the refreshed values and choose again.
    </p>{/if}
  {#if review}<p class="task-form-context">{review.title}</p>
    {#if !review.current}<p class="task-form-context">
        Choosing Current Todoist discards the saved change for this unavailable
        task.
      </p>{/if}
    {#each review.fields as field (field.key)}
      <fieldset>
        <legend>{taskConflictFieldName(field)}</legend>
        <p class="task-original">
          <span>Original</span>{taskConflictValue(field.base, snapshot)}
        </p>
        <label
          class="task-choice"
          class:task-choice-selected={choices[field.key] === "local"}
          ><input
            name={`resolve-${field.key}`}
            disabled={!field.localAllowed || busy}
            type="radio"
            value="local"
            bind:group={choices[field.key]}
          /><span
            ><small>{review.localLabel ?? "Saved change"}</small><strong
              >{taskConflictValue(field.local, snapshot)}</strong
            ></span
          ></label
        >
        {#if !field.localAllowed}<p class="task-form-context">
            {field.localUnavailableReason ??
              "Review the current recurring occurrence before applying this change."}
          </p>{/if}
        <label
          class="task-choice"
          class:task-choice-selected={choices[field.key] === "remote"}
          ><input
            name={`resolve-${field.key}`}
            disabled={busy}
            type="radio"
            value="remote"
            bind:group={choices[field.key]}
          /><span
            ><small>Current Todoist</small><strong
              >{taskConflictValue(field.remote, snapshot)}</strong
            ></span
          ></label
        >
      </fieldset>
    {/each}
  {:else if busy}<p class="task-form-context" role="status">
      Loading current values…
    </p>{/if}
  {#if error}<p class="task-form-error" role="status">{error}</p>
    {#if !review}<button
        class="task-text-button"
        disabled={busy}
        onclick={load}
        type="button">Retry</button
      >{/if}{/if}
  <div class="task-form-actions">
    <button class="task-primary" disabled={busy || incomplete} type="submit"
      >{busy && review ? "Saving…" : "Apply choices"}</button
    ><button
      class="task-text-button"
      disabled={busy}
      onclick={cancel}
      type="button">Cancel</button
    >
  </div>
</form>
