<script lang="ts">
  import { onMount, untrack } from "svelte";

  import type {
    TaskDeletionController,
    TaskDeletionReview,
  } from "../../tasks/deletion";

  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- Svelte validates annotated component props.
  let {
    controller,
    taskId,
    replaces,
    confirm,
    saved,
    cancel,
  }: {
    controller: TaskDeletionController;
    taskId: string;
    replaces?: string;
    confirm: TaskDeletionController["confirm"];
    saved: (id: string) => void;
    cancel: () => void;
  } = $props();
  const opened = untrack(() => ({
    controller,
    taskId,
    replaces,
    confirm,
    saved,
  }));
  let review: TaskDeletionReview | null = $state(null);
  let loading = $state(true),
    busy = $state(false),
    error = $state("");
  let closed = false;
  const noteCount = $derived.by(
    () =>
      new Set(
        Object.values(review?.record.links ?? {}).map(
          (link) => link.source.path,
        ),
      ).size,
  );
  async function load() {
    loading = true;
    error = "";
    try {
      const value = await opened.controller.review(
        opened.taskId,
        opened.replaces,
      );
      if (!closed) review = value;
    } catch (failure) {
      if (!closed)
        error =
          failure instanceof Error
            ? failure.message
            : "Could not load the task deletion confirmation.";
    } finally {
      loading = false;
    }
  }
  onMount(() => {
    void load();
    return () => {
      closed = true;
    };
  });
  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (!review || busy) return;
    busy = true;
    error = "";
    try {
      const result = await opened.confirm(review);
      if (closed) return;
      if (result.kind === "changed") {
        review = result.review;
        error =
          "The task tree or linked notes changed. Review these details and confirm again.";
      } else opened.saved(result.id);
    } catch (failure) {
      if (!closed)
        error =
          failure instanceof Error
            ? failure.message
            : "Could not save this deletion. Review its task and notes.";
    } finally {
      busy = false;
    }
  }
</script>

<form
  class="task-panel-form"
  aria-label="Confirm task deletion"
  onsubmit={submit}
>
  <h3>Delete task permanently?</h3>
  {#if loading}<p class="task-form-context" role="status">
      Loading task details…
    </p>{:else if review}
    <strong>{review.record.tasks[0]!.title}</strong>
    {#if review.record.tasks[0]!.description}<p class="task-description">
        {review.record.tasks[0]!.description}
      </p>{/if}
    <p>
      Todoist also deletes all subtasks, including completed ones. Linked notes
      become local checklists. Known task details remain in deletion history.
    </p>
    {#if review.record.tasks.length > 1}<p class="task-form-context">
        {review.record.tasks.length - 1} known {review.record.tasks.length === 2
          ? "subtask"
          : "subtasks"} saved in recovery
      </p>
      <fieldset>
        <legend>Subtasks</legend
        >{#each review.record.tasks.slice(1) as task (task.id)}<span
            >{task.title}{task.completed ? " · Completed" : ""}</span
          >{/each}
      </fieldset>{/if}
    {#if noteCount}<p class="task-form-context">
        {noteCount} linked {noteCount === 1 ? "note" : "notes"} will retain their
        content.
      </p>{/if}
    {#if review.cached}<p class="task-form-context">
        Using cached task details. Saved changes are checked before deletion.
      </p>{/if}
  {/if}
  {#if error}<p class="task-form-error" role="status">{error}</p>{/if}
  <div class="task-form-actions">
    {#if review}<button
        class="task-primary task-danger"
        disabled={busy || loading}
        type="submit"
        >{busy ? "Saving deletion…" : "Delete from Todoist"}</button
      >{:else if !loading}<button
        class="task-text-button"
        onclick={load}
        type="button">Retry loading</button
      >{/if}
    <button
      class="task-text-button"
      disabled={busy}
      onclick={cancel}
      type="button">Cancel</button
    >
  </div>
</form>
