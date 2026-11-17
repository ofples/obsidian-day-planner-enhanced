<script lang="ts">
  import type { ProposalOverlay } from "../ai-proposal-view";

  // Svelte supplies typed component props; scorecard lint does not resolve the rune.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const {
    overlays,
    review,
  }: { overlays: ProposalOverlay[]; review: () => void } = $props();
</script>

{#each overlays as overlay (overlay.id)}
  <div
    style:top={`${overlay.top}px`}
    style:height={`${overlay.height}px`}
    class="proposal"
    class:deselected={!overlay.selected}
    class:frame={overlay.kind === "add-to-frame"}
  >
    <button
      class="proposal-label"
      onclick={(event) => {
        event.stopPropagation();
        review();
      }}
      onpointerdown={(event) => event.stopPropagation()}
      onpointerup={(event) => event.stopPropagation()}
      title="Review suggestion"
      type="button"
    >
      <span
        >{overlay.kind === "add-to-frame"
          ? "+ In frame"
          : overlay.kind === "move"
            ? "Proposed move"
            : "Proposed"}</span
      >
      {overlay.title}
    </button>
  </div>
{/each}

<style>
  .proposal {
    pointer-events: none;

    position: absolute;
    z-index: 8;
    inset-inline: 15px 3px;

    overflow: visible;

    box-sizing: border-box;

    background: color-mix(in srgb, var(--interactive-accent) 12%, transparent);
    border: 1px dashed var(--interactive-accent);
    border-radius: var(--radius-s);
  }

  .proposal.frame {
    inset-inline-start: 50%;
    background: transparent;
    border: 0;
  }

  .proposal.deselected {
    opacity: 0.5;
  }

  .proposal-label {
    pointer-events: auto;
    cursor: pointer;

    overflow: hidden;
    display: block;

    max-width: 100%;
    height: auto;
    padding: 2px 5px;

    font-size: var(--font-smallest);
    color: var(--text-normal);
    text-align: start;
    text-overflow: ellipsis;
    white-space: nowrap;

    background: var(--background-secondary);
    border: 1px solid var(--interactive-accent);
    border-radius: var(--radius-s);
    box-shadow: none;
  }

  .proposal-label span {
    font-weight: 600;
    color: var(--interactive-accent);
  }
</style>
