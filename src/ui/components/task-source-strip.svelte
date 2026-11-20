<script lang="ts">
  import {
    LayoutGrid,
    FileText,
    ListChecks,
    CircleCheck,
    GitBranch,
  } from "lucide-svelte";

  import {
    taskSourceChoices,
    type TaskPaneSource,
  } from "../../tasks/source-settings";

  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- Svelte validates the annotated component props.
  let {
    source,
    extended,
    choose,
  }: {
    source: TaskPaneSource;
    extended: boolean;
    choose: (source: TaskPaneSource) => void;
  } = $props();
  const choices = $derived(
    taskSourceChoices.filter(
      (choice) => extended || !["google-tasks", "github"].includes(choice.id),
    ),
  );
  function navigate(event: KeyboardEvent, id: TaskPaneSource) {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const current = choices.findIndex((choice) => choice.id === id);
    const index =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? choices.length - 1
          : (current + (event.key === "ArrowRight" ? 1 : -1) + choices.length) %
            choices.length;
    const next = choices[index];
    if (!next) return;
    const button = event.currentTarget as HTMLButtonElement;
    button.parentElement
      ?.querySelector<HTMLButtonElement>(`[aria-label="${next.label}"]`)
      ?.focus();
    choose(next.id);
  }
</script>

<div class="task-source-strip" aria-label="Task sources" role="tablist">
  {#each choices as choice}
    <button
      class={`source-${choice.id}`}
      aria-label={choice.label}
      aria-selected={source === choice.id}
      onclick={() => choose(choice.id)}
      onkeydown={(event) => navigate(event, choice.id)}
      role="tab"
      tabindex={source === choice.id ? 0 : -1}
      title={choice.label}
    >
      {#if choice.id === "overview"}<LayoutGrid size={18} />
      {:else if choice.id === "notes"}<FileText size={18} />
      {:else if choice.id === "todoist"}<ListChecks size={18} />
      {:else if choice.id === "google-tasks"}<CircleCheck size={18} />
      {:else}<GitBranch size={18} />{/if}<span class="task-visually-hidden"
        >{choice.label}</span
      >
    </button>
  {/each}
  <span class="task-active-source"
    >{taskSourceChoices.find((choice) => choice.id === source)?.label}</span
  >
</div>
