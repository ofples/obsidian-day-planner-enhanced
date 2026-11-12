<script lang="ts">
  import { onMount, untrack } from "svelte";

  import type {
    TaskIdentitySourceRepairController,
    TaskSourceRepairReview,
  } from "../../tasks/identity-source-repair";
  import { identitySourceKey } from "../../tasks/source";

  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- Svelte validates annotated component props.
  let {
    controller,
    id,
    writable = true,
    saved,
    cancel,
    setBusy,
  }: {
    controller: TaskIdentitySourceRepairController;
    id: string;
    writable?: boolean;
    saved: () => void;
    cancel: () => void;
    setBusy?: (value: boolean) => void;
  } = $props();
  const opened = untrack(() => ({ controller, id, saved }));
  let review: TaskSourceRepairReview | null = $state(null),
    selected: Record<string, string> = $state({}),
    loading = $state(true),
    busy = $state(false),
    error = $state("");
  let closed = false;
  const local = $derived.by(
    () =>
      review?.retained.filter(
        (source) =>
          !Object.values(selected).includes(identitySourceKey(source)),
      ) ?? [],
  );
  async function load() {
    loading = true;
    error = "";
    try {
      const value = await opened.controller.review(opened.id);
      if (!closed) {
        review = value;
        selected = value.selected;
      }
    } catch (failure) {
      if (!closed)
        error =
          failure instanceof Error
            ? failure.message
            : "Could not review the saved source links.";
    } finally {
      if (!closed) loading = false;
    }
  }
  onMount(() => {
    void load();
    return () => {
      closed = true;
    };
  });
  function choose(uid: string, key: string) {
    if (!review) return;
    selected = {
      ...selected,
      ...(key
        ? opened.controller.suggestTree(review, uid, key)
        : { [uid]: "" }),
    };
  }
  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (!review || busy || !writable) return;
    busy = true;
    setBusy?.(true);
    error = "";
    try {
      const result = await opened.controller.confirm(review, selected);
      if (closed) return;
      if (result.kind === "changed") {
        review = result.review;
        selected = {};
        error =
          "The recovery or note blocks changed. Review every selected source and confirm again.";
      } else opened.saved();
    } catch (failure) {
      if (!closed)
        error =
          failure instanceof Error
            ? failure.message
            : "Could not save the repaired source links.";
    } finally {
      if (!closed) busy = false;
      setBusy?.(false);
    }
  }
</script>

<form
  class="task-panel-form"
  aria-label="Repair copied task sources"
  onsubmit={submit}
>
  <h3>Repair selected sources</h3>
  <p class="task-form-context">
    Choose the note block for each saved copied task. Recovery keeps its task
    details and parent relationships. Later note edits reconcile when the tree
    finishes.
  </p>
  {#if loading}<p class="task-form-context" role="status">
      Reading current sources…
    </p>
  {:else if review}
    {#each review.decision.assignments.filter((item) => item.kind === "create") as assignment (assignment.uid)}
      <label
        >{assignment.draft!.title}
        <span class="task-form-context"
          >{review.links[assignment.uid]?.taskId
            ? "Task created"
            : "Awaiting creation"}</span
        >
        <select
          aria-label={`Recovery source for ${assignment.draft!.title}`}
          disabled={busy}
          onchange={(event) =>
            choose(assignment.uid, event.currentTarget.value)}
          required
          value={selected[assignment.uid] ?? ""}
        >
          <option value="">Choose a note block</option>
          {#each review.candidates as source (identitySourceKey(source))}<option
              value={identitySourceKey(source)}
              >{source.path} · line {source.line + 1} · {source.title}</option
            >{/each}
        </select>
      </label>
    {/each}
    {#if local.length}<details class="task-form-context">
        <summary>Other reviewed blocks stay local</summary>
        {#each local as source (identitySourceKey(source))}<p>
            {source.path} · line {source.line + 1} · {source.title}
          </p>{/each}
      </details>{/if}
    {#if review.cached}<p class="task-form-context">
        Using cached task details. Saved provider commands are verified when the
        connection resumes.
      </p>{/if}
  {/if}
  {#if error}<p class="task-form-error" role="status">{error}</p>{/if}
  <div class="task-form-actions">
    {#if review}<button
        class="task-primary"
        disabled={busy || !writable}
        type="submit"
        >{busy ? "Saving source repair…" : "Save sources and retry"}</button
      >
    {:else if !loading}<button
        class="task-text-button"
        onclick={load}
        type="button">Retry source review</button
      >{/if}
    <button
      class="task-text-button"
      disabled={busy}
      onclick={cancel}
      type="button">Cancel source repair</button
    >
  </div>
</form>
