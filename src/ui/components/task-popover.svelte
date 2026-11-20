<script lang="ts">
  import {
    autoUpdate,
    computePosition,
    flip,
    offset,
    shift,
    size,
  } from "@floating-ui/dom";
  import { X } from "lucide-svelte";
  import type { Snippet } from "svelte";

  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- Svelte validates the annotated component props.
  let {
    anchor,
    title,
    close,
    children,
  }: {
    anchor: HTMLElement;
    title: string;
    close: () => void;
    children: Snippet;
  } = $props();

  function setup(node: HTMLDivElement) {
    const doc = node.ownerDocument;
    const reference = anchor;
    let alive = true;
    // The top layer escapes the sidebar's overflow without a modal or a portal.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- Test DOMs and older hosts may not implement the top-layer API.
    node.showPopover?.();
    const stop = autoUpdate(reference, node, () => {
      void computePosition(reference, node, {
        strategy: "fixed",
        placement: "right-start",
        middleware: [
          offset(10),
          flip(),
          shift({ padding: 12 }),
          size({
            padding: 12,
            apply({ availableHeight, elements }) {
              elements.floating.style.maxHeight = `${Math.max(80, availableHeight)}px`;
            },
          }),
        ],
      }).then(({ x, y }) => {
        if (alive) Object.assign(node.style, { left: `${x}px`, top: `${y}px` });
      });
    });
    const pointer = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && !node.contains(target) && !reference.contains(target))
        close();
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        close();
        if (reference.isConnected) reference.focus();
      }
    };
    doc.addEventListener("pointerdown", pointer, true);
    doc.addEventListener("keydown", key, true);
    // Keep initial keyboard focus inside the non-modal card.
    node.querySelector<HTMLButtonElement>("button")?.focus();
    return {
      destroy() {
        alive = false;
        stop();
        doc.removeEventListener("pointerdown", pointer, true);
        doc.removeEventListener("keydown", key, true);
      },
    };
  }
</script>

<div
  class="dp-task-panel task-floating-card"
  aria-label={title}
  popover="manual"
  role="dialog"
  use:setup
>
  <div class="task-card-heading">
    <strong>{title}</strong><button
      class="task-icon-button"
      aria-label={`Close ${title.toLowerCase()}`}
      onclick={() => {
        const reference = anchor;
        close();
        if (reference.isConnected) reference.focus();
      }}><X size={16} /></button
    >
  </div>
  {@render children()}
</div>
