import { flushSync, mount, unmount } from "svelte";
import { get, writable } from "svelte/store";
import { expect, test, vi } from "vitest";

import type {
  AiPlanningService,
  PlanningState,
} from "../src/ai-scheduling/service";
import { taskViewStateSchema } from "../src/tasks/browser";
import { TaskDrag } from "../src/tasks/drag";
import type { TaskScheduler } from "../src/tasks/schedule";
import { taskSourceOverview } from "../src/tasks/source-overview";
import { taskSourceReference } from "../src/tasks/source-references";
import SimpleTasksPane from "../src/ui/components/simple-tasks-pane.svelte";
import TaskSourceConnections from "../src/ui/components/task-source-connections.svelte";

import { taskSourcesFixture } from "./util/task-sources";

test("new sources use the existing rows, source-qualified actions and cached search", async () => {
  const h = await taskSourcesFixture();
  const target = document.createElement("div");
  document.body.append(target);
  const preferences = writable(
    taskViewStateSchema.parse({ source: "google-tasks" }),
  );
  const schedule = vi.fn();
  const imports = writable({});
  const scheduler = {
    drag: new TaskDrag(h.service, h.sources),
    importer: { imports, sources: () => [] },
  } as unknown as TaskScheduler;
  const component = mount(SimpleTasksPane, {
    target,
    props: {
      service: h.service,
      sources: h.sources,
      scheduler,
      preferences,
      schedule,
      openNote: () => {},
      connections: () => {},
    },
  });
  flushSync();
  expect(target.textContent).toContain("Google work");
  expect(target.textContent).toContain("Child work");
  const search = target.querySelector<HTMLInputElement>(
    '[aria-label="Search tasks"]',
  )!;
  search.value = "Google";
  search.dispatchEvent(new Event("input", { bubbles: true }));
  flushSync();
  expect(h.google.backend.read).not.toHaveBeenCalled();
  target
    .querySelector<HTMLButtonElement>('[role="tab"][aria-label="GitHub"]')!
    .click();
  flushSync();
  expect(target.textContent).toContain("GitHub work");
  expect(get(preferences).query).toBe("");
  expect(
    target.querySelector<HTMLButtonElement>(
      '[aria-label="Complete GitHub work"]',
    )?.disabled,
  ).toBe(true);
  expect(
    target.querySelector<HTMLAnchorElement>(
      '[aria-label="Open GitHub work in GitHub"]',
    )?.href,
  ).toBe(h.githubTask.source.url);
  target
    .querySelector<HTMLButtonElement>('[aria-label="Schedule GitHub work"]')!
    .click();
  expect(schedule).toHaveBeenCalledWith(
    h.githubTask,
    taskSourceReference(h.githubSnapshot, h.githubTask),
  );
  const values = new Map<string, string>();
  const transfer = {
    setData: (key: string, value: string) => values.set(key, value),
    getData: (key: string) => values.get(key) ?? "",
    effectAllowed: "",
  } as unknown as DataTransfer;
  const drag = new Event("dragstart", { bubbles: true, cancelable: true });
  Object.defineProperty(drag, "dataTransfer", { value: transfer });
  target
    .querySelector<HTMLElement>('[aria-label="GitHub work"]')!
    .dispatchEvent(drag);
  expect(scheduler.drag.accept(transfer).reference?.provider).toBe("github");
  target
    .querySelector<HTMLButtonElement>(
      '[role="tab"][aria-label="Google Tasks"]',
    )!
    .click();
  flushSync();
  expect(get(preferences).query).toBe("Google");
  expect(() => scheduler.drag.accept(transfer)).toThrow(/session/);
  expect(h.github.backend.read).not.toHaveBeenCalled();
  h.settings.update((value) => ({
    ...value,
    taskSources: {
      ...value.taskSources,
      googleTasks: { ...value.taskSources.googleTasks, allowCompletion: true },
    },
  }));
  flushSync();
  const complete = target.querySelector<HTMLButtonElement>(
    '[aria-label="Complete Google work"]',
  )!;
  expect(complete.disabled).toBe(false);
  complete.click();
  await vi.waitFor(() =>
    expect(h.google.backend.complete).toHaveBeenCalledTimes(1),
  );
  await unmount(component);
  target.remove();
});

