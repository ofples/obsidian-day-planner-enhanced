import type { WorkspaceLeaf } from "obsidian";
import { mount } from "svelte";
import { get } from "svelte/store";
import { beforeEach, describe, expect, test, vi } from "vitest";

import type { TaskCapture } from "../src/tasks/capture";
import type { TaskReconciler } from "../src/tasks/reconcile";
import type { TaskService } from "../src/tasks/service";
import { TasksView } from "../src/ui/tasks-view";

const notice = vi.hoisted(() => vi.fn());
const requestSaveLayout = vi.hoisted(() => vi.fn());
vi.mock("svelte", async (importOriginal) => ({
  ...(await importOriginal<typeof import("svelte")>()),
  mount: vi.fn(() => ({})),
  unmount: vi.fn(async () => {}),
}));
vi.mock("../src/ui/components/task-pane-root.svelte", () => ({
  default: vi.fn(),
}));
vi.mock("../src/ui/task-schedule-modal", () => ({
  TaskScheduleModal: vi.fn(),
}));
vi.mock("obsidian", () => ({
  ItemView: class {
    contentEl = { addClass: vi.fn(), removeClass: vi.fn() };
    app = { workspace: { requestSaveLayout } };
    registerInterval(id: number) {
      window.clearInterval(id);
    }
    async setState() {}
  },
  Notice: notice,
}));

beforeEach(() => {
  notice.mockClear();
  requestSaveLayout.mockClear();
});

function view(keepLinked = vi.fn(async () => {})) {
  return {
    keepLinked,
    instance: new TasksView(
      {} as WorkspaceLeaf,
      { refresh: vi.fn(async () => {}) } as unknown as TaskService,
      {} as TaskCapture,
      vi.fn(),
      undefined,
      undefined,
      { keepLinked } as unknown as TaskReconciler,
    ),
  };
}

describe("Tasks view link decisions", () => {
  test("preference changes request durable workspace saves and close removes the subscription", async () => {
    const h = view();
    await h.instance.onOpen();
    expect(requestSaveLayout).not.toHaveBeenCalled();
    h.instance.preferences.update((state) => ({
      ...state,
      query: "Saved search",
      groupBy: "project",
      collapsed: ["home"],
    }));
    expect(requestSaveLayout).toHaveBeenCalledTimes(1);
    h.instance.preferences.set(structuredClone(h.instance.getState()));
    expect(requestSaveLayout).toHaveBeenCalledTimes(1);
    await h.instance.onClose();
    h.instance.preferences.update((state) => ({
      ...state,
      query: "After closing",
    }));
    expect(requestSaveLayout).toHaveBeenCalledTimes(1);
    await h.instance.onOpen();
    h.instance.preferences.update((state) => ({ ...state, query: "Reopened" }));
    expect(requestSaveLayout).toHaveBeenCalledTimes(2);
    await h.instance.onClose();
  });
  test("the normal state restoration entry point saves the parsed preferences", async () => {
    const h = view();
    await h.instance.onOpen();
    await h.instance.setState(
      { query: "Restored search", selectedId: "original", projectId: "home" },
      {} as import("obsidian").ViewStateResult,
    );
    expect(h.instance.getState()).toMatchObject({
      query: "Restored search",
      selectedId: "original",
      projectId: "home",
    });
    expect(requestSaveLayout).toHaveBeenCalledTimes(1);
    await h.instance.onClose();
  });
  test("closing a tag-removal decision restores the capture tag", async () => {
    const h = view();
    h.instance.panelAction.set({
      kind: "unlink",
      linkUid: "link",
      title: "Shopping",
      restoreTagOnCancel: true,
    });
    await h.instance.onClose();
    expect(h.keepLinked).toHaveBeenCalledExactlyOnceWith("link");
    expect(get(h.instance.panelAction)).toBeNull();
  });

  test("closing an ordinary unlink confirmation leaves the link alone", async () => {
    const h = view();
    h.instance.panelAction.set({
      kind: "unlink",
      linkUid: "link",
      title: "Shopping",
    });
    await h.instance.onClose();
    expect(h.keepLinked).not.toHaveBeenCalled();
  });

  test("a failed close-to-restore reports the saved decision for recovery", async () => {
    const h = view(
      vi.fn(async () => {
        throw new Error("Note write unavailable");
      }),
    );
    h.instance.panelAction.set({
      kind: "unlink",
      linkUid: "link",
      title: "Shopping",
      restoreTagOnCancel: true,
    });
    await h.instance.onClose();
    expect(notice).toHaveBeenCalledWith(
      expect.stringContaining("link decision is saved"),
    );
    expect(get(h.instance.panelAction)?.kind).toBe("unlink");
  });
  test("schedule Retry respects both provider deadlines before resuming", async () => {
    const resetTask = vi.fn(() => false);
    const resetCalendar = vi.fn(() => false);
    const retry = vi.fn(async () => {});
    const instance = new TasksView(
      {} as WorkspaceLeaf,
      {
        refresh: vi.fn(async () => {}),
        resetProviderForUserRetry: resetTask,
      } as unknown as TaskService,
      {} as TaskCapture,
      vi.fn(),
      { retry } as never,
      undefined,
      undefined,
      undefined,
      { calendars: vi.fn(), resetForUserRetry: resetCalendar },
    );
    await instance.onOpen();
    const props = vi.mocked(mount).mock.lastCall![1]!.props as {
      retrySchedule(id: string): void;
    };
    props.retrySchedule("schedule");
    expect(resetCalendar).not.toHaveBeenCalled();
    expect(retry).not.toHaveBeenCalled();
    resetTask.mockReturnValue(true);
    props.retrySchedule("schedule");
    expect(resetCalendar).toHaveBeenCalledOnce();
    expect(retry).not.toHaveBeenCalled();
    resetCalendar.mockReturnValue(true);
    props.retrySchedule("schedule");
    expect(retry).toHaveBeenCalledExactlyOnceWith("schedule");
    await instance.onClose();
  });
});
