<script lang="ts">
  import { ExternalLink, RefreshCw } from "lucide-svelte";
  import { DateTime } from "luxon";
  import { onDestroy } from "svelte";

  import type { TaskOccurrenceRecord } from "../../tasks/occurrence-types";
  import type { TaskOccurrenceUndoController } from "../../tasks/occurrence-undo";
  import type { TaskOccurrenceUndoReview } from "../../tasks/occurrence-undo-plan";
  import type { TaskOperation } from "../../tasks/operations";

  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- Svelte validates annotated component props.
  let {
    record,
    timezone,
    retry,
    openNote,
    pendingCalendar = false,
    undoController,
    undoCommand,
    writable = false,
    setBusy,
  }: {
    record: TaskOccurrenceRecord;
    timezone: string;
    retry?: (id: string) => Promise<void>;
    openNote?: (path: string) => void;
    pendingCalendar?: boolean;
    undoController?: TaskOccurrenceUndoController;
    undoCommand?: TaskOperation;
    writable?: boolean;
    setBusy?: (value: boolean) => void;
  } = $props();
  let busy = $state(false);
  let review: TaskOccurrenceUndoReview | null = $state(null);
  let closed = false;
  onDestroy(() => {
    closed = true;
  });
  const undoActive = $derived(
    record.undo && !["complete", "cancelled"].includes(record.undo.phase),
  );
  const canCancel = $derived(
    record.undo?.phase === "provider-pending" &&
      undoCommand &&
      ["pending", "conflict"].includes(undoCommand.status) &&
      !undoCommand.remoteId,
  );
  async function undoAction(kind: "review" | "confirm" | "retry" | "cancel") {
    if (!undoController || busy || !writable) return;
    const id = record.id;
    busy = true;
    setBusy?.(true);
    error = "";
    try {
      if (kind === "review") {
        const value = await undoController.review(id);
        if (!closed && record.id === id) review = value;
      } else if (kind === "confirm" && review) {
        const result = await undoController.confirm(review);
        if (closed || record.id !== id) return;
        if (result.kind === "changed") {
          review = result.review;
          error =
            "The task or linked notes changed. Review these details and confirm again.";
        } else review = null;
      } else if (kind === "retry") await undoController.retry(id);
      else if (kind === "cancel") await undoController.cancel(id);
    } catch (failure) {
      if (!closed && record.id === id)
        error =
          failure instanceof Error
            ? failure.message
            : "Could not recover this occurrence. Review its saved undo.";
    } finally {
      if (!closed) busy = false;
      setBusy?.(false);
    }
  }
  let error = $state("");
  const notes = $derived([
    ...new Set(
      Object.values(
        Object.keys(record.links).length ? record.links : record.before.links,
      ).map((link) => link.source.path),
    ),
  ]);
  function date(value?: string) {
    if (!value) return "No task date";
    const parsed = DateTime.fromISO(value, { zone: timezone });
    return parsed.isValid
      ? parsed.toFormat(
          value.includes("T") ? "d MMM yyyy, HH:mm" : "d MMM yyyy",
        )
      : value;
  }
  async function retryHistory() {
    if (!retry || busy) return;
    busy = true;
    error = "";
    try {
      await retry(record.id);
    } catch (failure) {
      error =
        failure instanceof Error
          ? failure.message
          : "Could not retry this occurrence's history.";
    } finally {
      busy = false;
    }
  }
</script>

