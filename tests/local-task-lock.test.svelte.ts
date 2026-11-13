import { flushSync, mount, unmount } from "svelte";
import { writable } from "svelte/store";
import { expect, test, vi } from "vitest";

import { obsidianContextKey } from "../src/constants";
import { defaultSettingsForTests } from "../src/settings";
import LocalTimeBlock from "../src/ui/components/local-time-block.svelte";

import { baseTimeBlock } from "./edit/util/fixtures";

test("local block exposes a keyboard-accessible top-right lock control", async () => {
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
  const button = target.querySelector<HTMLButtonElement>(
    'button[aria-label="Lock task"]',
  )!;
  expect(button.getAttribute("aria-pressed")).toBe("false");
  button.focus();
  expect(document.activeElement).toBe(button);
  button.click();
  expect(toggleTaskLock).toHaveBeenCalledWith(props.timeBlock);
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
  const buttonDrag = new Event("dragstart", {
    bubbles: true,
    cancelable: true,
  });
  Object.defineProperty(buttonDrag, "dataTransfer", { value: transfer });
  button.dispatchEvent(buttonDrag);
  expect(buttonDrag.defaultPrevented).toBe(true);
  expect(noteTaskDrag.start).toHaveBeenCalledOnce();
  props.timeBlock = { ...props.timeBlock, text: "Work #locked" };
  flushSync();
  expect(button.getAttribute("aria-label")).toBe("Unlock task");
  expect(button.getAttribute("aria-pressed")).toBe("true");
  expect(draggable.draggable).toBe(false);
  draggable.dispatchEvent(dragStart);
  expect(noteTaskDrag.start).toHaveBeenCalledOnce();
  await unmount(component);
  target.remove();
});
