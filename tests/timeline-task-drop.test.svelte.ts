import { flushSync, mount, unmount } from "svelte";
import { writable } from "svelte/store";
import { afterEach, describe, expect, test, vi } from "vitest";

import { obsidianContextKey } from "../src/constants";
import { makeStore } from "../src/redux/store";
import { createUseSelector } from "../src/redux/use-selector";
import { defaultSettingsForTests } from "../src/settings";
import { taskDragMime } from "../src/tasks/drag";
import type { ProviderTask } from "../src/tasks/types";
import type { ObsidianContext } from "../src/types";
import Timeline from "../src/ui/components/timeline.svelte";

const task: ProviderTask = {
  id: "task",
  title: "Plan this task",
  description: "",
  projectId: "work",
  parentId: null,
  labels: [],
  priority: 1,
  completed: false,
  order: 1,
  due: null,
};
const components: ReturnType<typeof mount>[] = [];
afterEach(async () => {
  for (const component of components.splice(0)) await unmount(component);
  document.body.replaceChildren();
});

function render(active = true) {
  const settings = {
    ...defaultSettingsForTests,
    enableTimeTracker: false,
    showRecurringTaskPreviews: false,
  };
  const schedule = vi.fn(async () => {}),
    cancel = vi.fn();
  const dragged = writable(active ? task : null);
  const nonce = crypto.randomUUID();
  const target = document.createElement("div");
  document.body.append(target);
  components.push(
    mount(Timeline, {
      target,
      props: { day: window.moment("2030-01-15") },
      context: new Map([
        [
          obsidianContextKey,
          {
            settingsStore: writable(settings),
            settingsSignal: { current: settings },
            editContext: {
              confirmEdit: vi.fn(),
              handlers: { handleContainerMouseDown: vi.fn() },
              getDisplayedTimeBlocksForTimeline: () =>
                writable({ withTime: [] }),
              editOperation: writable(null),
            },
            pointerDateTime: writable(null),
            useSelector: createUseSelector(makeStore({})),
            taskScheduler: {
              drag: {
                state: dragged,
                current: () => (active ? task : null),
                accept: () => ({ task, id: nonce }),
                cancel,
              },
              duration: () => 30,
              schedule,
            },
          } as unknown as ObsidianContext,
        ],
      ]),
    }),
  );
  flushSync();
  const area = target.querySelector<HTMLElement>(".tasks")!;
  const transfer = { types: [taskDragMime], dropEffect: "none" };
  function event(type: string) {
    const value = new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      clientY: 480,
    });
    Object.defineProperty(value, "dataTransfer", { value: transfer });
    area.dispatchEvent(value);
    flushSync();
    return value;
  }
  return { target, transfer, schedule, cancel, nonce, event, dragged };
}

describe("timeline task drops", () => {
  test("accepts an entering task and previews its snapped interval before any dragover", () => {
    const h = render();
    expect(h.event("dragenter").defaultPrevented).toBe(true);
    expect(h.transfer.dropEffect).toBe("move");
    expect(h.target.querySelector(".task-drop-preview")?.textContent).toContain(
      task.title,
    );
    expect(h.target.querySelector(".task-drop-preview")?.textContent).toContain(
      "08:00",
    );
  });

  test("an immediate drop after entry uses the same scheduling command", async () => {
    const h = render();
    h.event("dragenter");
    expect(h.event("drop").defaultPrevented).toBe(true);
    await vi.waitFor(() =>
      expect(h.schedule).toHaveBeenCalledExactlyOnceWith(
        task.id,
        {
          start: window.moment("2030-01-15 08:00").toISOString(),
          end: window.moment("2030-01-15 08:30").toISOString(),
        },
        h.nonce,
      ),
    );
    expect(h.cancel).toHaveBeenCalledOnce();
  });

  test("foreign or expired drags leave the timeline untouched", () => {
    const h = render(false);
    expect(h.event("dragenter").defaultPrevented).toBe(false);
    expect(h.target.querySelector(".task-drop-preview")).toBeNull();
    expect(h.schedule).not.toHaveBeenCalled();
  });
});
