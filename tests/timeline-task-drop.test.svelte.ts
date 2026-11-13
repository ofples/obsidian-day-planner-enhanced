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
import type {
  TimelineTimeBlock,
  WithDuration,
  WithPlacing,
} from "../src/time-block-types";
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
const parent: WithPlacing<
  WithDuration<Extract<TimelineTimeBlock, { source: "dailyNoteDate" }>>
> = {
  id: "parent",
  source: "dailyNoteDate",
  path: "Daily/2030-01-15.md",
  position: {
    start: { line: 4, col: 0, offset: 0 },
    end: { line: 4, col: 30, offset: 30 },
  },
  text: "09:00 - 10:00 Parent",
  task: " ",
  symbol: "-",
  startTime: window.moment("2030-01-15 09:00"),
  durationMinutes: 60,
  placing: { offsetPercent: 0, spanPercent: 100 },
};
const remote: WithPlacing<WithDuration<TimelineTimeBlock>> = {
  id: "remote",
  source: "ical",
  summary: "Remote event",
  rsvpStatus: "ACCEPTED",
  calendar: {
    name: "calendar",
    email: "",
    url: "https://example.test/feed",
    color: "#123456",
  },
  startTime: window.moment("2030-01-15 11:00"),
  durationMinutes: 60,
  placing: { offsetPercent: 0, spanPercent: 100 },
};
const components: ReturnType<typeof mount>[] = [];
afterEach(async () => {
  for (const component of components.splice(0)) await unmount(component);
  document.body.replaceChildren();
});

function render(
  active = true,
  blocks: WithPlacing<WithDuration<TimelineTimeBlock>>[] = [],
) {
  const settings = {
    ...defaultSettingsForTests,
    enableTimeTracker: false,
    showRecurringTaskPreviews: false,
  };
  const schedule = vi.fn(async () => {}),
    cancel = vi.fn(),
    nest = vi.fn(async () => {}),
    accept = vi.fn(() => ({ task, id: nonce }));
  let current: ProviderTask | null = active ? task : null;
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
            renderMarkdown: () => () => {},
            isModPressed: writable(false),
            showPreview: vi.fn(),
            settingsStore: writable(settings),
            settingsSignal: { current: settings },
            editContext: {
              confirmEdit: vi.fn(),
              handlers: { handleContainerMouseDown: vi.fn() },
              getDisplayedTimeBlocksForTimeline: () =>
                writable({ withTime: blocks }),
              editOperation: writable(null),
            },
            pointerDateTime: writable(null),
            useSelector: createUseSelector(makeStore({})),
            taskScheduler: {
              drag: {
                state: dragged,
                current: () => current,
                accept,
                cancel,
              },
              duration: () => 30,
              schedule,
              nest,
            },
          } as unknown as ObsidianContext,
        ],
      ]),
    }),
  );
  flushSync();
  const area = target.querySelector<HTMLElement>(".tasks")!;
  const transfer = { types: [taskDragMime], dropEffect: "none" };
  function event(type: string, element: Element = area) {
    const value = new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      clientY: 480,
    });
    Object.defineProperty(value, "dataTransfer", { value: transfer });
    element.dispatchEvent(value);
    flushSync();
    return value;
  }
  return {
    target,
    transfer,
    schedule,
    nest,
    cancel,
    accept,
    nonce,
    event,
    dragged,
    expire: () => {
      current = null;
      dragged.set(null);
      flushSync();
    },
  };
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
  test.each(["dailyNoteDate", "tasksPluginProp"] as const)(
    "a %s block accepts a task as its subtask without scheduling",
    async (source) => {
      const h = render(true, [{ ...parent, source }]);
      const zone = h.target.querySelector<HTMLElement>(
        ".task-subtask-drop-target",
      )!;
      expect(zone).not.toBeNull();
      expect(zone.textContent).toContain("Add as subtask");
      expect(h.event("dragenter", zone).defaultPrevented).toBe(true);
      expect(zone.classList.contains("active")).toBe(true);
      expect(h.target.querySelector(".task-drop-preview")).toBeNull();
      expect(h.event("drop", zone).defaultPrevented).toBe(true);
      await vi.waitFor(() =>
        expect(h.nest).toHaveBeenCalledExactlyOnceWith(
          task.id,
          { path: parent.path, line: 4, text: parent.text },
          h.nonce,
        ),
      );
      expect(h.schedule).not.toHaveBeenCalled();
      expect(h.cancel).toHaveBeenCalledOnce();
      expect(zone.classList.contains("active")).toBe(false);
    },
  );

  test("the ordinary timeline area still schedules rather than nesting", async () => {
    const h = render(true, [parent]);
    h.event("dragenter");
    expect(h.target.querySelector(".task-drop-preview")).not.toBeNull();
    h.event("drop");
    await vi.waitFor(() => expect(h.schedule).toHaveBeenCalledOnce());
    expect(h.nest).not.toHaveBeenCalled();
  });

  test("foreign and expired task drags never invoke nesting", () => {
    const h = render(true, [parent]);
    const zone = h.target.querySelector<HTMLElement>(
      ".task-subtask-drop-target",
    )!;
    h.transfer.types = ["text/plain"];
    expect(h.event("dragenter", zone).defaultPrevented).toBe(false);
    expect(h.event("drop", zone).defaultPrevented).toBe(false);
    expect(h.nest).not.toHaveBeenCalled();
    h.transfer.types = [taskDragMime];
    h.expire();
    expect(h.target.querySelector(".task-subtask-drop-target")).toBeNull();
    expect(h.nest).not.toHaveBeenCalled();
  });

  test("a rejected nesting operation clears drag state without scheduling", async () => {
    const h = render(true, [parent]);
    h.nest.mockRejectedValueOnce(new Error("Could not add subtask"));
    const zone = h.target.querySelector<HTMLElement>(
      ".task-subtask-drop-target",
    )!;
    h.event("dragenter", zone);
    h.event("drop", zone);
    await vi.waitFor(() => expect(h.cancel).toHaveBeenCalledOnce());
    expect(zone.classList.contains("active")).toBe(false);
    expect(h.target.querySelector(".task-drop-preview")).toBeNull();
    expect(h.schedule).not.toHaveBeenCalled();
  });

  test("an expired nonce at drop is cancelled without nesting or scheduling", async () => {
    const h = render(true, [parent]);
    const zone = h.target.querySelector<HTMLElement>(
      ".task-subtask-drop-target",
    )!;
    h.event("dragenter", zone);
    h.accept.mockImplementationOnce(() => {
      throw new Error("Drag expired");
    });
    h.event("drop", zone);
    await vi.waitFor(() => expect(h.cancel).toHaveBeenCalledOnce());
    expect(h.nest).not.toHaveBeenCalled();
    expect(h.schedule).not.toHaveBeenCalled();
    expect(zone.classList.contains("active")).toBe(false);
  });

  test("remote calendar events do not expose a subtask target", () => {
    const h = render(true, [remote]);
    expect(h.target.querySelector(".task-subtask-drop-target")).toBeNull();
  });
});
