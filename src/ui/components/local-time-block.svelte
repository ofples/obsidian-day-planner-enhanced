<script lang="ts">
  /* eslint-disable @typescript-eslint/no-floating-promises, @typescript-eslint/no-misused-promises, @typescript-eslint/no-redundant-type-constituents, @typescript-eslint/no-unnecessary-condition, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-enum-comparison, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return -- Obsidian community scorecard can run type-aware rules without resolving plugin source dependencies; tsc and svelte-check cover this source. */
  import { Lock, LockOpen } from "lucide-svelte";
  import { Notice } from "obsidian";
  import type { Snippet } from "svelte";

  import { getObsidianContext } from "../../context/obsidian-context";
  import type { LocalTimeBlock } from "../../time-block-types";
  import { containsLockedTask, isLocked } from "../../util/task-lock";
  import { hoverPreview } from "../actions/hover-preview";
  import type { HTMLActionArray } from "../actions/use-actions";

  import FrontmatterLogContent from "./frontmatter-log-content.svelte";
  import RenderedMarkdown from "./rendered-markdown.svelte";
  import TimeBlockBase from "./time-block-base.svelte";

  const {
    timeBlock,
    allDayColor,
    allDayList = false,
    bottomDecoration,
    blockEndDecoration,
    isActive = false,
    use = [],
    onpointerup,
  }: {
    allDayColor?: string;
    allDayList?: boolean;
    isActive?: boolean;
    timeBlock: LocalTimeBlock;
    bottomDecoration?: Snippet;
    blockEndDecoration?: Snippet;
    use?: HTMLActionArray;
    onpointerup?: (event: PointerEvent) => void;
  } = $props();
  const context = getObsidianContext();
  const locked = $derived(
    timeBlock.source !== "frontmatterLog" && isLocked(timeBlock),
  );

  function noteDrag(node: HTMLElement, initial?: unknown) {
    let current = initial as LocalTimeBlock | undefined;
    const update = (value?: unknown) => {
      const block = value as LocalTimeBlock | undefined;
      current = block;
      node.draggable = Boolean(
        context.noteTaskDrag &&
          block &&
          (block.source === "dailyNoteDate" ||
            block.source === "tasksPluginProp") &&
          !containsLockedTask(block),
      );
    };
    const start = (event: DragEvent) => {
      if (
        !current ||
        !context.noteTaskDrag ||
        (current.source !== "dailyNoteDate" &&
          current.source !== "tasksPluginProp") ||
        containsLockedTask(current) ||
        !event.dataTransfer ||
        (event.target as Element | null)?.closest?.(
          "button, input, a, textarea, select",
        )
      ) {
        event.preventDefault();
        return;
      }
      context.noteTaskDrag?.start(
        {
          path: current.path,
          line: current.position.start.line,
          text: current.text,
          durationMinutes: current.durationMinutes,
        },
        event.dataTransfer,
      );
    };
    const end = () => context.noteTaskDrag?.cancel();
    node.addEventListener("dragstart", start);
    node.addEventListener("dragend", end);
    update(initial);
    return {
      update,
      destroy() {
        node.removeEventListener("dragstart", start);
        node.removeEventListener("dragend", end);
      },
    };
  }
</script>

<TimeBlockBase
  --time-block-bg-color={isActive
    ? "color-mix(in srgb, var(--color-accent) 8%, var(--background-primary))"
    : ""}
  --time-block-box-shadow={isActive ? "none" : ""}
  --time-block-outline-color={isActive ? "var(--color-accent)" : ""}
  --time-block-outline-width={isActive ? "2px" : ""}
  --time-block-strip-color={isActive ? "var(--color-accent)" : ""}
  --time-block-z-index={isActive ? "2" : ""}
  {allDayColor}
  {allDayList}
  {blockEndDecoration}
  {onpointerup}
  {timeBlock}
  use={[...use, hoverPreview(timeBlock), [noteDrag, timeBlock]]}
>
  {#if (timeBlock.source === "dailyNoteDate" || timeBlock.source === "tasksPluginProp") && context.toggleTaskLock}
    <button
      class="task-lock-toggle"
      aria-label={locked ? "Unlock task" : "Lock task"}
      aria-pressed={locked}
      onclick={async (event) => {
        event.stopPropagation();
        try {
          await context.toggleTaskLock?.(timeBlock);
        } catch (error) {
          new Notice(
            error instanceof Error
              ? error.message
              : "Could not change this task's lock.",
          );
        }
      }}
      onpointerdown={(event) => event.stopPropagation()}
      onpointerup={(event) => event.stopPropagation()}
      title={locked ? "Unlock task" : "Lock task"}
    >
      {#if locked}<Lock size={14} />{:else}<LockOpen size={14} />{/if}
    </button>
  {/if}
  {#if timeBlock.source === "frontmatterLog"}
    <FrontmatterLogContent {bottomDecoration} {timeBlock} />
  {:else}
    <RenderedMarkdown {bottomDecoration} {timeBlock} />
  {/if}
</TimeBlockBase>

<!-- eslint-enable @typescript-eslint/no-floating-promises, @typescript-eslint/no-misused-promises, @typescript-eslint/no-redundant-type-constituents, @typescript-eslint/no-unnecessary-condition, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-enum-comparison, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return -- Re-enable scorecard compatibility suppressions after this file. -->

<style>
  .task-lock-toggle {
    cursor: pointer;

    position: absolute;
    z-index: 4;
    top: 2px;
    right: 2px;

    display: inline-flex;
    align-items: center;
    justify-content: center;

    width: 20px;
    height: 20px;
    padding: 0;

    color: var(--text-muted);

    background: var(--background-primary);
    border: 0;
    border-radius: 4px;
  }
</style>
