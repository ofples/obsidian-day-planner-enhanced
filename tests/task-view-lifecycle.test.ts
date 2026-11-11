import type { WorkspaceLeaf } from "obsidian";
import { get } from "svelte/store";
import { beforeEach, describe, expect, test, vi } from "vitest";

import type { TaskCapture } from "../src/tasks/capture";
import type { TaskReconciler } from "../src/tasks/reconcile";
import type { TaskService } from "../src/tasks/service";
import { TasksView } from "../src/ui/tasks-view";

const notice = vi.hoisted(() => vi.fn());
vi.mock("obsidian", () => ({
  ItemView: class {
    contentEl = { removeClass: vi.fn() };
  },
  Notice: notice,
}));

beforeEach(() => notice.mockClear());

function view(keepLinked = vi.fn(async () => {})) {
  return {
    keepLinked,
    instance: new TasksView(
      {} as WorkspaceLeaf,
      {} as TaskService,
      {} as TaskCapture,
      vi.fn(),
      undefined,
      undefined,
      { keepLinked } as unknown as TaskReconciler,
    ),
  };
}

describe("Tasks view link decisions", () => {
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
});
