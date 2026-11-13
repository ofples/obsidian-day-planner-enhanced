import { flushSync, mount, unmount } from "svelte";
import { writable } from "svelte/store";
import { expect, test, vi } from "vitest";

import { obsidianContextKey } from "../src/constants";
import { defaultSettingsForTests } from "../src/settings";
import LocalTimeBlock from "../src/ui/components/local-time-block.svelte";

import { baseTimeBlock } from "./edit/util/fixtures";

test("local block shows a noninteractive badge only while locked", async () => {
  const target = document.createElement("div");
  document.body.append(target);
  const toggleTaskLock = vi.fn(async () => {});
  const noteTaskDrag = { start: vi.fn(), cancel: vi.fn() };
  const context = new Map<string, unknown>([
    [
      obsidianContextKey,
      {
        settingsStore: writable(defaultSettingsForTests),
        settingsSignal: { current: defaultSettingsForTests },
        isDarkMode: { current: false },
        renderMarkdown: (element: HTMLElement, markdown: string) => {
          element.textContent = markdown;
          return () => element.replaceChildren();
        },
        toggleCheckboxInFile: vi.fn(),
        showPreview: vi.fn(),
        isModPressed: writable(false),
        toggleTaskLock,
        noteTaskDrag,
      },
    ],
  ]);
  const props = $state({ timeBlock: { ...baseTimeBlock, text: "Work" } });
  const component = mount(LocalTimeBlock, { target, context, props });
  flushSync();
  expect(target.querySelector('[aria-label="Locked task"]')).toBeNull();
  expect(target.querySelector('button[aria-label="Lock task"]')).toBeNull();
  const draggable = target.querySelector<HTMLElement>('[draggable="true"]')!;
  const transfer = {} as DataTransfer;
  const dragStart = new Event("dragstart", { bubbles: true, cancelable: true });
  Object.defineProperty(dragStart, "dataTransfer", { value: transfer });
  draggable.dispatchEvent(dragStart);
  expect(noteTaskDrag.start).toHaveBeenCalledWith(
    { path: "path", line: 0, text: "Work", durationMinutes: 60 },
    transfer,
  );
  draggable.dispatchEvent(new Event("dragend", { bubbles: true }));
  expect(noteTaskDrag.cancel).toHaveBeenCalledOnce();
  props.timeBlock = { ...props.timeBlock, text: "Work #locked" };
  flushSync();
  expect(
    target.querySelector('[role="img"][aria-label="Locked task"]'),
  ).not.toBeNull();
  expect(target.querySelector('button[aria-label="Unlock task"]')).toBeNull();
  expect(draggable.draggable).toBe(false);
  draggable.dispatchEvent(dragStart);
  expect(noteTaskDrag.start).toHaveBeenCalledOnce();
  await unmount(component);
  target.remove();
});
