<script lang="ts">
  import type { TaskDeletionController } from "../../tasks/deletion";
  import type { TaskService } from "../../tasks/service";

  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- Svelte validates annotated component props.
  let {
    id,
    controller,
    service,
    close,
    reviewDeletion,
    openSavedNote,
  }: {
    id: string;
    controller: TaskDeletionController;
    service: TaskService;
    close: () => void;
    reviewDeletion: (id: string, taskId: string) => void;
    openSavedNote?: (path: string) => void;
  } = $props();
  const deletionState = $derived(controller.state);
  const record = $derived(
    $deletionState.records.find((item) => item.id === id),
  );
  const browser = $derived(service.state);
  const operation = $derived(
    $browser.operations.find((item) => item.id === id),
  );
  let busy = $state(false),
    error = $state("");
  async function run(cancel = false) {
    busy = true;
    error = "";
    try {
      if (cancel) await controller.cancel(id);
      else await controller.retry(id);
    } catch (failure) {
      error =
        failure instanceof Error
          ? failure.message
          : "Could not finish this saved deletion.";
    } finally {
      busy = false;
    }
  }
</script>

<div class="task-panel-form" aria-label="Task deletion recovery">
  <h3>Deletion record</h3>
  {#if record}<strong>{record.tasks[0]!.title}</strong>
    <p class="task-form-context">
      {record.phase === "complete"
        ? "Deletion verified"
        : record.phase === "cancelled"
          ? "Deletion stopped"
          : record.phase === "unlinking"
            ? "Recovering local note links"
            : "Deletion saved"} · {new Date(record.createdAt).toLocaleString()}
    </p>
    {#if record.tasks[0]!.description}<p>{record.tasks[0]!.description}</p>{/if}
    {#if record.tasks.length > 1}<fieldset>
        <legend>Saved subtasks</legend
        >{#each record.tasks.slice(1) as task (task.id)}<span>{task.title}</span
          >{/each}
      </fieldset>{/if}
    {#if Object.keys(record.links).length}<fieldset>
        <legend>Saved notes</legend
        >{#each Array.from(new Set(Object.values(record.links).map((link) => link.source.path))) as path (path)}{#if openSavedNote}<button
              class="task-text-button saved-note"
              onclick={() => openSavedNote(path)}>{path}</button
            >{:else}<span class="task-form-context">{path}</span>{/if}{/each}
      </fieldset>{/if}
    {#if record.error || operation?.error}<p
        class="task-form-error"
        role="status"
      >
        {record.error || operation?.error}
      </p>{/if}
    {#if !["complete", "cancelled"].includes(record.phase)}<div
        class="task-form-actions"
      >
        {#if operation?.status === "conflict" || operation?.status === "failed"}<button
            class="task-primary"
            disabled={busy}
            onclick={() => reviewDeletion(id, record!.taskId)}
            >Review deletion</button
          >{:else}<button
            class="task-primary"
            disabled={busy || !$browser.writable}
            onclick={() => run()}>Retry recovery</button
          >{/if}
        {#if !["sent", "acknowledged", "verified", "complete"].includes(operation?.status ?? "pending")}<button
            class="task-text-button"
            disabled={busy || !$browser.writable}
            onclick={() => run(true)}>Stop deletion</button
          >{/if}
      </div>{/if}
  {:else}<p class="task-form-context">
      Reconnect the original task account to review this record.
    </p>{/if}
  {#if error}<p class="task-form-error" role="status">{error}</p>{/if}
  <button class="task-text-button" onclick={close}>Close</button>
</div>

<style>
  .saved-note {
    max-width: 100%;
    text-align: start;
    overflow-wrap: anywhere;
    white-space: normal;
  }
</style>
