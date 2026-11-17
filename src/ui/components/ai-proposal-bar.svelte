<script lang="ts">
  import { readable } from "svelte/store";

  import type { PlanningState } from "../../ai-scheduling/service";
  import { getObsidianContext } from "../../context/obsidian-context";

  const { aiPlanning, openAiPlanning } = getObsidianContext();
  const aiState = aiPlanning?.state ?? readable<PlanningState | null>(null);
  const pendingCount = $derived.by(() => {
    const draft = $aiState?.draft;
    return draft
      ? draft.proposal.actions.filter(
          (action) =>
            !draft.acceptedIds.includes(action.id) &&
            !draft.rejectedIds.includes(action.id),
        ).length
      : 0;
  });
  function reviewProposal() {
    if (openAiPlanning) void openAiPlanning().catch(() => {});
    else aiPlanning?.show();
  }
  function ignoreFailure(operation: Promise<unknown> | undefined) {
    if (operation) void operation.catch(() => {});
  }
</script>

{#if $aiState?.draft && pendingCount}
  <div class="proposal-bar" aria-label="AI suggestions">
    <span
      ><strong>{$aiState.draft.selectedIds.length}</strong> selected / {pendingCount}
      pending</span
    >
    <button onclick={reviewProposal} type="button">Review</button>
    <button
      disabled={$aiState.busy || !$aiState.draft.selectedIds.length}
      onclick={() => ignoreFailure(aiPlanning?.applySelected())}
      type="button">{$aiState.busy ? "Working…" : "Apply selected"}</button
    >
    <button
      disabled={$aiState.busy}
      onclick={() => ignoreFailure(aiPlanning?.dismissDraft())}
      type="button">Dismiss</button
    >
    {#if $aiState.error}<span class="proposal-error" role="alert"
        >{$aiState.error}</span
      >{/if}
  </div>
{/if}

<style>
  .proposal-bar {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    align-items: center;

    padding: 6px 8px;

    font-size: var(--font-small);
    color: var(--text-normal);

    background: var(--background-secondary);
    border-bottom: 1px solid var(--background-modifier-border);
  }

  .proposal-bar button {
    height: auto;
    padding: 3px 7px;
  }

  .proposal-error {
    flex-basis: 100%;
    color: var(--text-error);
  }
</style>
