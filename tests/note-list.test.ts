import { describe, expect, test } from "vitest";

import { parseCaptureCandidates } from "../src/tasks/capture-parser";
import { noteTaskDragText, noteTaskRows } from "../src/tasks/note-list";

describe("note task list", () => {
  test("scheduled toggle and search preserve completed ancestor context", () => {
    const text =
      "- [x] Completed parent\n  - [ ] 09:00 - 10:00 Scheduled child\n    - [ ] Nested task";
    const candidates = parseCaptureCandidates("Daily.md", text);
    expect(noteTaskRows(candidates)).toEqual([]);
    const rows = noteTaskRows(candidates, "Nested", true);
    expect(
      rows.map((row) => [
        row.candidate.title,
        row.context,
        row.hasChildren,
        row.scheduled,
      ]),
    ).toEqual([
      ["Completed parent", true, true, false],
      ["Scheduled child", true, true, true],
      ["Nested task", false, false, true],
    ]);
  });
  test("keeps unchecked note tasks while excluding timed trees, completed and custom statuses", () => {
    const text = [
      "- [ ] Free parent",
      "  - [ ] Free child #locked",
      "- [x] Done",
      "- [-] Cancelled",
      "- [ ] 09:00 - 09:30 Scheduled",
      "  - [ ] Under timed checkbox",
      "- 10:00 - 11:00 Plain timed parent",
      "  - [ ] Under plain timed parent",
      "- [ ] Standalone #todoist",
    ].join("\n");
    const candidates = parseCaptureCandidates("Daily.md", text);
    const rows = noteTaskRows(candidates);
    expect(rows.map((row) => row.candidate.title)).toEqual([
      "Free parent",
      "Free child #locked",
      "Standalone",
    ]);
    expect(rows.map((row) => row.locked)).toEqual([true, true, false]);
    expect(rows.map((row) => row.depth)).toEqual([0, 1, 0]);
  });

  test("searches title and path, sorts by path and offset and preserves input", () => {
    const a = parseCaptureCandidates("B.md", "- [ ] Alpha\n- [ ] Beta");
    const b = parseCaptureCandidates("A.md", "- [ ] Gamma");
    const all = [...a, ...b];
    const before = structuredClone(all);
    expect(noteTaskRows(all).map((row) => row.candidate.title)).toEqual([
      "Gamma",
      "Alpha",
      "Beta",
    ]);
    expect(noteTaskRows(all, "b.MD").map((row) => row.candidate.title)).toEqual(
      ["Alpha", "Beta"],
    );
    expect(noteTaskRows(all, "GAMMA")).toHaveLength(1);
    expect(all).toEqual(before);
  });

  test("drag text keeps the first line and removes only list and checkbox syntax", () => {
    const [candidate] = parseCaptureCandidates(
      "Test.md",
      "  1. [ ] Text #locked ^id\n     - [ ] Nested",
    );
    expect(noteTaskDragText(candidate!)).toBe("Text #locked ^id");
  });
});
