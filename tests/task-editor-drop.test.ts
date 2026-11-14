import type { Editor } from "obsidian";
import { expect, test, vi } from "vitest";

import { rebaseDropOffset, taskDropOffset } from "../src/tasks/editor-drop";

test("uses release coordinates instead of the old text cursor, including offset zero", () => {
  const position = vi.fn(() => 0);
  const cursor = vi.fn();
  const editor = {
    cm: { posAtCoords: position },
    getCursor: cursor,
  } as unknown as Editor;
  expect(taskDropOffset(editor, { clientX: 120, clientY: 450 })).toBe(0);
  expect(position).toHaveBeenCalledWith({ x: 120, y: 450 });
  expect(cursor).not.toHaveBeenCalled();
});

test("supports editors without coordinate lookup", () => {
  const editor = {
    getCursor: () => ({ line: 3, ch: 0 }),
    posToOffset: () => 24,
  } as unknown as Editor;
  expect(taskDropOffset(editor, { clientX: 0, clientY: 0 })).toBe(24);
});

test("queued drops follow text changes before their release point", () => {
  expect(rebaseDropOffset("Header\nEnd", "New\nHeader\nEnd", 7)).toBe(11);
  expect(rebaseDropOffset("Header\n", "Header\n- [ ] First\n", 7)).toBe(19);
  expect(rebaseDropOffset("Header\nRemoved\nEnd", "Header\nEnd", 10)).toBe(7);
  expect(rebaseDropOffset("Same", "Same", 2)).toBe(2);
});
