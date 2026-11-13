import { flushSync, mount, unmount, type ComponentProps } from "svelte";
import { get, writable } from "svelte/store";
import { expect, test, vi } from "vitest";

import { defaultSettings, defaultSettingsForTests } from "../src/settings";
import { taskViewStateSchema } from "../src/tasks/browser";
import { parseCaptureCandidates } from "../src/tasks/capture-parser";
import { TaskDrag, taskDragMime } from "../src/tasks/drag";
import type { TaskScheduler } from "../src/tasks/schedule";
import type { TaskBrowserState, TaskService } from "../src/tasks/service";
import type { ProviderTask, TaskSnapshot } from "../src/tasks/types";
import SimpleTasksPane from "../src/ui/components/simple-tasks-pane.svelte";
import TaskPaneRoot from "../src/ui/components/task-pane-root.svelte";

const mocks = vi.hoisted(() => ({ legacy: vi.fn() }));
vi.mock("../src/ui/components/tasks-pane.svelte", () => ({
  default: mocks.legacy,
}));

const task: ProviderTask = {
  id: "provider-task",
  title: "Provider work",
  description: "",
  projectId: "project",
  parentId: null,
  labels: [],
  priority: 1,
  completed: false,
  order: 0,
  due: null,
};
const snapshot: TaskSnapshot = {
  provider: "todoist",
  account: { id: "account", name: "Fixture", timezone: "UTC" },
  projects: [{ id: "project", name: "Project", order: 0 }],
  tasks: [task],
  fetchedAt: "2026-11-13T00:00:00Z",
};

function fixture(connected = true) {
  const browser = writable<TaskBrowserState>({
    snapshot: connected ? snapshot : null,
    connected,
    readOnly: true,
    writable: false,
    loading: false,
    error: "",
    operations: [],
    completed: [],
    aliases: {},
  });
  const service = {
    state: browser,
    refresh: vi.fn(),
    registry: { snapshot: () => ({ namespace: "fixture" }) },
  } as unknown as TaskService;
  const scheduler = { drag: new TaskDrag(service) } as TaskScheduler;
  const preferences = writable(taskViewStateSchema.parse({}));
  const noteTasks = writable(
    parseCaptureCandidates("Notes.md", "- [ ] Local reading"),
  );
  const connections = vi.fn(),
    schedule = vi.fn(),
    openNote = vi.fn();
  return {
    browser,
    service,
    scheduler,
    preferences,
    noteTasks,
    connections,
    schedule,
    openNote,
  };
}

test("connected read-only pane schedules or drags the actual task and exposes account controls", async () => {
  const h = fixture();
  const target = document.createElement("div");
  document.body.append(target);
  const component = mount(SimpleTasksPane, { target, props: h });
  flushSync();
  expect(target.textContent).toContain("Provider work");
  expect(
    target.querySelector(".simple-tasks-pane.dp-task-panel"),
  ).not.toBeNull();
  expect(
    target.querySelector(".note-heading")?.getAttribute("aria-expanded"),
  ).toBe("false");
  target.querySelector<HTMLButtonElement>(".note-heading")!.click();
  flushSync();
  expect(target.textContent).toContain("Local reading");
  expect(
    target.querySelector(
      '.task-checkbox, [aria-label^="Complete"], [aria-label^="Actions for"]',
    ),
  ).toBeNull();
  target
    .querySelector<HTMLButtonElement>('[aria-label="Schedule Provider work"]')!
    .click();
  expect(h.schedule).toHaveBeenCalledWith(task);
  target.querySelector<HTMLButtonElement>(".task-title")!.click();
  expect(h.schedule).toHaveBeenCalledTimes(2);
  expect(get(h.preferences).selectedId).toBe(task.id);
  target
    .querySelector<HTMLButtonElement>('[aria-label="Connections"]')!
    .click();
  expect(h.connections).toHaveBeenCalledOnce();
  const row = target.querySelector<HTMLElement>(".import-task")!;
  expect(row.draggable).toBe(true);
  const data = new Map<string, string>();
  const transfer = {
    setData: (type: string, value: string) => data.set(type, value),
    getData: (type: string) => data.get(type) ?? "",
    effectAllowed: "",
  } as unknown as DataTransfer;
  const drag = new Event("dragstart", { bubbles: true, cancelable: true });
  Object.defineProperty(drag, "dataTransfer", { value: transfer });
  row.dispatchEvent(drag);
  expect(drag.defaultPrevented).toBe(false);
  expect(data.has(taskDragMime)).toBe(true);
  expect(h.scheduler.drag.current()).toEqual(task);
  row.dispatchEvent(new Event("dragend", { bubbles: true }));
  expect(h.scheduler.drag.current()).toBeNull();
  await unmount(component);
  target.remove();
});

