import { flushSync, mount, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const { notice } = vi.hoisted(() => ({ notice: vi.fn() }));
vi.mock("obsidian", async (importOriginal) => ({
  ...(await importOriginal<typeof import("obsidian")>()),
  Notice: notice,
  moment: window.moment,
}));

import { obsidianContextKey } from "../src/constants";
import type { ProviderTask } from "../src/tasks/types";
import type { RemoteTimeBlock } from "../src/time-block-types";
import Preview from "../src/ui/components/task-calendar-preview-content.svelte";

const task: ProviderTask = {
  id: "task-1",
  title: "Write report",
  description: "Notes",
  projectId: "work",
  parentId: null,
  labels: [],
  priority: 1,
  completed: false,
  order: 1,
  due: null,
};
const ref = {
  provider: "todoist" as const,
  accountId: "account-1",
  taskId: task.id,
};
const block = {
  id: "preview-1",
  source: "ical" as const,
  taskSource: ref,
  summary: task.title,
  description: "Notes #work",
  startTime: window.moment("2030-01-15 09:00"),
  durationMinutes: 60,
  rsvpStatus: "ACCEPTED" as const,
  calendar: {
    name: "Todoist",
    email: "",
    url: "https://example.test",
    color: "#123456",
  },
} satisfies RemoteTimeBlock & { durationMinutes: number };

const components: ReturnType<typeof mount>[] = [];
beforeEach(() => notice.mockClear());
afterEach(async () => {
  for (const component of components.splice(0)) await unmount(component);
  document.body.replaceChildren();
});

function render(timeBlock: typeof block & { isAllDayEvent?: boolean } = block) {
  const previewTask = vi.fn(() => task),
    start = vi.fn(),
    cancel = vi.fn(),
    editTaskPreview = vi.fn();
  const target = document.createElement("div");
  document.body.append(target);
  components.push(
    mount(Preview, {
      target,
      props: { timeBlock },
      context: new Map([
        [
          obsidianContextKey,
          {
            settingsSignal: { current: { timestampFormat: "HH:mm" } },
            taskScheduler: { previewTask, drag: { start, cancel } },
            editTaskPreview,
          },
        ],
      ]),
    }),
  );
  flushSync();
  const preview = target.querySelector<HTMLElement>(".task-calendar-preview")!;
  return { target, preview, previewTask, start, cancel, editTaskPreview };
}

function drag(element: Element, type: string, dataTransfer: object) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", { value: dataTransfer });
  element.dispatchEvent(event);
  flushSync();
  return event;
}

describe("task calendar preview", () => {
  test.each([
    [false, "Edit schedule"],
    [true, "Schedule"],
  ] as const)(
    "offers the correct action for all-day=%s and stops selection bubbling",
    (allDay, label) => {
      const h = render({ ...block, isAllDayEvent: allDay });
      expect(h.preview.textContent).toContain(task.title);
      if (allDay) expect(h.preview.textContent).not.toContain("09:00");
      else expect(h.preview.textContent).toContain("09:00–10:00");
      const button = h.target.querySelector<HTMLButtonElement>("button")!;
      expect(button.textContent).toContain(label);
      expect(button.type).toBe("button");
      const parentClick = vi.fn();
      document.addEventListener("click", parentClick);
      button.focus();
      expect(document.activeElement).toBe(button);
      button.click();
      document.removeEventListener("click", parentClick);
      expect(h.editTaskPreview).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ id: block.id }),
      );
      expect(parentClick).not.toHaveBeenCalled();
    },
  );

  test("validates the current task at drag start and cancels on drag end", () => {
    const h = render();
    expect(h.preview.draggable).toBe(true);
    const transfer = {};
    expect(drag(h.preview, "dragstart", transfer).defaultPrevented).toBe(false);
    expect(h.previewTask).toHaveBeenCalledExactlyOnceWith(ref);
    expect(h.start).toHaveBeenCalledExactlyOnceWith(task, transfer);
    drag(h.preview, "dragend", transfer);
    expect(h.cancel).toHaveBeenCalledOnce();
  });

  test("prevents an expired or foreign account drag and reports the error", () => {
    const h = render();
    h.previewTask.mockImplementationOnce(() => {
      throw new Error("Task is no longer available");
    });
    expect(drag(h.preview, "dragstart", {}).defaultPrevented).toBe(true);
    expect(h.start).not.toHaveBeenCalled();
    expect(notice).toHaveBeenCalledWith("Task is no longer available");
  });

  test("reports an edit failure without propagating selection", () => {
    const h = render();
    h.editTaskPreview.mockImplementationOnce(() => {
      throw new Error("Task account changed");
    });
    h.target.querySelector<HTMLButtonElement>("button")!.click();
    expect(notice).toHaveBeenCalledWith("Task account changed");
  });
});
