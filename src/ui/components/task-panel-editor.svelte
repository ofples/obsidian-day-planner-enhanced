<script lang="ts">
  import { onMount, untrack } from "svelte";
  import { z } from "zod";

  import { taskEditorFields, saveTaskEditor } from "../../tasks/editor";
  import type { TaskService } from "../../tasks/service";
  import type { ProviderTask, TaskSnapshot } from "../../tasks/types";

  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- Svelte validates annotated component props.
  let {
    service,
    snapshot,
    task,
    parent,
    saved,
    cancel,
  }: {
    service: TaskService;
    snapshot: TaskSnapshot;
    task?: ProviderTask;
    parent?: ProviderTask;
    saved: (id?: string) => void;
    cancel: () => void;
  } = $props();
  const opened = untrack(() => ({ snapshot, task, parent, saved }));
  let fields = $state(
    taskEditorFields(opened.snapshot, opened.task, opened.parent),
  );
  let busy = $state(false);
  let error = $state("");
  let titleInput: HTMLInputElement;
  onMount(() => titleInput.focus());
  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (busy) return;
    busy = true;
    error = "";
    try {
      const id = await saveTaskEditor(
        service,
        opened.snapshot,
        fields,
        opened.task,
        opened.parent,
      );
      opened.saved(id);
    } catch (failure) {
      error =
        failure instanceof z.ZodError
          ? (failure.issues[0]?.message ?? "Check the task fields.")
          : failure instanceof Error
            ? failure.message
            : "Could not save this task. Try again.";
    } finally {
      busy = false;
    }
  }
</script>

<form
  class="task-editor task-panel-form"
  aria-label={task ? "Edit task" : parent ? "Add subtask" : "New task"}
  onkeydown={(event) => {
    if (event.key === "Enter" && event.isComposing) event.preventDefault();
  }}
  onsubmit={submit}
>
  <div class="task-form-heading">
    <h3>{task ? "Edit task" : parent ? "Add subtask" : "New task"}</h3>
  </div>
  {#if parent}<p class="task-form-context">{parent.title}</p>{/if}
  <input
    bind:this={titleInput}
    class="task-title-input"
    aria-label="Task title"
    disabled={busy}
    placeholder="What needs doing?"
    required
    bind:value={fields.title}
  />
  <div class="task-form-grid">
    <label
      >Project<select
        aria-label="Task project"
        disabled={busy || !!parent}
        bind:value={fields.projectId}
      >
        {#each snapshot.projects as project (project.id)}<option
            value={project.id}>{project.name}</option
          >{/each}
      </select></label
    >
    <label
      >Date<input
        aria-label="Task date"
        disabled={busy}
        type="date"
        bind:value={fields.date}
      /></label
    >
  </div>
  <details class="task-more-fields" open={!!task}>
    <summary>Details</summary>
    <label
      >Description<textarea
        aria-label="Task description"
        disabled={busy}
        placeholder="Add details…"
        rows="3"
        bind:value={fields.description}></textarea></label
    >
    <div class="task-form-grid">
      <label
        >Priority<select
          aria-label="Task priority"
          disabled={busy}
          bind:value={fields.priority}
        >
          <option value={1}>Normal</option><option value={2}>Priority 3</option
          ><option value={3}>Priority 2</option><option value={4}
            >Priority 1</option
          >
        </select></label
      >
      <label
        >Labels<input
          aria-label="Task labels"
          disabled={busy}
          placeholder="errands, home"
          bind:value={fields.labels}
        /></label
      >
    </div>
  </details>
  {#if error}<p class="task-form-error" role="status">{error}</p>{/if}
  <div class="task-form-actions">
    <button class="task-primary" disabled={busy} type="submit"
      >{busy ? "Saving…" : task ? "Save changes" : "Add task"}</button
    ><button
      class="task-text-button"
      disabled={busy}
      onclick={cancel}
      type="button">Cancel</button
    >
  </div>
</form>
