import { flushSync, mount, unmount } from "svelte";
import { writable } from "svelte/store";
import { expect, test, vi } from "vitest";
import { obsidianContextKey } from "../src/constants";
import type { EditOperation } from "../src/ui/hooks/use-edit/types";
import { baseTimeBlock } from "./edit/util/fixtures";

vi.mock("../src/ui/actions/gestures", () => ({
  createGestures:
    (handlers: Record<string, (event: MouseEvent) => void>) =>
    (node: HTMLElement) => {
      const listeners = Object.entries(handlers)
        .filter(
          ([key, value]) =>
            key.startsWith("onpan") && typeof value === "function",
        )
        .map(([key, handler]) => {
          const type = key.slice(2);
          const listener = (event: Event) => handler(event as MouseEvent);
          node.addEventListener(type, listener);
          return () => node.removeEventListener(type, listener);
        });
      return { destroy: () => listeners.forEach((remove) => remove()) };
    },
}));
import DragControls from "../src/ui/components/drag-controls.svelte";

test("release and Escape allow a new drag without restarting the cancelled gesture", async () => {
  vi.stubGlobal("PointerEvent", MouseEvent);
  const originalAnimate = Object.getOwnPropertyDescriptor(
    Element.prototype,
    "animate",
  );
  Object.defineProperty(Element.prototype, "animate", {
    configurable: true,
    value: () => ({
      cancel() {},
      set onfinish(callback: (() => void) | null) {
        if (callback) queueMicrotask(callback);
      },
    }),
  });
  const target = document.createElement("div");
  document.body.append(target);
  const editOperation = writable<EditOperation | undefined>();
  const handleGripMouseDown = vi.fn((timeBlock, mode) =>
    editOperation.set({ timeBlock, mode }),
  );
  const component = mount(DragControls, {
    target,
    props: { isActive: false, setIsActive: vi.fn(), timeBlock: baseTimeBlock },
    context: new Map([
      [
        obsidianContextKey,
        {
          pointerDateTime: writable(null),
          editContext: { editOperation, handlers: { handleGripMouseDown } },
        },
      ],
    ]),
  });
  flushSync();
  const handle = target.querySelector<HTMLElement>(
    '[aria-label="Move block"]',
  )!;
  const fire = (type: string) =>
    handle.dispatchEvent(new MouseEvent(type, { bubbles: true, clientY: 100 }));
  fire("panstart");
  expect(handleGripMouseDown).toHaveBeenCalledTimes(1);
  editOperation.set(undefined); // Escape while the pointer is still held.
  fire("panmove");
  expect(handleGripMouseDown).toHaveBeenCalledTimes(1);
  fire("panend");
  fire("panstart");
  expect(handleGripMouseDown).toHaveBeenCalledTimes(2);
  editOperation.set(undefined); // Normal commit completed.
  fire("panend");
  fire("panstart");
  expect(handleGripMouseDown).toHaveBeenCalledTimes(3);
  await unmount(component);
  target.remove();
  if (originalAnimate)
    Object.defineProperty(Element.prototype, "animate", originalAnimate);
  else Reflect.deleteProperty(Element.prototype, "animate");
  vi.unstubAllGlobals();
});