<section class="task-panel-form" aria-label="Recurring occurrence history">
  <h3>
    {record.phase === "undone" ? "Restored occurrence" : "Completed occurrence"}
  </h3>
  <h4>{record.before.task.title}</h4>
  {#if record.before.task.description}<p class="task-description">
      {record.before.task.description}
    </p>{/if}
  <dl class="task-properties">
    <div>
      <dt>Occurrence</dt>
      <dd>{date(record.before.task.due?.date)}</dd>
    </div>
    <div>
      <dt>Repeats</dt>
      <dd>{record.before.task.due?.text}</dd>
    </div>
    {#if record.next}<div>
        <dt>
          {record.external
            ? "Current occurrence when observed"
            : "Next occurrence at completion"}
        </dt>
        <dd>
          {record.next.completed
            ? "Series completed"
            : date(record.next.due?.date)}
        </dd>
      </div>{/if}
  </dl>
  {#if record.before.children.length}<fieldset>
      <legend>Saved subtasks</legend
      >{#each record.before.children as child (child.id)}<span
          >{child.completed ? "✓" : "○"} {child.title}</span
        >{/each}
    </fieldset>{/if}
  {#if record.external}<p class="task-form-context">
      Completed in Todoist. Saved from the linked occurrence and the provider's
      completion counter.
    </p>
    {#if record.next?.completionCount !== undefined && record.next.completionCount > record.before.task.completionCount! + 1}<p
        class="task-form-context"
      >
        The completion counter advanced by {record.next.completionCount -
          record.before.task.completionCount!} between observations.
      </p>{/if}
  {:else if record.recovered}<p class="task-form-context">
      Recovered from the saved command and available note identities.
    </p>{/if}
  {#if record.phase === "freezing" || record.phase === "pending"}<p
      class="task-form-context"
    >
      {record.phase === "pending"
        ? "Waiting for Todoist to verify this completion."
        : "Saving the checked historical note."}
    </p>{/if}
  {#if undoActive}<p class="task-form-context" role="status">
      {record.undo?.phase === "provider-pending"
        ? "Waiting for Todoist to verify undo."
        : "Restoring the historical note and releasing the following schedule."}
    </p>{/if}
  {#if record.phase === "undone"}<p class="task-form-context" role="status">
      The occurrence is restored. Current subtask states were read from Todoist.
    </p>{/if}
  {#if review}<fieldset aria-label="Review occurrence undo">
      <legend>Restore this occurrence?</legend>
      <dl class="task-properties">
        <div>
          <dt>Restore task date</dt>
          <dd>{date(record.before.task.due?.date)}</dd>
        </div>
        <div>
          <dt>Current task date</dt>
          <dd>{date(review.current.due?.date)}</dd>
        </div>
      </dl>
      <p>
        The historical schedule becomes active and unchecked. Subtasks use their
        current Todoist states.
      </p>
      {#if Object.keys(review.following.links).length}<p>
          Following schedules become local checklists. Their #todoist tags are
          removed and their content and calendar blocks are retained.
        </p>{/if}
      {#each [...new Set([...Object.values(review.historical.links), ...Object.values(review.following.links)].map((link) => link.source.path))] as path (path)}<span
          >{path}</span
        >{/each}
      {#if review.cached}<p class="task-form-context">
          Using cached task details. The saved undo is checked against Todoist
          before restoring notes.
        </p>{/if}
      <div class="task-form-actions">
        <button
          class="task-primary"
          disabled={busy || !writable}
          onclick={() => void undoAction("confirm")}
          >{busy ? "Saving undo�" : "Confirm undo"}</button
        >
        <button
          class="task-text-button"
          disabled={busy}
          onclick={() => {
            review = null;
            error = "";
          }}>Cancel</button
        >
      </div>
    </fieldset>
  {:else if undoController && record.phase === "complete" && !undoActive}<button
      class="task-text-button"
      disabled={busy || !writable}
      onclick={() => void undoAction("review")}>Undo this completion</button
    >
  {/if}
  {#if undoActive && undoController}<div class="task-form-actions">
      <button
        class="task-text-button"
        disabled={busy || !writable}
        onclick={() => void undoAction("retry")}>Retry undo recovery</button
      >
      {#if canCancel}<button
          class="task-text-button"
          disabled={busy || !writable}
          onclick={() => void undoAction("cancel")}>Cancel queued undo</button
        >{/if}
    </div>{/if}
  {#if record.error || record.undo?.error || error}<p
      class="task-form-error"
      role="status"
    >
      {error || record.undo?.error || record.error}
    </p>{/if}
  {#each notes as path (path)}<button
      class="task-text-button"
      disabled={!openNote}
      onclick={() => openNote?.(path)}>Open {path}</button
    >{/each}
  {#if retry && (record.phase === "freezing" || pendingCalendar)}<button
      class="task-text-button"
      disabled={busy}
      onclick={() => void retryHistory()}
      ><RefreshCw size={14} />Retry history sync</button
    >{/if}
  <a
    class="task-text-button"
    href={`https://app.todoist.com/app/task/${encodeURIComponent(record.before.task.id)}`}
    rel="noopener noreferrer"
    target="_blank"><ExternalLink size={14} />Open task in Todoist</a
  >
</section>
