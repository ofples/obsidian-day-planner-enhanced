import { flushSync, mount, unmount, type ComponentProps } from "svelte";
import { get, writable } from "svelte/store";
import { expect, test, vi } from "vitest";

import type { AiPlanningService } from "../src/ai-scheduling/service";
import { defaultSettings, defaultSettingsForTests } from "../src/settings";
import { planningTaskSelection } from "../src/tasks/ai-task-view";
import { taskViewStateSchema } from "../src/tasks/browser";
import { parseCaptureCandidates } from "../src/tasks/capture-parser";
import { TaskDrag, taskDragMime } from "../src/tasks/drag";
import type { TaskScheduler } from "../src/tasks/schedule";
import type { TaskBrowserState, TaskService } from "../src/tasks/service";
import type { ProviderTask, TaskSnapshot } from "../src/tasks/types";
import type { PlanningPanelState } from "../src/ui/ai-planning-panel";
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
  const imports = writable({});
  const scheduler = {
    drag: new TaskDrag(service),
    importer: { imports, sources: () => Object.entries(get(imports)) },
  } as unknown as TaskScheduler;
  const preferences = writable(taskViewStateSchema.parse({}));
  const noteTasks = writable(
    parseCaptureCandidates("Notes.md", "- [ ] Local reading"),
  );
  const connections = vi.fn(),
    schedule = vi.fn(),
    openNote = vi.fn(),
    completeTask = vi.fn();
  return {
    browser,
    service,
    scheduler,
    preferences,
    noteTasks,
    noteContext: writable({ currentPath: "Notes.md", targetPath: "Notes.md" }),
    connections,
    schedule,
    openNote,
    completeTask,
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
  Array.from(target.querySelectorAll<HTMLButtonElement>('[role="tab"]'))
    .find((button) => button.textContent?.includes("Notes"))!
    .click();
  flushSync();
  expect(target.textContent).toContain("Local reading");
  Array.from(target.querySelectorAll<HTMLButtonElement>('[role="tab"]'))
    .find((button) => button.textContent?.includes("Todoist"))!
    .click();
  flushSync();
  expect(
    target.querySelector('.task-checkbox, [aria-label^="Actions for"]'),
  ).toBeNull();
  target
    .querySelector<HTMLButtonElement>('[aria-label="Complete Provider work"]')!
    .click();
  expect(h.completeTask).toHaveBeenCalledWith(task);
  target
    .querySelector<HTMLButtonElement>('[aria-label="Schedule Provider work"]')!
    .click();
  expect(h.schedule).toHaveBeenCalledWith(task);
  target.querySelector<HTMLButtonElement>(".task-title")!.click();
  flushSync();
  expect(h.schedule).toHaveBeenCalledTimes(1);
  expect(target.querySelector('[aria-label="Task details"]')).not.toBeNull();
  document.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
  );
  flushSync();
  expect(target.querySelector('[aria-label="Task details"]')).toBeNull();
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

test("task details are read-only until an explicit action and close safely on account changes", async () => {
  const h = fixture();
  h.browser.update((state) => ({
    ...state,
    snapshot: {
      ...snapshot,
      tasks: [
        {
          ...task,
          description: "First line\nSecond line <script>plain text</script>",
          labels: ["work"],
        },
        { ...task, id: "child", title: "Child checklist", parentId: task.id },
      ],
    },
  }));
  const addToNote = vi.fn(async () => {});
  const target = document.createElement("div");
  document.body.append(target);
  const component = mount(SimpleTasksPane, {
    target,
    props: { ...h, addToNote },
  });
  flushSync();
  const title = target.querySelector<HTMLButtonElement>("button.task-row")!;
  title.click();
  flushSync();
  const card = target.querySelector<HTMLElement>(
    '[aria-label="Task details"]',
  )!;
  expect(card.textContent).toContain("First line");
  expect(card.textContent).toContain("Child checklist");
  expect(card.querySelector("script")).toBeNull();
  expect(card.querySelector<HTMLAnchorElement>("a")?.href).toBe(
    "https://app.todoist.com/app/task/provider-task",
  );
  expect(h.schedule).not.toHaveBeenCalled();
  expect(h.service.refresh).not.toHaveBeenCalled();
  Array.from(card.querySelectorAll<HTMLButtonElement>("button"))
    .find((button) => button.textContent?.includes("Add to selected note"))!
    .click();
  await vi.waitFor(() =>
    expect(addToNote).toHaveBeenCalledWith(
      expect.objectContaining({ id: task.id }),
      undefined,
    ),
  );
  await vi.waitFor(() =>
    expect(target.querySelector('[aria-label="Task details"]')).toBeNull(),
  );
  title.click();
  flushSync();
  document.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
  );
  flushSync();
  expect(document.activeElement).toBe(title);
  title.click();
  flushSync();
  h.browser.update((state) => ({
    ...state,
    snapshot: {
      ...snapshot,
      account: { ...snapshot.account, id: "another-account" },
    },
  }));
  flushSync();
  expect(target.querySelector('[aria-label="Task details"]')).toBeNull();
  await unmount(component);
  target.remove();
});

