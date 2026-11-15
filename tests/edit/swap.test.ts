import moment from "moment";
import { get } from "svelte/store";
import { describe, expect, test } from "vitest";
import { defaultSettingsForTests } from "../../src/settings";
import type { EditableTimeBlock } from "../../src/time-block-types";
import {
  createTransaction,
  getTimeBlockDiffFromEditState,
  mapTimeBlockDiffToUpdates,
} from "../../src/service/diff-writer";
import type { PeriodicNotes } from "../../src/service/periodic-notes";
import { transform } from "../../src/ui/hooks/use-edit/transform/transform";
import { EditMode } from "../../src/ui/hooks/use-edit/types";
import { baseTimeBlock } from "./util/fixtures";
import { setUp } from "./util/setup";

const source = {
  ...baseTimeBlock,
  id: "one",
  text: "Parent",
  startTime: moment("2023-01-01 09:00"),
  durationMinutes: 30,
  position: {
    start: { line: 0, col: 0, offset: 0 },
    end: { line: 1, col: 0, offset: 30 },
  },
  children: [
    {
      id: "child",
      text: "Child",
      symbol: "-",
      path: "path",
      position: {
        start: { line: 1, col: 0, offset: 12 },
        end: { line: 1, col: 10, offset: 22 },
      },
      planEntries: [],
      logEntries: [],
    },
  ],
};
const target = {
  ...baseTimeBlock,
  id: "two",
  text: "Other",
  startTime: moment("2023-01-01 11:00"),
  durationMinutes: 60,
  position: {
    start: { line: 3, col: 0, offset: 40 },
    end: { line: 3, col: 10, offset: 50 },
  },
};
const swap = (blocks: EditableTimeBlock[], point: moment.Moment) =>
  transform(
    blocks,
    { timeBlock: source, mode: EditMode.SWAP },
    defaultSettingsForTests,
    { type: "dateTime", dateTime: point },
  );

