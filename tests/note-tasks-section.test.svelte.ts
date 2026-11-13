import { flushSync, mount, unmount } from "svelte";
import { expect, test, vi } from "vitest";

import { parseCaptureCandidates } from "../src/tasks/capture-parser";
import type { NoteTaskDrag } from "../src/tasks/note-drag";
import NoteTasksSection from "../src/ui/components/note-tasks-section.svelte";

test("note tasks are capped, expandable, searchable and openable by keyboard", async () => {
  const target = document.createElement("div");
  document.body.append(target);
  const candidates = parseCaptureCandidates(
    "Tasks.md",
    Array.from({ length: 35 }, (_, i) => `- [ ] Task ${i}`).join("\n"),
  );
  const openNote = vi.fn();
  const drag = { start: vi.fn(), cancel: vi.fn() };
  const props = $state({
    candidates,
    noteDrag: drag as unknown as NoteTaskDrag,
    query: "",
    openNote,
  });
  const component = mount(NoteTasksSection, { target, props });
  flushSync();
  expect(target.querySelectorAll(".note-row")).toHaveLength(30);
  expect(target.querySelector(".note-heading")?.textContent).toContain("35");
  const first = target.querySelector<HTMLButtonElement>(".note-open")!;
  first.focus();
  expect(document.activeElement).toBe(first);
  first.click();
  expect(openNote).toHaveBeenCalledWith("Tasks.md", 0);
  target.querySelector<HTMLButtonElement>(".note-more")!.click();
  flushSync();
  expect(target.querySelectorAll(".note-row")).toHaveLength(35);
  props.query = "Task 34";
  flushSync();
  expect(target.querySelectorAll(".note-row")).toHaveLength(1);
  expect(target.textContent).toContain("Task 34");
  target.querySelector<HTMLButtonElement>(".note-heading")!.click();
  flushSync();
  expect(target.querySelectorAll(".note-row")).toHaveLength(0);
  await unmount(component);
  target.remove();
});

test("dragging uses the indexed source and locked rows never start a drag", async () => {
  const target = document.createElement("div");
  document.body.append(target);
  const candidates = parseCaptureCandidates(
    "Tasks.md",
    "- [ ] Normal #todoist\n- [ ] Locked #locked",
  );
  const drag = { start: vi.fn(), cancel: vi.fn() };
  const component = mount(NoteTasksSection, {
    target,
    props: {
      candidates,
      noteDrag: drag as unknown as NoteTaskDrag,
      openNote: vi.fn(),
    },
  });
  flushSync();
  const rows = target.querySelectorAll<HTMLElement>(".note-row");
  expect(rows[0]!.draggable).toBe(true);
  expect(rows[1]!.draggable).toBe(false);
  const transfer = {} as DataTransfer;
  const event = () => {
    const value = new Event("dragstart", { bubbles: true, cancelable: true });
    Object.defineProperty(value, "dataTransfer", { value: transfer });
    return value;
  };
  rows[0]!.dispatchEvent(event());
  expect(drag.start).toHaveBeenCalledWith(
    {
      path: "Tasks.md",
      line: 0,
      text: "Normal #todoist",
      durationMinutes: undefined,
    },
    transfer,
  );
  rows[0]!.dispatchEvent(new Event("dragend", { bubbles: true }));
  expect(drag.cancel).toHaveBeenCalledOnce();
  const locked = event();
  rows[1]!.dispatchEvent(locked);
  expect(locked.defaultPrevented).toBe(true);
  expect(drag.start).toHaveBeenCalledOnce();
  await unmount(component);
  target.remove();
});
