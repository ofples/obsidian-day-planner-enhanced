<script lang="ts">
  import {
    CalendarClock,
    ChevronRight,
    ExternalLink,
    FilePlus2,
    FileText,
  } from "lucide-svelte";

  import { taskSubtree } from "../../tasks/browser";
  import type { ProviderTask, TaskSnapshot } from "../../tasks/types";

  import TaskPopover from "./task-popover.svelte";

  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- Svelte validates the annotated component props.
  let {
    anchor,
    task,
    snapshot,
    sourceLabel,
    url,
    date,
    added,
    locations,
    busy,
    close,
    schedule,
    add,
    openNote,
  }: {
    anchor: HTMLElement;
    task: ProviderTask;
    snapshot: TaskSnapshot;
    sourceLabel: string;
    url?: string;
    date: string;
    added: boolean;
    busy: boolean;
    locations: { path: string; line: number }[];
    close: () => void;
    schedule: () => void;
    add?: () => void;
    openNote: (path: string, line: number) => void;
  } = $props();
  const children = $derived(taskSubtree(snapshot, task));
  const memberships = $derived(task.source?.memberships ?? []);
  const dateLabel = $derived(
    snapshot.provider === "google-tasks"
      ? "Scheduled date"
      : snapshot.provider === "github"
        ? "Target date"
        : "Due date",
  );
</script>

<TaskPopover {anchor} {close} title="Task details">
  <div class="task-card-content">
    <div class="task-card-source">
      {sourceLabel}<span>{snapshot.account.name}</span>
    </div>
    <h3 class="task-card-title">{task.title || "Untitled task"}</h3>
    {#if task.labels.length}<div class="task-row-meta">
        {#each task.labels as label}<span class="task-label-chip">#{label}</span
          >{/each}
      </div>{/if}
    {#if task.description}<p class="task-card-description">
        {task.description}
      </p>{/if}
    {#if task.source?.descriptionTruncated}<p class="task-card-hint">
        Description shortened. Open the source to read it all.
      </p>{/if}
    <dl class="task-card-properties">
      <div>
        <dt>
          {snapshot.provider === "google-tasks"
            ? "List"
            : snapshot.provider === "github"
              ? "Repository / project"
              : "Project"}
        </dt>
        <dd>
          {snapshot.projects.find((project) => project.id === task.projectId)
            ?.name ?? "Unavailable"}
        </dd>
      </div>
      {#if task.source?.state}<div>
          <dt>Status</dt>
          <dd>{task.source.state}</dd>
        </div>{/if}
      {#if task.priority > 1}<div>
          <dt>Priority</dt>
          <dd>P{5 - task.priority}</dd>
        </div>{/if}
      {#if date}<div>
          <dt>{dateLabel}</dt>
          <dd>{date}{task.due?.recurring ? " · Recurring" : ""}</dd>
        </div>{/if}
      {#each memberships as membership}<div>
          <dt>
            {snapshot.projects.find(
              (project) => project.id === membership.containerId,
            )?.name ?? "Project"}
          </dt>
          <dd>
            {membership.status?.name ?? "No status"}{membership.date
              ? ` · ${membership.date.value} (target)`
              : ""}
          </dd>
        </div>{/each}
    </dl>
    {#if children.length}<details class="task-card-subtasks">
        <summary
          ><ChevronRight size={14} />Subtasks
          <span>{children.length}</span></summary
        >
        <ul>
          {#each children as child}<li
              style:--child-depth={Math.min(child.depth - 1, 6)}
            >
              {child.task.title}
            </li>{/each}
        </ul>
      </details>{/if}
    {#if added}<div class="task-card-added">
        <strong>Added to this note</strong>
        {#each locations as location}<button
            class="task-text-button"
            onclick={() => {
              openNote(location.path, location.line);
              close();
            }}><FileText size={14} />Open note block</button
          >{/each}
      </div>{/if}
    <div class="task-card-actions">
      {#if add}<button
          class="task-primary"
          disabled={busy || added}
          onclick={add}
          ><FilePlus2 size={15} />{busy
            ? "Adding…"
            : added
              ? "Added to note"
              : "Add to selected note"}</button
        >{/if}
      <button disabled={busy} onclick={schedule}
        ><CalendarClock size={15} />Schedule…</button
      >
      {#if url}<a
          class="task-source-link"
          href={url}
          rel="noopener noreferrer"
          target="_blank"><ExternalLink size={14} />Open in {sourceLabel}</a
        >{/if}
    </div>
    <p class="task-card-hint">
      Scheduling adds a Markdown copy. Source dates and details stay unchanged.
    </p>
  </div>
</TaskPopover>