describe("timeline swap", () => {
  test("previews both starts and retains durations, IDs and child subtree", () => {
    const blocks = [source, target],
      result = swap(blocks, moment("2023-01-01 11:15"));
    expect(result[0]?.startTime.isSame(target.startTime)).toBe(true);
    expect(result[1]?.startTime.isSame(source.startTime)).toBe(true);
    expect(result.map((item) => item.durationMinutes)).toEqual([30, 60]);
    expect(result.map((item) => item.id)).toEqual(["one", "two"]);
    expect(result[0]?.children).toEqual(source.children);
    expect(blocks[0]?.startTime.isSame(source.startTime)).toBe(true);
  });
  test("supports another daily note and refuses locked or ambiguous targets", () => {
    const next = {
      ...target,
      path: "next",
      startTime: moment("2023-01-02 11:00"),
    };
    expect(
      swap([source, next], moment("2023-01-02 11:15"))[0]?.startTime.isSame(
        next.startTime,
      ),
    ).toBe(true);
    const locked = { ...target, text: "Locked #locked" };
    expect(swap([source, locked], moment("2023-01-01 11:15"))).toEqual([
      source,
      locked,
    ]);
    const duplicate = { ...target, id: "three", path: "other" };
    expect(
      swap([source, target, duplicate], moment("2023-01-01 11:15")),
    ).toEqual([source, target, duplicate]);
  });
  test("preserves each duration when the swapped end crosses midnight", () => {
    const late = {
      ...source,
      startTime: moment("2023-01-01 23:45"),
      durationMinutes: 45,
    };
    const next = {
      ...target,
      path: "next",
      startTime: moment("2023-01-02 10:00"),
      durationMinutes: 90,
    };
    const result = transform(
      [late, next],
      { timeBlock: late, mode: EditMode.SWAP },
      defaultSettingsForTests,
      { type: "dateTime", dateTime: moment("2023-01-02 10:15") },
    );
    expect(
      result[0]?.startTime
        .clone()
        .add(result[0].durationMinutes, "minutes")
        .isSame(moment("2023-01-02 10:45")),
    ).toBe(true);
    expect(
      result[1]?.startTime
        .clone()
        .add(result[1].durationMinutes, "minutes")
        .isSame(moment("2023-01-02 01:15")),
    ).toBe(true);
  });
  test("does not swap an overlapping block before the pointer moves", async () => {
    const overlap = {
      ...target,
      startTime: moment("2023-01-01 08:45"),
      durationMinutes: 60,
    };
    const h = setUp({ timeBlocks: [source, overlap] });
    h.moveCursorTo(source.startTime.clone());
    h.handlers.handleGripMouseDown(source, EditMode.SWAP);
    await h.confirmEdit();
    expect(h.props.onUpdate).not.toHaveBeenCalled();
  });
  test("preview never writes; abort restores and release commits one operation", async () => {
    const h = setUp({ timeBlocks: [source, target] });
    h.handlers.handleGripMouseDown(source, EditMode.SWAP);
    h.moveCursorTo(moment("2023-01-01 11:15"));
    expect(
      get(h.dayToDisplayedTimeBlocks)
        ["2023-01-01"]?.withTime.find((block) => block.id === "one")
        ?.startTime.isSame(target.startTime),
    ).toBe(true);
    expect(h.props.onUpdate).not.toHaveBeenCalled();
    h.props.abortEditTrigger.set("escape");
    await h.confirmEdit();
    expect(h.props.onUpdate).not.toHaveBeenCalled();
    h.handlers.handleGripMouseDown(source, EditMode.SWAP);
    h.moveCursorTo(moment("2023-01-01 11:15"));
    await h.confirmEdit();
    expect(h.props.onUpdate).toHaveBeenCalledOnce();
    expect(h.props.onUpdate.mock.calls[0]?.[2]).toBe(EditMode.SWAP);
  });
  test("another grip cannot replace an active swap's captured source", async () => {
    const h = setUp({ timeBlocks: [source, target] });
    h.handlers.handleGripMouseDown(source, EditMode.SWAP);
    h.handlers.handleGripMouseDown(target, EditMode.DRAG);
    h.moveCursorTo(moment("2023-01-01 11:15"));
    await h.confirmEdit();
    const [before, after, mode] = h.props.onUpdate.mock.calls[0]!;
    expect(mode).toBe(EditMode.SWAP);
    expect(
      after
        .find((item: EditableTimeBlock) => item.id === "one")
        ?.startTime.isSame(target.startTime),
    ).toBe(true);
    expect(
      before
        .find((item: EditableTimeBlock) => item.id === "one")
        ?.startTime.isSame(source.startTime),
    ).toBe(true);
  });
  test("a failed commit restores the baseline preview", async () => {
    const h = setUp({ timeBlocks: [source, target] });
    h.props.onUpdate.mockRejectedValueOnce(new Error("write failed"));
    h.handlers.handleGripMouseDown(source, EditMode.SWAP);
    h.moveCursorTo(moment("2023-01-01 11:15"));
    await expect(h.confirmEdit()).rejects.toThrow("write failed");
    expect(
      get(h.dayToDisplayedTimeBlocks)
        ["2023-01-01"]?.withTime.find((block) => block.id === "one")
        ?.startTime.isSame(source.startTime),
    ).toBe(true);
  });
  test("cross-day commit carries each subtree into the opposite daily note", () => {
    const first = {
      ...source,
      path: "2023-01-01.md",
      text: "09:00 - 09:30 Parent",
      position: {
        start: { line: 2, col: 0, offset: 15 },
        end: { line: 3, col: 12, offset: 60 },
      },
    };
    const second = {
      ...target,
      path: "2023-01-02.md",
      text: "11:00 - 12:00 Other",
      startTime: moment("2023-01-02 11:00"),
      position: {
        start: { line: 2, col: 0, offset: 15 },
        end: { line: 2, col: 20, offset: 40 },
      },
    };
    const original: EditableTimeBlock[] = [first, second];
    const preview = transform(
      original,
      { timeBlock: first, mode: EditMode.SWAP },
      defaultSettingsForTests,
      { type: "dateTime", dateTime: moment("2023-01-02 11:15") },
    );
    const periodic = {
      getDateFromPath: (path: string) =>
        moment(path.slice(0, 10), "YYYY-MM-DD", true),
      createDailyNotePath: (date: moment.Moment) =>
        date.format("YYYY-MM-DD") + ".md",
    } as unknown as PeriodicNotes;
    const updates = mapTimeBlockDiffToUpdates(
      getTimeBlockDiffFromEditState(original, preview),
      defaultSettingsForTests,
      periodic,
    );
    const files = new Map([
      [
        "2023-01-01.md",
        "# Day planner\n\n- [ ] 09:00 - 09:30 Parent\n\t- Child\n",
      ],
      ["2023-01-02.md", "# Day planner\n\n- [ ] 11:00 - 12:00 Other\n"],
    ]);
    for (const change of createTransaction({
      updates,
      settings: defaultSettingsForTests,
    }))
      files.set(change.path, change.updateFn(files.get(change.path)!));
    expect(files.get("2023-01-01.md")).toContain("09:00 - 10:00 Other");
    expect(files.get("2023-01-01.md")).not.toContain("Parent");
    expect(files.get("2023-01-02.md")).toContain("11:00 - 11:30 Parent");
    expect(files.get("2023-01-02.md")).toContain("Child");
    expect(files.get("2023-01-02.md")).not.toContain("Other");
  });
});