test("saved views restore source filters without nested preferences or source writes", async () => {
  const h = fixture();
  const target = document.createElement("div");
  document.body.append(target);
  const component = mount(SimpleTasksPane, { target, props: h });
  flushSync();
  const search = target.querySelector<HTMLInputElement>(
    '[aria-label="Search tasks"]',
  )!;
  search.value = "Provider";
  search.dispatchEvent(new Event("input", { bubbles: true }));
  target
    .querySelector<HTMLButtonElement>('[aria-label="Task view options"]')!
    .click();
  flushSync();
  const name = target.querySelector<HTMLInputElement>(
    '[aria-label="View name"]',
  )!;
  name.value = "Morning triage";
  name.dispatchEvent(new Event("input", { bubbles: true }));
  flushSync();
  target
    .querySelector<HTMLFormElement>(".task-save-view")!
    .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  flushSync();
  expect(get(h.preferences).savedViews?.[0]?.view).not.toHaveProperty(
    "savedViews",
  );
  target
    .querySelector<HTMLButtonElement>('[role="tab"][aria-label="Notes"]')!
    .click();
  flushSync();
  expect(get(h.preferences).query).toBe("");
  target
    .querySelector<HTMLButtonElement>('[aria-label="Task view options"]')!
    .click();
  flushSync();
  target
    .querySelector<HTMLButtonElement>(".task-saved-views > div > button")!
    .click();
  flushSync();
  expect(get(h.preferences).source).toBe("todoist");
  expect(get(h.preferences).query).toBe("Provider");
  const restored = taskViewStateSchema.parse(
    JSON.parse(JSON.stringify(get(h.preferences))),
  );
  expect(restored.savedViews?.[0]?.title).toBe("Morning triage");
  expect(h.service.refresh).not.toHaveBeenCalled();
  expect(h.schedule).not.toHaveBeenCalled();
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
  target
    .querySelector<HTMLButtonElement>('[aria-label="Task view options"]')!
    .click();
  flushSync();
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

test("completion requires weak editing but does not require legacy writable state", async () => {
  const h = fixture();
  const props = $state({ ...h, weakCompletionEnabled: false });
  const target = document.createElement("div");
  document.body.append(target);
  const component = mount(SimpleTasksPane, { target, props });
  flushSync();
  const checkbox = target.querySelector<HTMLButtonElement>(
    '[aria-label="Complete Provider work"]',
  )!;
  expect(get(h.browser).writable).toBe(false);
  expect(checkbox.disabled).toBe(true);
  props.weakCompletionEnabled = true;
  flushSync();
  expect(checkbox.disabled).toBe(false);
  checkbox.click();
  expect(h.completeTask).toHaveBeenCalledOnce();
  await unmount(component);
  target.remove();
});

test("overview shows current note and high-priority Todoist tasks", async () => {
  const h = fixture();
  h.browser.update((state) => ({
    ...state,
    snapshot: { ...snapshot, tasks: [{ ...task, priority: 4 }] },
  }));
  const target = document.createElement("div");
  document.body.append(target);
  const component = mount(SimpleTasksPane, { target, props: h });
  flushSync();
  Array.from(target.querySelectorAll<HTMLButtonElement>('[role="tab"]'))
    .find((button) => button.textContent?.includes("Overview"))!
    .click();
  flushSync();
  expect(target.textContent).toContain("Local reading");
  expect(target.textContent).toContain("High priority");
  expect(target.textContent).toContain("Provider work");
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
  Array.from(target.querySelectorAll<HTMLButtonElement>('[role="tab"]'))
    .find((button) => button.textContent?.includes("Notes"))!
    .click();
  flushSync();
  search.value = "reading";
  search.dispatchEvent(new Event("input", { bubbles: true }));
  flushSync();
  expect(target.textContent).toContain("Local reading");
  expect(
    target.querySelector('[aria-label="Provider work"]:not([hidden])'),
  ).toBeNull();
  Array.from(target.querySelectorAll<HTMLButtonElement>('[role="tab"]'))
    .find((button) => button.textContent?.includes("Todoist"))!
    .click();
  flushSync();
  search.value = "provider";
  search.dispatchEvent(new Event("input", { bubbles: true }));
  flushSync();
  expect(target.textContent).toContain("Provider work");
  expect(target.textContent).not.toContain("Local reading");
  h.browser.update((state) => ({ ...state, connected: false, snapshot: null }));
  search.value = "";
  search.dispatchEvent(new Event("input", { bubbles: true }));
  flushSync();
  expect(target.textContent).toContain("Sign in with Todoist");
  Array.from(target.querySelectorAll<HTMLButtonElement>('[role="tab"]'))
    .find((button) => button.textContent?.includes("Notes"))!
    .click();
  flushSync();
  expect(target.textContent).toContain("Local reading");
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

test("assistant buckets mix current note and provider sources without changing normal browsing", async () => {
  const h = fixture();
  const originalPreferences = {
    ...get(h.preferences),
    query: "ordinary search",
    source: "notes" as const,
  };
  h.preferences.set(originalPreferences);
  h.noteTasks.set(
    parseCaptureCandidates(
      "Notes.md",
      "- [ ] Local reading\n- [ ] Unrelated note task",
    ),
  );
  h.browser.update((state) => ({
    ...state,
    snapshot: {
      ...snapshot,
      tasks: [task, { ...task, id: "other", title: "Other provider task" }],
    },
  }));
  const note = get(h.noteTasks)[0]!;
  const state = writable<PlanningPanelState>({
    ready: true,
    busy: false,
    error: "",
    context: null,
    draft: null,
    lastBatch: null,
    issues: [],
    taskView: {
      contextId: "context",
      tasks: [
        {
          ref: "note",
          kind: "note",
          title: note.title,
          path: note.path,
          from: note.from,
          raw: note.raw,
        },
        {
          ref: "provider",
          kind: "todoist",
          title: task.title,
          raw: "- [ ] Provider work",
          provider: "todoist",
          accountId: "account",
          taskId: task.id,
        },
      ],
      buckets: [
        {
          id: "morning",
          title: "Morning focus",
          taskRefs: ["note", "provider"],
        },
      ],
    },
  });
  const planning = {
    state,
    visible: writable(false),
    show: vi.fn(),
    clearTaskView: vi.fn(() =>
      state.update((current) => ({ ...current, taskView: null })),
    ),
  } as unknown as AiPlanningService;
  const target = document.createElement("div");
  document.body.append(target);
  const component = mount(SimpleTasksPane, {
    target,
    props: { ...h, planning },
  });
  flushSync();
  expect(target.textContent).toContain("Morning focus");
  expect(target.textContent).toContain("Local reading");
  expect(target.textContent).toContain("Provider work");
  expect(target.textContent).not.toContain("Unrelated note task");
  expect(target.textContent).not.toContain("Other provider task");
  expect(get(h.preferences)).toEqual(originalPreferences);
  target
    .querySelector<HTMLButtonElement>('[aria-label="Complete Provider work"]')!
    .click();
  expect(h.completeTask).toHaveBeenCalledWith(task);
  // The curated view uses the ordinary provider drag entry point and its payload.
  const row = target.querySelector<HTMLElement>(
    '[aria-label="Provider work"]',
  )!;
  const data = new Map<string, string>();
  const transfer = {
    setData: (key: string, value: string) => data.set(key, value),
    getData: (key: string) => data.get(key) ?? "",
    effectAllowed: "",
  } as unknown as DataTransfer;
  const drag = new Event("dragstart", { bubbles: true, cancelable: true });
  Object.defineProperty(drag, "dataTransfer", { value: transfer });
  row.dispatchEvent(drag);
  expect(h.scheduler.drag.current()).toEqual(task);
  expect(data.has(taskDragMime)).toBe(true);
  row.dispatchEvent(new Event("dragend", { bubbles: true }));
  h.browser.update((current) => ({
    ...current,
    snapshot: { ...snapshot, tasks: [{ ...task, completed: true }] },
  }));
  flushSync();
  expect(
    target.querySelector('[aria-label="Complete Provider work"]'),
  ).toBeNull();
  const button = (text: string) =>
    Array.from(target.querySelectorAll<HTMLButtonElement>("button")).find(
      (item) => item.textContent?.trim() === text,
    )!;
  button("Plan").click();
  expect(planning.show).toHaveBeenCalledOnce();
  button("Clear view").click();
  flushSync();
  expect(get(h.preferences)).toEqual(originalPreferences);
  expect(target.textContent).not.toContain("Morning focus");
  expect(
    target.querySelector<HTMLInputElement>('[aria-label="Search tasks"]')!
      .value,
  ).toBe("ordinary search");
  await unmount(component);
  target.remove();
});

test("assistant note identity follows unique raw text drift and preserves parent context", () => {
  const original = parseCaptureCandidates(
    "Notes.md",
    "- [ ] Parent\n  - [ ] Child\n- [ ] Unrelated",
  );
  const child = original[1]!;
  const selected = {
    ref: "child",
    kind: "note" as const,
    title: child.title,
    raw: child.raw,
    path: child.path,
    from: child.from,
  };
  const current = parseCaptureCandidates(
    "Notes.md",
    "Some new text\n\n- [ ] Parent\n  - [ ] Child\n- [ ] Unrelated",
  );
  expect(
    planningTaskSelection(
      [selected],
      new Set(["child"]),
      current,
      null,
    ).notes.map((task) => task.title),
  ).toEqual(["Parent", "Child"]);
  const duplicates = parseCaptureCandidates(
    "Notes.md",
    "Some new text\n\n  - [ ] Child\n  - [ ] Child",
  );
  expect(
    planningTaskSelection([selected], new Set(["child"]), duplicates, null)
      .notes,
  ).toEqual([]);
  expect(
    planningTaskSelection(
      [{ ...selected, raw: "- [ ] Changed" }],
      new Set(["child"]),
      current,
      null,
    ).notes,
  ).toEqual([]);
});
