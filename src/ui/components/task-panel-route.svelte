<script lang="ts">
  import { onMount, untrack } from "svelte";
  import { get } from "svelte/store";

  import type { CaptureIssue, TaskCapture } from "../../tasks/capture";
  import type { TaskService } from "../../tasks/service";

  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- Svelte validates annotated component props.
  let {
    service,
    capture,
    issue,
    saved,
    cancel,
  }: {
    service: TaskService;
    capture: TaskCapture;
    issue: CaptureIssue;
    saved: () => void;
    cancel: () => void;
  } = $props();
  const snapshot = untrack(() => get(service.state).snapshot);
  const finish = untrack(() => saved);
  let projectId = $state("");
  let busy = $state(false);
  let error = $state("");
  let projectInput: HTMLSelectElement;
  onMount(() => projectInput.focus());
  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (busy) return;
    busy = true;
    error = "";
    try {
      const current = get(service.state).snapshot;
      if (
        !snapshot ||
        current?.provider !== snapshot.provider ||
        current.account.id !== snapshot.account.id
      )
        throw new Error("Reopen routing under the original task account.");
      if (!projectId) throw new Error("Choose a project first.");
      await capture.create(issue.candidate, projectId);
      void capture.scan();
      finish();
    } catch (failure) {
      error =
        failure instanceof Error
          ? failure.message
          : "Could not save this capture. Try again.";
    } finally {
      busy = false;
    }
  }
</script>

<form
  class="task-panel-form"
  aria-label="Route task to Todoist"
  onsubmit={submit}
>
  <h3>Choose a project</h3>
  <p class="task-form-context">{issue.candidate.title}</p>
  <p>{issue.message}</p>
  <label
    >Project<select
      bind:this={projectInput}
      aria-label="Capture project"
      disabled={busy}
      required
      bind:value={projectId}
      ><option value="">Choose a project</option
      >{#each snapshot?.projects ?? [] as project (project.id)}<option
          value={project.id}>{project.name}</option
        >{/each}</select
    ></label
  >
  {#if error}<p class="task-form-error" role="status">{error}</p>{/if}
  <div class="task-form-actions">
    <button class="task-primary" disabled={busy} type="submit"
      >{busy ? "Saving…" : "Send to Todoist"}</button
    ><button
      class="task-text-button"
      disabled={busy}
      onclick={cancel}
      type="button">Cancel</button
    >
  </div>
</form>
