import moment from "moment";
import { get } from "svelte/store";
import { describe, expect, test } from "vitest";

import { defaultSettingsForTests } from "../../src/settings";
import { transform } from "../../src/ui/hooks/use-edit/transform/transform";
import { EditMode } from "../../src/ui/hooks/use-edit/types";
import { hasTaskLock } from "../../src/util/task-lock";

import { baseTimeBlock, threeTimeBlocks } from "./util/fixtures";
import { setUp } from "./util/setup";

describe("task lock", () => {
  test("recognizes a real first-line tag without treating code, comments or children as tags", () => {
    expect(hasTaskLock("09:00 - 10:00 Work #locked")).toBe(true);
    expect(hasTaskLock("- [ ] 09:00 - 10:00 Work #locked")).toBe(true);
    expect(hasTaskLock("#LOCKED 09:00 Work")).toBe(true);
    expect(hasTaskLock("Work #locked/child")).toBe(false);
    expect(hasTaskLock("Work \\#locked")).toBe(false);
    expect(hasTaskLock("Work `#locked`")).toBe(false);
    expect(hasTaskLock("Work %% #locked %%")).toBe(false);
    expect(hasTaskLock("Work\n  - [ ] Child #locked")).toBe(false);
  });

  test("locked blocks cannot start drag, resize or unscheduled drag", () => {
    const locked = { ...baseTimeBlock, text: "Task #locked" };
    const h = setUp({ timeBlocks: [locked] });
    h.handlers.handleGripMouseDown(locked, EditMode.DRAG);
    h.moveCursorTo(moment("2023-01-01 05:00"));
    h.handlers.handleResizerMouseDown(locked, EditMode.RESIZE);
    h.handlers.handleUnscheduledTimeBlockGripMouseDown(locked);
    expect(
      get(h.dayToDisplayedTimeBlocks)[
        "2023-01-01"
      ]?.withTime[0]?.startTime.isSame(locked.startTime),
    ).toBe(true);
    expect(h.props.onUpdate).not.toHaveBeenCalled();
  });

  test("a locked nested task prevents its parent subtree from being moved", () => {
    const nested = {
      id: "nested",
      text: "Child #locked",
      symbol: "-",
      path: "path",
      position: {
        start: { line: 1, col: 0, offset: 0 },
        end: { line: 1, col: 0, offset: 0 },
      },
      planEntries: [],
      logEntries: [],
    };
    const parent = { ...baseTimeBlock, text: "Parent", children: [nested] };
    const h = setUp({ timeBlocks: [parent] });
    h.handlers.handleGripMouseDown(parent, EditMode.DRAG);
    h.moveCursorTo(moment("2023-01-02 01:00"));
    expect(
      get(h.dayToDisplayedTimeBlocks)[
        "2023-01-01"
      ]?.withTime[0]?.startTime.isSame(parent.startTime),
    ).toBe(true);
    const changed = transform(
      [parent],
      { timeBlock: parent, mode: EditMode.DRAG },
      defaultSettingsForTests,
      { type: "date", dateTime: moment("2023-01-02") },
    );
    expect(changed).toEqual([parent]);
  });

  test.each([
    EditMode.DRAG_AND_SHIFT_OTHERS,
    EditMode.DRAG_AND_SHRINK_OTHERS,
    EditMode.RESIZE_AND_SHIFT_OTHERS,
    EditMode.RESIZE_AND_SHRINK_OTHERS,
  ])("rejects %s when it would alter a locked neighbor", (mode) => {
    const blocks = [
      threeTimeBlocks[0],
      { ...threeTimeBlocks[1], text: "Protected #locked" },
      threeTimeBlocks[2],
    ];
    const edited = blocks[0]!;
    const result = transform(
      blocks,
      { timeBlock: edited, mode },
      defaultSettingsForTests,
      { type: "dateTime", dateTime: moment("2023-01-01 02:30") },
    );
    expect(result).toEqual(blocks);
  });

  test.each([
    EditMode.DRAG_AND_SHIFT_OTHERS,
    EditMode.DRAG_AND_SHRINK_OTHERS,
    EditMode.RESIZE_FROM_TOP_AND_SHIFT_OTHERS,
    EditMode.RESIZE_FROM_TOP_AND_SHRINK_OTHERS,
  ])("rejects %s when it would alter an earlier locked neighbor", (mode) => {
    const blocks = [
      { ...threeTimeBlocks[0], text: "Protected #locked" },
      threeTimeBlocks[1],
      threeTimeBlocks[2],
    ];
    const result = transform(
      blocks,
      { timeBlock: blocks[1]!, mode },
      defaultSettingsForTests,
      { type: "dateTime", dateTime: moment("2023-01-01 01:30") },
    );
    expect(result).toEqual(blocks);
  });

  test("allows an edit that does not change a locked neighbor", () => {
    const blocks = [
      threeTimeBlocks[0],
      { ...threeTimeBlocks[1], text: "Protected #locked" },
    ];
    const result = transform(
      blocks,
      { timeBlock: blocks[0]!, mode: EditMode.DRAG },
      defaultSettingsForTests,
      { type: "dateTime", dateTime: moment("2023-01-01 01:15") },
    );
    expect(
      result
        .find((block) => block.id === blocks[0]!.id)
        ?.startTime.isSame(moment("2023-01-01 01:15")),
    ).toBe(true);
    expect(
      result
        .find((block) => block.id === blocks[1]!.id)
        ?.startTime.isSame(blocks[1]!.startTime),
    ).toBe(true);
  });
});
