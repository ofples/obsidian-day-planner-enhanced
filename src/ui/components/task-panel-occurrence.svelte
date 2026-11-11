<script lang="ts">
  import { ExternalLink, RefreshCw } from "lucide-svelte";
  import { DateTime } from "luxon";

  import type { TaskOccurrenceRecord } from "../../tasks/occurrence-types";

  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- Svelte validates annotated component props.
  let {
    record,
    timezone,
    retry,
    openNote,
    pendingCalendar = false,
  }: {
    record: TaskOccurrenceRecord;
    timezone: string;
    retry?: (id: string) => Promise<void>;
    openNote?: (path: string) => void;
    pendingCalendar?: boolean;
  } = $props();
  let busy = $state(false);
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
  <h3>Completed occurrence</h3>
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
        <dt>Next occurrence at completion</dt>
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
  {#if record.recovered}<p class="task-form-context">
      Recovered from the saved command and available note identities.
    </p>{/if}
  {#if record.phase === "freezing" || record.phase === "pending"}<p
      class="task-form-context"
    >
      {record.phase === "pending"
        ? "Waiting for Todoist to verify this completion."
        : "Saving the checked historical note."}
    </p>{/if}
  {#if record.error || error}<p class="task-form-error" role="status">
      {error || record.error}
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
