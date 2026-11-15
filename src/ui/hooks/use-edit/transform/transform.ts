/* eslint-disable @typescript-eslint/no-floating-promises, @typescript-eslint/no-misused-promises, @typescript-eslint/no-redundant-type-constituents, @typescript-eslint/no-unnecessary-condition, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-enum-comparison, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return -- Obsidian community scorecard can run type-aware rules without resolving plugin source dependencies; tsc and svelte-check cover this source. */
import { isNotVoid } from "typed-assert";

import type { DayPlannerSettings } from "../../../../settings";
import { type EditableTimeBlock } from "../../../../time-block-types";
import type { PointerDateTime } from "../../../../types";
import { containsLockedTask, isLocked } from "../../../../util/task-lock";
import * as t from "../../../../util/time-block-utils";
import { EditMode, type EditOperation } from "../types";

import { editBlocks } from "./edit-blocks";

function getEditType(mode: EditMode) {
  if (
    mode === EditMode.DRAG ||
    mode === EditMode.DRAG_AND_SHIFT_OTHERS ||
    mode === EditMode.DRAG_AND_SHRINK_OTHERS
  ) {
    return "move";
  }

  if (
    mode === EditMode.CREATE ||
    mode === EditMode.RESIZE ||
    mode === EditMode.RESIZE_AND_SHIFT_OTHERS ||
    mode === EditMode.RESIZE_AND_SHRINK_OTHERS
  ) {
    return "end";
  }

  return "start";
}

function getEditInteraction(mode: EditMode) {
  if (
    mode === EditMode.DRAG_AND_SHRINK_OTHERS ||
    mode === EditMode.RESIZE_AND_SHRINK_OTHERS ||
    mode === EditMode.RESIZE_FROM_TOP_AND_SHRINK_OTHERS
  ) {
    return "shrink";
  }

  if (
    mode === EditMode.DRAG_AND_SHIFT_OTHERS ||
    mode === EditMode.RESIZE_AND_SHIFT_OTHERS ||
    mode === EditMode.RESIZE_FROM_TOP_AND_SHIFT_OTHERS
  ) {
    return "push";
  }

  return "none";
}

export function transform(
  baseline: EditableTimeBlock[],
  operation: EditOperation,
  settings: DayPlannerSettings,
  pointerDateTime: PointerDateTime,
) {
  if (isLocked(operation.timeBlock)) return baseline;
  if (operation.mode === EditMode.SWAP) {
    const source = baseline.find(
      (block) => block.id === operation.timeBlock.id,
    );
    if (
      !source ||
      containsLockedTask(source) ||
      source.isAllDayEvent ||
      pointerDateTime.type !== "dateTime" ||
      (source.source !== "dailyNoteDate" && source.source !== "tasksPluginProp")
    )
      return baseline;
    const time = pointerDateTime.dateTime.valueOf();
    if (
      time >= source.startTime.valueOf() &&
      time < t.getEndTime(source).valueOf()
    )
      return baseline;
    const candidates = baseline.filter(
      (block) =>
        block.id !== source.id &&
        !block.isAllDayEvent &&
        (block.source === "dailyNoteDate" ||
          block.source === "tasksPluginProp") &&
        time >= block.startTime.valueOf() &&
        time < t.getEndTime(block).valueOf(),
    );
    if (candidates.length !== 1) return baseline;
    const target = candidates[0]!;
    if (
      containsLockedTask(target) ||
      (target.source !== "dailyNoteDate" && target.source !== "tasksPluginProp")
    )
      return baseline;
    if (
      source.path === target.path &&
      source.position.start.offset < target.position.end.offset &&
      target.position.start.offset < source.position.end.offset
    )
      return baseline;
    if (source.startTime.isSame(target.startTime)) return baseline;
    return baseline.map((block) =>
      block.id === source.id
        ? { ...block, startTime: target.startTime.clone() }
        : block.id === target.id
          ? { ...block, startTime: source.startTime.clone() }
          : block,
    );
  }
  const result = baseline.slice();

  const isInBaseline = baseline.find(
    (timeBlock) => timeBlock.id === operation.timeBlock.id,
  );

  if (!isInBaseline) {
    result.push({
      ...operation.timeBlock,
      startTime: pointerDateTime.dateTime,
    });
  }

  const indexOfEditedTimeBlock = result.findIndex(
    (timeBlock) => timeBlock.id === operation.timeBlock.id,
  );

  if (pointerDateTime.type === "date") {
    if (containsLockedTask(operation.timeBlock)) return baseline;
    // Untimed plain list items are not indexed as all-day plan entries, so
    // persist converted blocks as tasks while preserving checkbox statuses.
    const needsTaskStatus =
      operation.timeBlock.status === undefined &&
      operation.timeBlock.task === undefined;

    return result.with(indexOfEditedTimeBlock, {
      ...operation.timeBlock,
      ...(needsTaskStatus ? { status: settings.taskStatusOnCreation } : {}),
      isAllDayEvent: true,
      startTime: pointerDateTime.dateTime,
      durationMinutes: 60,
    });
  }

  result[indexOfEditedTimeBlock] = {
    ...operation.timeBlock,
    isAllDayEvent: false,
  };

  const editType = getEditType(operation.mode);
  const createPointerHasNotMoved =
    operation.mode === EditMode.CREATE &&
    pointerDateTime.dateTime.isSame(operation.timeBlock.startTime, "minute");

  if (createPointerHasNotMoved) {
    return result;
  }

  const idToTimeBlockLookup = new Map(result.map((it) => [it.id, it]));

  const editableBlocks = result
    .map((it) => ({
      id: it.id,
      start: it.startTime.unix(),
      end: t.getEndTime(it).unix(),
    }))
    .toSorted((a, b) => a.start - b.start);

  const transformed = editBlocks(
    editableBlocks,
    operation.timeBlock.id,
    pointerDateTime.dateTime.unix(),
    editType,
    getEditInteraction(operation.mode),
    settings.minimalDurationMinutes * 60,
  );

  // A push or shrink is atomic: never alter a locked neighbor indirectly.
  if (
    transformed.some((block) => {
      const original = idToTimeBlockLookup.get(block.id);
      return (
        original &&
        ((containsLockedTask(original) &&
          block.start !== original.startTime.unix()) ||
          (isLocked(original) && block.end !== t.getEndTime(original).unix()))
      );
    })
  )
    return baseline;

  return transformed.map((it) => {
    const timeBlock = idToTimeBlockLookup.get(it.id);

    isNotVoid(timeBlock);

    return {
      ...timeBlock,
      startTime: window.moment.unix(it.start),
      durationMinutes: (it.end - it.start) / 60,
    };
  });
}
/* eslint-enable @typescript-eslint/no-floating-promises, @typescript-eslint/no-misused-promises, @typescript-eslint/no-redundant-type-constituents, @typescript-eslint/no-unnecessary-condition, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-enum-comparison, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return -- Re-enable scorecard compatibility suppressions after this file. */
