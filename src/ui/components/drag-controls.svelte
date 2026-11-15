<script lang="ts">
  import {
    FoldVertical,
    ArrowDownToLine,
    GripVertical,
    Copy,
    ArrowLeftRight,
  } from "lucide-svelte";
  import { get } from "svelte/store";

  import { getObsidianContext } from "../../context/obsidian-context";
  import type { EditableTimeBlock, WithDuration } from "../../time-block-types";
  import { getIsomorphicClientY } from "../../util/dom";
  import * as t from "../../util/time-block-utils";
  import { createGestures } from "../actions/gestures";
  import { getDragStartState } from "../hooks/use-edit/drag-pointer";
  import { EditMode } from "../hooks/use-edit/types";

  import BlockControlButton from "./block-control-button.svelte";
  import ExpandingControls from "./expanding-controls.svelte";

  export let isActive: boolean;
  export let setIsActive: (value: boolean) => void;
  export let timeBlock: EditableTimeBlock;
  let dragStarted = false;

  const {
    pointerDateTime,
    editContext: {
      editOperation,
      handlers: { handleGripMouseDown },
    },
  } = getObsidianContext();

  function startDrag(
    event: MouseEvent | TouchEvent,
    dragTask: WithDuration<EditableTimeBlock>,
    mode: EditMode,
  ) {
    if (dragStarted || get(editOperation)) {
      return;
    }

    dragStarted = true;
    const dragStartState = getDragStartState(
      dragTask,
      getIsomorphicClientY(event),
    );

    pointerDateTime.set(dragStartState.pointerDateTime);

    handleGripMouseDown(dragTask, mode, dragStartState.dragOriginClientY);
  }

  function handleMoveStart(event: MouseEvent | TouchEvent, mode: EditMode) {
    startDrag(event, timeBlock, mode);
  }

  function handleMove(event: MouseEvent | TouchEvent, mode: EditMode) {
    startDrag(event, timeBlock, mode);
  }

  function handleCopyStart(event: MouseEvent | TouchEvent) {
    startDrag(event, t.copy(timeBlock), EditMode.DRAG);
  }

  function handleCopy(event: MouseEvent | TouchEvent) {
    handleCopyStart(event);
  }

  function endDrag() {
    dragStarted = false;
  }
</script>

<ExpandingControls {isActive} {setIsActive}>
  {#snippet initial()}
    <BlockControlButton
      cursor="grab"
      label="Move block"
      use={[
        createGestures({
          onpanstart: (event) => handleMoveStart(event, EditMode.DRAG),
          onpanmove: (event) => handleMove(event, EditMode.DRAG),
          onpanend: endDrag,
        }),
      ]}
    >
      <GripVertical class="svg-icon" />
    </BlockControlButton>
  {/snippet}
  {#snippet expanded()}
    {#if !timeBlock.isAllDayEvent}
      <BlockControlButton
        cursor="grab"
        label="Swap blocks"
        use={[
          createGestures({
            onpanstart: (event) => handleMoveStart(event, EditMode.SWAP),
            onpanmove: (event) => handleMove(event, EditMode.SWAP),
            onpanend: endDrag,
          }),
        ]}
      >
        <ArrowLeftRight class="svg-icon" />
      </BlockControlButton>
    {/if}
    <BlockControlButton
      cursor="grab"
      label="Copy block"
      use={[
        createGestures({
          onpanstart: handleCopyStart,
          onpanmove: handleCopy,
          onpanend: endDrag,
        }),
      ]}
    >
      <Copy class="svg-icon" />
    </BlockControlButton>

    {#if !timeBlock.isAllDayEvent}
      <BlockControlButton
        cursor="grab"
        label="Move block and push neighboring blocks"
        use={[
          createGestures({
            onpanstart: (event) =>
              handleMoveStart(event, EditMode.DRAG_AND_SHIFT_OTHERS),
            onpanmove: (event) =>
              handleMove(event, EditMode.DRAG_AND_SHIFT_OTHERS),
            onpanend: endDrag,
          }),
        ]}
      >
        <ArrowDownToLine class="svg-icon" />
      </BlockControlButton>
      <BlockControlButton
        cursor="grab"
        label="Move block and shrink neighboring blocks"
        use={[
          createGestures({
            onpanstart: (event) =>
              handleMoveStart(event, EditMode.DRAG_AND_SHRINK_OTHERS),
            onpanmove: (event) =>
              handleMove(event, EditMode.DRAG_AND_SHRINK_OTHERS),
            onpanend: endDrag,
          }),
        ]}
      >
        <FoldVertical class="svg-icon" />
      </BlockControlButton>
    {/if}
  {/snippet}
</ExpandingControls>
