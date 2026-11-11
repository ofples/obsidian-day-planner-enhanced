import { flushSync, mount, unmount } from "svelte";
import { get, writable } from "svelte/store";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
  vi,
} from "vitest";

import { defaultSettingsForTests } from "../src/settings";
import { taskViewStateSchema } from "../src/tasks/browser";
import type { TaskCapture } from "../src/tasks/capture";
import type { TaskOperation } from "../src/tasks/operations";
import type { TaskReconciler } from "../src/tasks/reconcile";
import type { TaskBrowserState, TaskService } from "../src/tasks/service";
import type { ProviderTask, TaskSnapshot } from "../src/tasks/types";
import TasksPane from "../src/ui/components/tasks-pane.svelte";
import type { TaskPanelAction } from "../src/ui/task-panel-state";

const task: ProviderTask = {
  id: "task",
  title: "Shopping",
  description: "Groceries",
  projectId: "work",
  parentId: null,
  labels: [],
  priority: 1,
  completed: false,
  order: 1,
  due: null,
};
const snapshot: TaskSnapshot = {
  provider: "todoist",
  account: { id: "account", name: "Fixture", timezone: "Asia/Kolkata" },
  projects: [{ id: "work", name: "Work", order: 1, inbox: true }],
  tasks: [task],
  fetchedAt: "2026-11-11T00:00:00Z",
};
const mounted: ReturnType<typeof mount>[] = [];
const originalHidePopover = HTMLElement.prototype.hidePopover;
beforeAll(() => {
  // jsdom lacks the browser popover API. Browser acceptance covers real menus.
  HTMLElement.prototype.hidePopover = vi.fn();
});
afterAll(() => {
  HTMLElement.prototype.hidePopover = originalHidePopover;
});
afterEach(async () => {
  for (const component of mounted.splice(0)) await unmount(component);
  document.body.replaceChildren();
});

function render(
  actionValue: TaskPanelAction | null = null,
  reconciler?: TaskReconciler,
) {
  const state = writable<TaskBrowserState>({
    snapshot,
    connected: true,
    loading: false,
    error: "",
    writable: true,
    aliases: {},
    operations: [],
    completed: [],
  });
  const mutate = vi.fn<TaskService["mutate"]>();
  const service = { state, mutate } as unknown as TaskService;
  const capture = {
    state: writable({ issues: [], error: "" }),
    scan: vi.fn(),
  } as unknown as TaskCapture;
  const action = writable(actionValue);
  const fallbackSettings = vi.fn();
  const target = document.createElement("div");
  document.body.append(target);
  mounted.push(
    mount(TasksPane, {
      target,
      props: {
        service,
        capture,
        action,
        reconciler,
        settings: writable(defaultSettingsForTests),
        preferences: writable(taskViewStateSchema.parse({})),
        captureSettings: fallbackSettings,
        completeTask: vi.fn(),
        reopenTask: vi.fn(),
        retry: vi.fn(),
        retrySchedule: vi.fn(),
        revealTask: vi.fn(),
      },
    }),
  );
  flushSync();
  return { target, state, action, mutate, fallbackSettings };
}

function press(element: EventTarget, key: string, isComposing = false) {
  element.dispatchEvent(
    new KeyboardEvent("keydown", {
      key,
      isComposing,
      bubbles: true,
      cancelable: true,
    }),
  );
  flushSync();
}

