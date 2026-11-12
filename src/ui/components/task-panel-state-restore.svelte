<script lang="ts">
  import { onMount, untrack } from "svelte";

  import type { TaskService } from "../../tasks/service";
  import type { TaskStateRestoreReview } from "../../tasks/state-journal";

  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- Svelte validates annotated component props.
  let {
    service,
    saved,
    cancel,
    setBusy,
  }: {
    service: TaskService;
    saved: () => void;
    cancel: () => void;
    setBusy?: (value: boolean) => void;
  } = $props();
  const opened = untrack(() => ({ service, saved }));
  let review = $state<TaskStateRestoreReview | null>(null);
  let loading = $state(true);
  let busy = $state(false);
  let error = $state("");
  let closed = false;

  async function load() {
    loading = true;
    error = "";
    try {
      const value = await opened.service.registry.reviewRestoration();
      if (!closed) review = value;
    } catch (failure) {
      if (!closed)
        error =
          failure instanceof Error
            ? failure.message
            : "Could not review saved task tracking.";
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

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (!review?.canRestore || busy) return;
    busy = true;
    setBusy?.(true);
    error = "";
    try {
      const result = await opened.service.restoreTracking(review);
      if (closed) return;
      if (result.kind === "changed") {
        review = result.review;
        error =
          "The tracking files changed. Review the current comparison and confirm again.";
      } else opened.saved();
    } catch (failure) {
      if (!closed)
        error =
          failure instanceof Error
            ? failure.message
            : "Could not restore saved task tracking.";
    } finally {
      if (!closed) busy = false;
      setBusy?.(false);
    }
  }
</script>

<form
  class="task-panel-form"
  aria-label="Restore saved task tracking"
  onsubmit={submit}
>
  <h3>Review saved task tracking</h3>
  <p class="task-form-context">
    The tracking file changed since the saved checkpoint. Review it before task
    sync resumes.
  </p>
  {#if loading}<p class="task-form-context" role="status">
      Reading tracking files…
    </p>
  {:else if review}
    <section class="task-state-summary" aria-label="Loaded tracking">
      <h4>Loaded tracking</h4>
      {#if review.loaded.readable}<p>
          {review.loaded.links} linked blocks · {review.loaded.commands} saved commands
        </p>
      {:else if review.loaded.version !== null}<p>
          The loaded file uses tracking format {review.loaded.version}.
        </p>
      {:else}<p>The loaded file is missing or unreadable.</p>{/if}
    </section>
    <section class="task-state-summary" aria-label="Saved tracking">
      <h4>Saved tracking</h4>
      <p>
        {review.saved.links} linked blocks · {review.saved.commands} saved commands
      </p>
    </section>
    <p>
      Restore the saved task identities, command history and recovery records.
      Sync then reads current provider data before continuing.
    </p>
    <details class="task-state-help">
      <summary>How recovery works</summary>
      <p>
        The loaded file is backed up before replacement. Current note blocks are
        compared with the restored task links during sync.
      </p>
      <p>
        Detection depends on the separate checkpoint. Restoring an older
        matching pair of files also restores its detection record.
      </p>
    </details>
    {#if !review.canRestore}<p class="task-form-error">
        This comparison requires matching supported tracking files. Check the
        file format and vault namespace before continuing.
      </p>{/if}
  {/if}
  {#if error}<p class="task-form-error" role="status">{error}</p>{/if}
  <div class="task-form-actions">
    {#if review}<button
        class="task-primary"
        disabled={loading || busy || !review.canRestore}
        type="submit">{busy ? "Restoring…" : "Restore saved tracking"}</button
      >
    {:else if !loading}<button class="task-primary" onclick={load} type="button"
        >Retry review</button
      >{/if}
    <button
      class="task-text-button"
      disabled={busy}
      onclick={cancel}
      type="button">Cancel</button
    >
  </div>
</form>