test("copy-only pane preserves project filtering, dates and nested-task collapse", async () => {
  const h = fixture();
  h.browser.update((state) => ({
    ...state,
    snapshot: {
      ...snapshot,
      tasks: [
        {
          ...task,
          labels: ["work"],
          due: {
            date: "2026-11-13T15:30:00",
            timezone: "UTC",
            recurring: false,
            text: "",
          },
        },
        {
          ...task,
          id: "child",
          title: "Child task",
          parentId: task.id,
          order: 1,
        },
      ],
    },
  }));
  const target = document.createElement("div");
  document.body.append(target);
  const component = mount(SimpleTasksPane, { target, props: h });
  flushSync();
  expect(target.querySelector(".task-row-meta")?.textContent).toContain(
    "Project",
  );
  expect(target.querySelector(".task-row-meta")?.textContent).toContain(
    "15:30",
  );
  expect(target.querySelector(".task-row-meta")?.textContent).toContain(
    "#work",
  );
  Array.from(
    target.querySelectorAll<HTMLButtonElement>(".task-grouping button"),
  )
    .find((button) => button.textContent === "Project")!
    .click();
  flushSync();
  expect(get(h.preferences).groupBy).toBe("project");
  target
    .querySelector<HTMLButtonElement>(
      '[aria-label="Subtasks of Provider work"]',
    )!
    .click();
  flushSync();
  expect(
    target.querySelector<HTMLElement>('[aria-label="Child task"]')?.hidden,
  ).toBe(true);
  expect(get(h.preferences).collapsed).toContain("task:project:provider-task");
  const project = target.querySelector<HTMLSelectElement>(
    '[aria-label="Filter by project"]',
  )!;
  project.value = "project";
  project.dispatchEvent(new Event("change", { bubbles: true }));
  expect(get(h.preferences).projectId).toBe("project");
  await unmount(component);
  target.remove();
});

test("search filters both provider and note tasks, while disconnected notes remain available", async () => {
  const h = fixture();
  const target = document.createElement("div");
  document.body.append(target);
  const component = mount(SimpleTasksPane, { target, props: h });
  flushSync();
  const search = target.querySelector<HTMLInputElement>(
    '[aria-label="Search tasks"]',
  )!;
  search.value = "reading";
  search.dispatchEvent(new Event("input", { bubbles: true }));
  flushSync();
  expect(target.textContent).toContain("Local reading");
  expect(
    target.querySelector('[aria-label="Provider work"]:not([hidden])'),
  ).toBeNull();
  search.value = "provider";
  search.dispatchEvent(new Event("input", { bubbles: true }));
  flushSync();
  expect(target.textContent).toContain("Provider work");
  expect(target.textContent).not.toContain("Local reading");
  h.browser.update((state) => ({ ...state, connected: false, snapshot: null }));
  search.value = "";
  search.dispatchEvent(new Event("input", { bubbles: true }));
  flushSync();
  expect(target.textContent).toContain("Local reading");
  expect(target.textContent).toContain("Sign in with Todoist");
  target.querySelector<HTMLButtonElement>(".note-open")!.click();
  expect(h.openNote).toHaveBeenCalledWith("Notes.md", 0);
  await unmount(component);
  target.remove();
});

test("default setting selects the simple pane and enabling experimental sync selects the legacy pane", async () => {
  mocks.legacy.mockClear();
  const h = fixture();
  const target = document.createElement("div");
  document.body.append(target);
  expect(defaultSettings.experimentalTodoistSync).toBe(false);
  const settings = writable({ ...defaultSettingsForTests });
  const props = {
    ...h,
    settings,
    openConnections: h.connections,
    scheduleImported: h.schedule,
    capture: {},
    action: writable(null),
    captureSettings: vi.fn(),
    completeTask: vi.fn(),
    reopenTask: vi.fn(),
    retry: vi.fn(),
    revealTask: vi.fn(),
  } as unknown as ComponentProps<typeof TaskPaneRoot>;
  const component = mount(TaskPaneRoot, { target, props });
  flushSync();
  expect(target.querySelector(".simple-tasks-pane")).not.toBeNull();
  expect(mocks.legacy).not.toHaveBeenCalled();
  settings.update((value) => ({ ...value, experimentalTodoistSync: true }));
  flushSync();
  expect(target.querySelector(".simple-tasks-pane")).toBeNull();
  expect(mocks.legacy).toHaveBeenCalled();
  await unmount(component);
  target.remove();
});