test("connection cards select Google lists and GitHub repositories without changing other connections", async () => {
  const h = await taskSourcesFixture();
  const target = document.createElement("div");
  document.body.append(target);
  const component = mount(TaskSourceConnections, {
    target,
    props: { sources: h.sources },
  });
  flushSync();
  expect(target.textContent).toContain("Google Tasks");
  expect(target.textContent).toContain("GitHub");
  const googleCard = target.querySelector<HTMLElement>(
    '[aria-label="Google Tasks connection"]',
  )!;
  const listCheckbox = googleCard.querySelector<HTMLInputElement>(
    '[aria-label="Include Work list"]',
  )!;
  listCheckbox.checked = false;
  listCheckbox.dispatchEvent(new Event("change", { bubbles: true }));
  flushSync();
  expect(h.google.backend.read).not.toHaveBeenCalled();
  Array.from(googleCard.querySelectorAll<HTMLButtonElement>("button"))
    .find((button) => button.textContent === "Apply selection")!
    .click();
  await vi.waitFor(() =>
    expect(h.google.backend.read).toHaveBeenCalledTimes(1),
  );
  expect(get(h.settings).taskSources.googleTasks.listIds).toEqual([]);
  const repo = target.querySelector<HTMLInputElement>(
    '[aria-label="GitHub repository to add"]',
  )!;
  repo.value = "Example/New";
  repo.dispatchEvent(new Event("input", { bubbles: true }));
  flushSync();
  repo.parentElement!.querySelector<HTMLButtonElement>("button")!.click();
  await vi.waitFor(() =>
    expect(h.github.backend.read).toHaveBeenCalledTimes(1),
  );
  expect(get(h.settings).taskSources.github.repositories).toEqual([
    "example/new",
  ]);
  expect(h.service.refresh).not.toHaveBeenCalled();
  await unmount(component);
  target.remove();
});

test("Overview and AI buckets keep native actions and colliding source IDs separate", async () => {
  const h = await taskSourcesFixture();
  const collision = taskSourceOverview([
    h.googleSnapshot,
    { ...h.githubSnapshot, tasks: [{ ...h.githubTask, id: h.googleTask.id }] },
  ]);
  expect(new Set(collision.snapshot!.tasks.map((task) => task.id)).size).toBe(
    3,
  );
  expect(collision.snapshot!.tasks[1]!.parentId).toBe(
    collision.snapshot!.tasks[0]!.id,
  );
  const state = writable<PlanningState>({
    version: 1,
    ready: true,
    recoveryRequired: false,
    preferences: null,
    busy: false,
    error: "",
    context: null,
    draft: null,
    lastBatch: null,
    issues: [],
    taskView: {
      contextId: "context",
      tasks: [h.googleSnapshot, h.githubSnapshot].map((snapshot, index) => ({
        ref: `source-${index}`,
        kind: "source",
        title: snapshot.tasks[0]!.title,
        raw: `- [ ] ${snapshot.tasks[0]!.title}`,
        provider: snapshot.provider,
        accountId: snapshot.account.id,
        taskId: snapshot.tasks[0]!.id,
      })),
      buckets: [
        {
          id: "work",
          title: "Across sources",
          taskRefs: ["source-0", "source-1"],
        },
      ],
    },
  });
  const planning = {
    state,
    show: vi.fn(),
    clearTaskView: vi.fn(),
  } as unknown as AiPlanningService;
  const schedule = vi.fn();
  const target = document.createElement("div");
  document.body.append(target);
  const component = mount(SimpleTasksPane, {
    target,
    props: {
      service: h.service,
      sources: h.sources,
      planning,
      preferences: writable(taskViewStateSchema.parse({ source: "github" })),
      schedule,
      openNote: () => {},
      scheduler: {
        drag: new TaskDrag(h.service, h.sources),
        importer: { imports: writable({}), sources: () => [] },
      } as unknown as TaskScheduler,
    },
  });
  flushSync();
  expect(target.textContent).toContain("Across sources");
  expect(target.textContent).toContain("Google work");
  expect(target.textContent).toContain("Child work");
  expect(target.textContent).toContain("GitHub work");
  target
    .querySelector<HTMLButtonElement>('[aria-label="Schedule GitHub work"]')!
    .click();
  expect(schedule).toHaveBeenCalledWith(
    h.githubTask,
    taskSourceReference(h.githubSnapshot, h.githubTask),
  );
  expect(
    target.querySelector<HTMLButtonElement>(
      '[aria-label="Complete GitHub work"]',
    )!.disabled,
  ).toBe(true);
  expect(h.google.backend.read).not.toHaveBeenCalled();
  expect(h.github.backend.read).not.toHaveBeenCalled();
  await h.sources.github.disconnect();
  flushSync();
  expect(
    target.querySelector('[aria-label="Schedule GitHub work"]'),
  ).toBeNull();
  expect(
    target.querySelector('[aria-label="Schedule Google work"]'),
  ).not.toBeNull();
  await unmount(component);
  target.remove();
});