describe("custom Tasks panel", () => {
  test("unlink requires confirmation and keeps the decision open while it saves", async () => {
    let finish!: () => void;
    const unlink = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const reconciler = {
      state: writable({ issues: [], error: "" }),
      unlink,
    } as unknown as TaskReconciler;
    const h = render(
      { kind: "unlink", title: "Shopping", linkUid: "link" },
      reconciler,
    );
    expect(unlink).not.toHaveBeenCalled();
    h.target
      .querySelector<HTMLButtonElement>(".task-action-area .task-primary")!
      .click();
    flushSync();
    expect(unlink).toHaveBeenCalledExactlyOnceWith("link");
    expect(
      h.target.querySelector<HTMLButtonElement>(
        '[aria-label="Close task form"]',
      )?.disabled,
    ).toBe(true);
    press(h.target.querySelector("section")!, "Escape");
    expect(get(h.action)?.kind).toBe("unlink");
    finish();
    await vi.waitFor(() => expect(get(h.action)).toBeNull());
    expect(h.mutate).not.toHaveBeenCalled();
  });

  test("failed unlink retains its confirmation and actionable error", async () => {
    const unlink = vi.fn(async () => {
      throw new Error("The source changed. Review its current block.");
    });
    const reconciler = {
      state: writable({ issues: [], error: "" }),
      unlink,
    } as unknown as TaskReconciler;
    const h = render(
      { kind: "unlink", title: "Shopping", linkUid: "link" },
      reconciler,
    );
    h.target
      .querySelector<HTMLButtonElement>(".task-action-area .task-primary")!
      .click();
    await vi.waitFor(() =>
      expect(h.target.textContent).toContain("The source changed"),
    );
    expect(get(h.action)?.kind).toBe("unlink");
    expect(
      h.target.querySelector<HTMLButtonElement>(
        ".task-action-area .task-primary",
      )?.disabled,
    ).toBe(false);
  });
  test("Escape in another pane or an active composition preserves the open form", () => {
    const h = render({ kind: "create" });
    const input = h.target.querySelector<HTMLInputElement>(
      '[aria-label="Task title"]',
    )!;
    press(window, "Escape");
    expect(get(h.action)?.kind).toBe("create");
    press(input, "Escape", true);
    expect(get(h.action)?.kind).toBe("create");
    press(input, "Escape");
    expect(get(h.action)).toBeNull();
  });

  test("capture settings open the custom form through the toolbar", () => {
    const h = render();
    h.target
      .querySelector<HTMLButtonElement>('[aria-label="Capture and routing"]')!
      .click();
    flushSync();
    expect(
      h.target.querySelector('form[aria-label="Capture and routing settings"]'),
    ).not.toBeNull();
    expect(h.fallbackSettings).not.toHaveBeenCalled();
  });

  test("an old save finishing leaves the newer editor draft open", async () => {
    const h = render({ kind: "create" });
    let finish!: (operation: TaskOperation) => void;
    h.mutate.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const input = h.target.querySelector<HTMLInputElement>(
      '[aria-label="Task title"]',
    )!;
    input.value = "New task";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    h.target
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(h.mutate).toHaveBeenCalledOnce());
    const newer: TaskPanelAction = { kind: "edit", task };
    h.action.set(newer);
    flushSync();
    finish({
      id: crypto.randomUUID(),
      provider: "todoist",
      accountId: "account",
      mutation: { kind: "create", task },
      tempId: crypto.randomUUID(),
      base: null,
      status: "pending",
      attempts: 0,
      createdAt: snapshot.fetchedAt,
    });
    await Promise.resolve();
    await Promise.resolve();
    flushSync();
    expect(get(h.action)).toBe(newer);
    expect(
      h.target.querySelector<HTMLInputElement>('[aria-label="Task title"]')
        ?.value,
    ).toBe("Shopping");
  });

  test("multiple queued changes to one task share one collapsed review count", () => {
    const h = render();
    const operation: TaskOperation = {
      id: crypto.randomUUID(),
      tempId: crypto.randomUUID(),
      provider: "todoist",
      accountId: "account",
      mutation: {
        kind: "update",
        taskId: task.id,
        changes: { title: "New title" },
      },
      base: task,
      status: "conflict",
      attempts: 0,
      createdAt: snapshot.fetchedAt,
    };
    h.state.update((value) => ({
      ...value,
      operations: [operation, { ...operation, id: crypto.randomUUID() }],
    }));
    flushSync();
    const review = h.target.querySelector<HTMLDetailsElement>(
      "details.task-review",
    )!;
    expect(review.querySelector("summary")?.textContent).toContain(
      "1 needs review",
    );
    expect(review.open).toBe(false);
    expect(h.target.querySelector('[aria-label="No date"]')).not.toBeNull();
  });
});
