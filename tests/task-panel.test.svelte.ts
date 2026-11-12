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
import type { TaskDeletionController, TaskDeletionReview } from "../src/tasks/deletion";
import { taskDeletionSchema } from "../src/tasks/deletion-types";
import { taskOccurrenceSchema } from "../src/tasks/occurrence-types";
import { parseCaptureCandidates } from "../src/tasks/capture-parser";
import { identitySourceKey, type TaskIdentityRepairController, type TaskIdentityReview } from "../src/tasks/identity-repair";
import { identityDecisionSchema } from "../src/tasks/identity-types";
import type { TaskOccurrenceUndoController } from "../src/tasks/occurrence-undo";
import type { TaskOccurrenceUndoReview } from "../src/tasks/occurrence-undo-plan";
import type { TaskOperation } from "../src/tasks/operations";
import type { TaskReconciler } from "../src/tasks/reconcile";
import type { TaskScheduler } from "../src/tasks/schedule";
import { scheduleOperationSchema } from "../src/tasks/schedule-types";
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
const originalShowPopover = HTMLElement.prototype.showPopover;
beforeAll(() => {
  // jsdom lacks the browser popover API. Browser acceptance covers real menus.
  HTMLElement.prototype.hidePopover = vi.fn();
  HTMLElement.prototype.showPopover = vi.fn();
});
afterAll(() => {
  HTMLElement.prototype.hidePopover = originalHidePopover;
  HTMLElement.prototype.showPopover = originalShowPopover;
});
afterEach(async () => {
  for (const component of mounted.splice(0)) await unmount(component);
  document.body.replaceChildren();
});

function render(
  actionValue: TaskPanelAction | null = null,
  reconciler?: TaskReconciler,
  deleter?: TaskDeletionController,
  scheduler?: TaskScheduler,
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
  const retrySchedule = vi.fn();
  const openSavedNote = vi.fn();
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
        deleter,
        scheduler,
        settings: writable(defaultSettingsForTests),
        calendar: { calendars: async () => [] },
        preferences: writable(taskViewStateSchema.parse({})),
        captureSettings: fallbackSettings,
        completeTask: vi.fn(),
        reopenTask: vi.fn(),
        retry: vi.fn(),
        retrySchedule,
        openSavedNote,
        revealTask: vi.fn(),
      },
    }),
  );
  flushSync();
  return { target, state, action, service, mutate, fallbackSettings, capture, retrySchedule, openSavedNote };
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
  function occurrence() {
    const before = {
      ...task,
      completionCount: 0,
      due: {
        date: "2026-11-11",
        text: "every day",
        recurring: true,
        timezone: null,
      },
    };
    const source = {
      path: "History.md",
      from: 0,
      raw: "- [x] Shopping #todoist",
      title: task.title,
    };
    const link = {
      provider: "todoist",
      accountId: snapshot.account.id,
      taskId: task.id,
      source,
      base: before,
    };
    return taskOccurrenceSchema.parse({
      id: crypto.randomUUID(),
      provider: "todoist",
      accountId: snapshot.account.id,
      before: {
        task: before,
        children: [],
        links: {
          old: {
            ...link,
            source: { ...source, raw: "- [ ] Shopping #todoist" },
          },
        },
        projections: {},
      },
      next: {
        ...before,
        completionCount: 1,
        due: { ...before.due, date: "2026-11-12" },
      },
      links: { old: link },
      projections: {},
      phase: "complete",
      recovered: false,
      requestedAt: snapshot.fetchedAt,
      verifiedAt: snapshot.fetchedAt,
    });
  }

  test("occurrence details preserve history separately from the current task and open its saved note", () => {
    const record = occurrence();
    const h = render({ kind: "occurrence", id: record.id });
    h.state.update((state) => ({ ...state, occurrences: [record] }));
    flushSync();
    const history = h.target.querySelector(
      '[aria-label="Recurring occurrence history"]',
    )!;
    expect(history.textContent).toContain("11 Nov 2026");
    expect(history.textContent).toContain("12 Nov 2026");
    expect(history.textContent).toContain("every day");
    expect(history.textContent).toContain(task.description);
    expect(
      Array.from(history.querySelectorAll("button")).some((button) =>
        button.textContent?.includes("Retry"),
      ),
    ).toBe(false);
    Array.from(history.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent?.includes("Open History.md"))!
      .click();
    expect(h.openSavedNote).toHaveBeenCalledWith("History.md");
    expect(h.mutate).not.toHaveBeenCalled();
  });

  function undoHarness() {
    const record = occurrence();
    const review: TaskOccurrenceUndoReview = {
      occurrenceId: record.id,
      provider: record.provider,
      accountId: record.accountId,
      current: record.next!,
      children: [],
      historical: { links: record.links, projections: {} },
      following: {
        links: {
          future: {
            ...record.links.old!,
            source: { ...record.links.old!.source, path: "Following.md" },
          },
        },
        projections: {},
      },
      fingerprint: "original",
      cached: true,
    };
    const controller = {
      review: vi.fn().mockResolvedValue(review),
      confirm: vi.fn().mockResolvedValue({ kind: "saved" }),
      retry: vi.fn(),
      cancel: vi.fn(),
    };
    const reconciler = {
      state: writable({ issues: [], error: "" }),
      occurrenceUndo: controller as unknown as TaskOccurrenceUndoController,
    } as unknown as TaskReconciler;
    const h = render({ kind: "occurrence", id: record.id }, reconciler);
    h.state.update((state) => ({ ...state, occurrences: [record] }));
    flushSync();
    const button = (label: string) =>
      Array.from(h.target.querySelectorAll<HTMLButtonElement>("button")).find(
        (button) => button.textContent?.trim() === label,
      )!;
    return { ...h, record, review, controller, button };
  }

  test("undo reviews source paths, cached state and following checklist conversion before confirmation", async () => {
    const h = undoHarness();
    h.button("Undo this completion").click();
    await vi.waitFor(() => {
      flushSync();
      expect(h.target.textContent).toContain("Restore this occurrence?");
    });
    expect(h.controller.confirm).not.toHaveBeenCalled();
    const review = h.target.querySelector(
      '[aria-label="Review occurrence undo"]',
    )!;
    expect(review.textContent).toContain("Following.md");
    expect(review.textContent).toContain("History.md");
    expect(review.textContent).toContain(
      "Following schedules become local checklists",
    );
    expect(review.textContent).toContain("Using cached task details");
    h.button("Cancel").click();
    flushSync();
    expect(
      h.target.querySelector('[aria-label="Review occurrence undo"]'),
    ).toBeNull();
    expect(h.controller.confirm).not.toHaveBeenCalled();
    expect(h.controller.cancel).not.toHaveBeenCalled();
  });

  test("changed undo details require a second confirmation and lock closing during the saved operation", async () => {
    const h = undoHarness();
    h.controller.confirm.mockResolvedValueOnce({
      kind: "changed",
      review: { ...h.review, fingerprint: "new" },
    });
    h.button("Undo this completion").click();
    await vi.waitFor(() => {
      flushSync();
      expect(h.button("Confirm undo")).toBeTruthy();
    });
    h.button("Confirm undo").click();
    await vi.waitFor(() => {
      flushSync();
      expect(h.target.textContent).toContain("confirm again");
    });
    expect(h.controller.confirm).toHaveBeenCalledOnce();
    let finish!: (value: { kind: string }) => void;
    h.controller.confirm.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    h.button("Confirm undo").click();
    flushSync();
    expect(
      h.target.querySelector<HTMLButtonElement>(
        '[aria-label="Close task form"]',
      )!.disabled,
    ).toBe(true);
    press(
      h.target.querySelector('[aria-label="Recurring occurrence history"]')!,
      "Escape",
    );
    expect(get(h.action)?.kind).toBe("occurrence");
    finish({ kind: "saved" });
    await vi.waitFor(() => {
      flushSync();
      expect(
        h.target.querySelector('[aria-label="Review occurrence undo"]'),
      ).toBeNull();
    });
    expect(h.controller.confirm.mock.calls[1]![0].fingerprint).toBe("new");
  });

  test.each(["pending", "sent", "acknowledged"] as const)(
    "saved %s undo exposes safe recovery controls",
    (status) => {
      const h = undoHarness();
      const command = {
        id: crypto.randomUUID(),
        tempId: crypto.randomUUID(),
        provider: "todoist",
        accountId: "account",
        mutation: { kind: "reopen" as const, taskId: task.id },
        base: h.record.next!,
        status,
        attempts: 0,
        createdAt: snapshot.fetchedAt,
        recurringUndo: {
          occurrenceId: h.record.id,
          completionCount: 0,
          due: h.record.before.task.due!,
        },
      };
      const record = taskOccurrenceSchema.parse({
        ...h.record,
        undo: {
          id: command.id,
          phase: "provider-pending",
          current: h.record.next!,
          children: [],
          historical: h.review.historical,
          following: h.review.following,
          requestedAt: snapshot.fetchedAt,
          error: "Check saved undo",
        },
      });
      h.state.update((state) => ({
        ...state,
        occurrences: [record],
        operations: [command],
      }));
      flushSync();
      expect(h.button("Retry undo recovery")).toBeTruthy();
      expect(Boolean(h.button("Cancel queued undo"))).toBe(
        status === "pending",
      );
      expect(h.target.textContent).toContain("Check saved undo");
      h.button("Retry undo recovery").click();
      expect(h.controller.retry).toHaveBeenCalledWith(record.id);
    },
  );

  function identityHarness() {
    const original = parseCaptureCandidates(
        "Original.md",
        "- [ ] Shopping #todoist",
      )[0]!,
      copy = parseCaptureCandidates("Copy.md", original.raw)[0]!;
    const review: TaskIdentityReview = {
      linkUid: "source",
      provider: "todoist",
      accountId: "account",
      before: {
        links: {
          source: {
            provider: "todoist",
            accountId: "account",
            taskId: task.id,
            base: task,
            source: original,
          },
        },
        projections: {},
        localSources: {},
      },
      sources: [original, copy],
      candidates: [original, copy],
      fingerprint: "initial",
      cached: false,
    };
    const record = identityDecisionSchema.parse({
      id: crypto.randomUUID(),
      fingerprint: "decision",
      provider: "todoist",
      accountId: "account",
      before: review.before,
      assignments: [
        { uid: "source", kind: "linked", source: original },
        { uid: "local", kind: "local", source: copy },
      ],
      phase: "complete",
      createdAt: snapshot.fetchedAt,
    });
    const sourceRepair = {
      review: vi.fn(),
      suggestTree: vi.fn((_review: unknown, uid: string, key: string) => ({
        [uid]: key,
      })),
      confirm: vi.fn(),
    };
    const controller = {
      sourceRepair,
      review: vi.fn().mockResolvedValue(review),
      suggestTree: vi.fn(
        (_review: TaskIdentityReview, uid: string, key: string) => ({
          [uid]: key,
        }),
      ),
      confirm: vi.fn().mockResolvedValue({ kind: "saved", id: record.id }),
      retry: vi.fn(),
      cancel: vi.fn(),
    };
    const reconciler = {
      state: writable({ issues: [], error: "" }),
      identity: controller as unknown as TaskIdentityRepairController,
    } as unknown as TaskReconciler;
    const h = render({ kind: "identity", linkUid: "source" }, reconciler);
    const button = (label: string) =>
      Array.from(h.target.querySelectorAll<HTMLButtonElement>("button")).find(
        (button) => button.textContent?.trim() === label,
      )!;
    return { ...h, review, record, controller, button };
  }

  test("source repair exposes all three actions and saves an explicit existing-source choice", async () => {
    const h = identityHarness();
    h.controller.confirm.mockImplementationOnce(async () => {
      h.state.update((state) => ({ ...state, identityDecisions: [h.record] }));
      return { kind: "saved", id: h.record.id };
    });
    await vi.waitFor(() => {
      flushSync();
      expect(h.button("Keep one linked")).toBeTruthy();
    });
    expect(h.button("Move link")).toBeTruthy();
    expect(h.button("Create separate task")).toBeTruthy();
    h.button("Keep one linked").click();
    flushSync();
    const select = h.target.querySelector<HTMLSelectElement>(
      'select[aria-label="Note source for Shopping"]',
    )!;
    expect(select.value).toBe(identitySourceKey(h.review.sources[0]!));
    expect(select.textContent).toContain("Original.md");
    expect(select.textContent).toContain("Copy.md");
    h.target
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await vi.waitFor(() => {
      flushSync();
      expect(
        h.target.querySelector('[aria-label="Saved task link decision"]'),
      ).not.toBeNull();
    });
    expect(h.controller.confirm).toHaveBeenCalledWith(h.review, {
      linked: { source: identitySourceKey(h.review.sources[0]!) },
      create: [],
    });
    expect(h.target.textContent).toContain("Local checklist");
    expect(h.mutate).not.toHaveBeenCalled();
  });

  test("historical source choices identify the completed occurrence in review and saved history", async () => {
    const h = identityHarness();
    h.review.before.historical = { source: crypto.randomUUID() };
    await vi.waitFor(() => {
      flushSync();
      expect(h.target.textContent).toContain("Completed occurrence");
    });
    const record = identityDecisionSchema.parse({
      ...h.record,
      before: h.review.before,
    });
    h.state.update((state) => ({ ...state, identityDecisions: [record] }));
    h.action.set({ kind: "identity-record", id: record.id });
    flushSync();
    expect(
      h.target.querySelector('[aria-label="Saved task link decision"]')
        ?.textContent,
    ).toContain("Completed occurrence");
    expect(h.mutate).not.toHaveBeenCalled();
  });

  test("separate-task selection preserves the existing link and submits the chosen copy", async () => {
    const h = identityHarness();
    await vi.waitFor(() => {
      flushSync();
      expect(h.button("Create separate task")).toBeTruthy();
    });
    h.button("Create separate task").click();
    flushSync();
    const inputs = h.target.querySelectorAll<HTMLInputElement>(
      'fieldset input[type="checkbox"]',
    );
    expect(inputs[0]!.disabled).toBe(true);
    inputs[1]!.click();
    flushSync();
    h.target
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(h.controller.confirm).toHaveBeenCalledOnce());
    expect(h.controller.confirm.mock.calls[0]![1].create).toEqual([
      identitySourceKey(h.review.sources[1]!),
    ]);
  });

  test("a changed source comparison clears choices and saving locks closing", async () => {
    const h = identityHarness();
    h.controller.confirm.mockResolvedValueOnce({
      kind: "changed",
      review: { ...h.review, fingerprint: "updated" },
    });
    await vi.waitFor(() => {
      flushSync();
      expect(h.button("Keep one linked")).toBeTruthy();
    });
    h.button("Keep one linked").click();
    flushSync();
    h.target
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await vi.waitFor(() => {
      flushSync();
      expect(h.target.textContent).toContain("sources changed");
    });
    expect(h.target.querySelector<HTMLSelectElement>("select")!.value).toBe("");
    let finish!: (value: { kind: string; id: string }) => void;
    h.controller.confirm.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    h.button("Keep one linked").click();
    flushSync();
    h.target
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    flushSync();
    expect(
      h.target.querySelector<HTMLButtonElement>(
        '[aria-label="Close task form"]',
      )!.disabled,
    ).toBe(true);
    press(h.target.querySelector("form")!, "Escape");
    expect(get(h.action)?.kind).toBe("identity");
    finish({ kind: "saved", id: h.record.id });
    await vi.waitFor(() =>
      expect(h.controller.confirm).toHaveBeenCalledTimes(2),
    );
  });

  test("unfinished source recovery opens a custom reassignment form, rechecks changes and locks saving", async () => {
    const h = identityHarness(),
      copy = h.review.sources[1]!,
      other = parseCaptureCandidates(
        "Spare.md",
        "- [ ] Shopping copy #todoist",
      )[0]!;
    const record = identityDecisionSchema.parse({
      ...h.record,
      phase: "creating",
      assignments: [
        h.record.assignments[0],
        { uid: "new", kind: "create", source: copy, draft: task },
      ],
    });
    const review = {
      decision: record,
      links: {
        new: {
          ...h.review.before.links.source!,
          taskId: "created-copy",
          source: copy,
        },
      },
      candidates: [copy, other],
      retained: [copy, other],
      selected: { new: "" },
      fingerprint: "initial",
      guard: "guard",
      cached: true,
    };
    h.controller.sourceRepair.review.mockResolvedValue(review);
    h.controller.sourceRepair.confirm.mockResolvedValueOnce({
      kind: "changed",
      review: { ...review, fingerprint: "updated" },
    });
    h.state.update((state) => ({ ...state, identityDecisions: [record] }));
    h.action.set({ kind: "identity-record", id: record.id });
    flushSync();
    h.button("Repair selected sources").click();
    await vi.waitFor(() => {
      flushSync();
      expect(
        h.target.querySelector('[aria-label="Repair copied task sources"]'),
      ).not.toBeNull();
    });
    expect(h.target.textContent).toContain("Task created");
    expect(h.target.textContent).toContain("Using cached task details");
    const select = h.target.querySelector<HTMLSelectElement>(
      'select[aria-label="Recovery source for Shopping"]',
    )!;
    select.value = identitySourceKey(other);
    select.dispatchEvent(new Event("change", { bubbles: true }));
    flushSync();
    const form = h.target.querySelector<HTMLFormElement>(
      '[aria-label="Repair copied task sources"]',
    )!;
    form.dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true }),
    );
    await vi.waitFor(() => {
      flushSync();
      expect(h.target.textContent).toContain("Review every selected source");
    });
    expect(select.value).toBe("");
    let finish!: (value: { kind: string; id: string }) => void;
    h.controller.sourceRepair.confirm.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    select.value = identitySourceKey(other);
    select.dispatchEvent(new Event("change", { bubbles: true }));
    flushSync();
    form.dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true }),
    );
    flushSync();
    expect(h.button("Cancel source repair").disabled).toBe(true);
    expect(
      h.target.querySelector<HTMLButtonElement>(
        '[aria-label="Close task form"]',
      )!.disabled,
    ).toBe(true);
    press(form, "Escape");
    expect(get(h.action)?.kind).toBe("identity-record");
    finish({ kind: "saved", id: record.id });
    await vi.waitFor(() => {
      flushSync();
      expect(
        h.target.querySelector('[aria-label="Repair copied task sources"]'),
      ).toBeNull();
    });
    expect(h.controller.sourceRepair.confirm).toHaveBeenLastCalledWith(
      expect.objectContaining({ fingerprint: "updated" }),
      { new: identitySourceKey(other) },
    );
    expect(h.mutate).not.toHaveBeenCalled();
  });

  test("cancelling the source reassignment form preserves the pending decision", async () => {
    const h = identityHarness(),
      copy = h.review.sources[1]!;
    const record = identityDecisionSchema.parse({
      ...h.record,
      phase: "creating",
      assignments: [
        h.record.assignments[0],
        { uid: "new", kind: "create", source: copy, draft: task },
      ],
    });
    h.controller.sourceRepair.review.mockResolvedValue({
      decision: record,
      links: {
        new: { ...h.review.before.links.source!, taskId: null, source: copy },
      },
      candidates: [copy],
      retained: [copy],
      selected: { new: identitySourceKey(copy) },
      fingerprint: "initial",
      guard: "guard",
      cached: false,
    });
    h.state.update((state) => ({ ...state, identityDecisions: [record] }));
    h.action.set({ kind: "identity-record", id: record.id });
    flushSync();
    h.button("Repair selected sources").click();
    await vi.waitFor(() => {
      flushSync();
      expect(h.button("Cancel source repair")).toBeTruthy();
    });
    h.button("Cancel source repair").click();
    flushSync();
    expect(
      h.target.querySelector('[aria-label="Saved task link decision"]'),
    ).not.toBeNull();
    expect(h.controller.sourceRepair.confirm).not.toHaveBeenCalled();
    expect(h.controller.cancel).not.toHaveBeenCalled();
    expect(h.mutate).not.toHaveBeenCalled();
  });
  test.each([true, false])(
    "saved source recovery uses its durable cancellability value %s",
    (cancellable) => {
      const h = identityHarness();
      const record = identityDecisionSchema.parse({
        ...h.record,
        phase: "creating",
        assignments: [
          h.record.assignments[0],
          {
            uid: "new",
            kind: "create",
            source: h.review.sources[1],
            draft: task,
          },
        ],
        error: "Waiting for source recovery",
      });
      h.state.update((state) => ({
        ...state,
        identityDecisions: [{ ...record, cancellable }],
      }));
      h.action.set({ kind: "identity-record", id: record.id });
      flushSync();
      expect(
        h.target.querySelector('[aria-label="Saved task link decision"]')
          ?.textContent,
      ).toContain("Waiting for source recovery");
      expect(Boolean(h.button("Cancel queued decision"))).toBe(cancellable);
      if (cancellable) {
        h.button("Cancel queued decision").click();
        expect(h.controller.cancel).toHaveBeenCalledWith(record.id);
      } else {
        h.button("Retry source recovery").click();
        expect(h.controller.retry).toHaveBeenCalledWith(record.id);
      }
    },
  );

  test("external history identifies the current task as observed after completion", () => {
    const record = taskOccurrenceSchema.parse({
      ...occurrence(),
      external: true,
      recovered: true,
      next: { ...occurrence().next!, completionCount: 3 },
    });
    const h = render({ kind: "occurrence", id: record.id });
    h.state.update((state) => ({ ...state, occurrences: [record] }));
    flushSync();
    const history = h.target.querySelector(
      '[aria-label="Recurring occurrence history"]',
    )!;
    expect(history.textContent).toContain("Current occurrence when observed");
    expect(history.textContent).toContain("Completed in Todoist");
    expect(history.textContent).toContain("advanced by 3 between observations");
    expect(history.textContent).not.toContain(
      "Recovered from the saved command",
    );
    expect(h.mutate).not.toHaveBeenCalled();
  });

  test("multiple completed occurrences retain distinct rows for the same remote task", () => {
    const first = occurrence();
    const second = {
      ...occurrence(),
      before: { ...first.before, task: first.next! },
      next: {
        ...first.next!,
        completionCount: 2,
        due: { ...first.next!.due!, date: "2026-11-13" },
      },
    };
    const h = render();
    h.state.update((state) => ({ ...state, occurrences: [first, second] }));
    flushSync();
    const history = Array.from(h.target.querySelectorAll("details")).find(
      (element) =>
        element
          .querySelector("summary")
          ?.textContent?.includes("Completed occurrences"),
    )!;
    expect(history.querySelectorAll(".task-completed-row")).toHaveLength(2);
    history.querySelector<HTMLButtonElement>("button")!.click();
    flushSync();
    expect(get(h.action)).toEqual({ kind: "occurrence", id: second.id });
  });

  test("failed history writes expose their retry and retain errors in the custom form", async () => {
    const record = {
      ...occurrence(),
      phase: "freezing" as const,
      error: "Historical note unavailable",
    };
    const retryOccurrence = vi
      .fn()
      .mockRejectedValue(new Error("Restore the original block"));
    const reconciler = {
      state: writable({ issues: [], error: "" }),
      retryOccurrence,
    } as unknown as TaskReconciler;
    const h = render({ kind: "occurrence", id: record.id }, reconciler);
    h.state.update((state) => ({ ...state, occurrences: [record] }));
    flushSync();
    expect(
      h.target.querySelector("details.task-review summary")?.textContent,
    ).toContain("1 needs review");
    const form = h.target.querySelector(
      '[aria-label="Recurring occurrence history"]',
    )!;
    Array.from(form.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent?.includes("Retry history"))!
      .click();
    await vi.waitFor(() =>
      expect(form.textContent).toContain("Restore the original block"),
    );
    expect(retryOccurrence).toHaveBeenCalledWith(record.id);
    expect(h.mutate).not.toHaveBeenCalled();
  });
  test("exporter preflight failures expose a retry in the review disclosure", () => {
    const operation = scheduleOperationSchema.parse({
      id: crypto.randomUUID(), provider: "todoist", accountId: "account", task,
      linkUid: "source", googleUid: "calendar-source", providerOperationId: crypto.randomUUID(),
      occurrenceKey: "single", target: { kind: "schedule", interval: { start: "2026-11-20T03:30:00Z", end: "2026-11-20T04:00:00Z" } },
      children: [], raw: "- [ ] Shopping #todoist", generatedTaskIds: [task.id], syncTaskDate: true,
      phase: "provider-pending", createdAt: snapshot.fetchedAt, error: "Todoist is already exporting into this managed calendar.",
    });
    const scheduler = { state: writable({ operations: [operation], projections: [], error: "" }) } as unknown as TaskScheduler;
    const h = render(null, undefined, undefined, scheduler);
    const review = h.target.querySelector<HTMLDetailsElement>("details.task-review")!;
    expect(review.querySelector("summary")?.textContent).toContain("1 needs review");
    expect(review.textContent).toContain("already exporting");
    review.querySelector<HTMLButtonElement>("button")!.click();
    expect(h.retrySchedule).toHaveBeenCalledWith(operation.id);
  });

  function deletionController() {
    const record = taskDeletionSchema.parse({
      id: crypto.randomUUID(), provider: "todoist", accountId: snapshot.account.id,
      taskId: task.id, tasks: [task], links: {}, projections: {}, phase: "pending", createdAt: snapshot.fetchedAt,
    });
    const review: TaskDeletionReview = { record, fingerprint: "original", cached: false };
    const state = writable({ records: [record], error: "" });
    const confirm = vi.fn<TaskDeletionController["confirm"]>().mockResolvedValue({ kind: "saved", id: record.id });
    const controller = { state, review: vi.fn().mockResolvedValue(review), confirm, cancel: vi.fn(), retry: vi.fn() } as unknown as TaskDeletionController;
    return { controller, state, record, review, confirm };
  }

  test("large lists create one action menu on demand for the current task", async () => {
    const h = render();
    const tasks = Array.from({ length: 2000 }, (_, index) => ({ ...task, id: `task-${index}`, title: `Task ${index}`, order: index }));
    h.state.update(state => ({ ...state, snapshot: { ...snapshot, tasks } }));
    flushSync();
    expect(h.target.querySelectorAll(".task-row-container")).toHaveLength(2000);
    expect(h.target.querySelectorAll('[role="menu"]')).toHaveLength(0);
    h.target.querySelector<HTMLButtonElement>('[aria-label="Actions for Task 1999"]')!.click();
    await vi.waitFor(() => expect(h.target.querySelector('[role="menu"]')?.getAttribute("aria-label")).toBe("Actions for Task 1999"));
    expect(h.target.querySelectorAll('[role="menu"]')).toHaveLength(1);
    expect(h.target.querySelector<HTMLAnchorElement>('[role="menu"] a')?.href).toMatch(/\/task\/task-1999$/);
    h.target.querySelector<HTMLButtonElement>('[aria-label="Actions for Task 0"]')!.click();
    await vi.waitFor(() => expect(h.target.querySelector('[role="menu"]')?.getAttribute("aria-label")).toBe("Actions for Task 0"));
    expect(h.target.querySelectorAll('[role="menu"]')).toHaveLength(1);
    h.state.update(state => ({ ...state, snapshot: { ...snapshot, tasks: [{ ...tasks[0]!, title: "Renamed task" }] } }));
    flushSync();
    expect(h.target.querySelector('[role="menu"]')?.getAttribute("aria-label")).toBe("Actions for Renamed task");
    h.state.update(state => ({ ...state, snapshot: { ...snapshot, tasks: [] } }));
    flushSync();
    expect(h.target.querySelector('[role="menu"]')).toBeNull();
    expect(h.mutate).not.toHaveBeenCalled();
  });

  test("task action menus keep keyboard navigation and return focus on Escape", async () => {
    const h = render();
    const trigger = h.target.querySelector<HTMLButtonElement>('[aria-label="Actions for Shopping"]')!;
    trigger.focus();
    press(trigger, "ArrowDown");
    await vi.waitFor(() => expect(document.activeElement?.textContent).toContain("Edit task"));
    const menu = h.target.querySelector<HTMLElement>('[role="menu"]')!;
    press(menu, "End");
    expect(document.activeElement?.textContent).toContain("Open in Todoist");
    press(menu, "Home");
    expect(document.activeElement?.textContent).toContain("Edit task");
    press(menu, "ArrowUp");
    expect(document.activeElement?.textContent).toContain("Open in Todoist");
    press(menu, "Escape");
    expect(document.activeElement).toBe(trigger);
    expect(h.mutate).not.toHaveBeenCalled();
  });

  test("cached task action menus focus the available provider link", async () => {
    const h = render();
    h.state.update(state => ({ ...state, writable: false }));
    flushSync();
    const row = h.target.querySelector<HTMLButtonElement>(".task-row")!;
    row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(document.activeElement?.textContent).toContain("Open in Todoist"));
    expect(h.target.querySelector<HTMLButtonElement>('[role="menu"] button')?.disabled).toBe(true);
    expect(h.mutate).not.toHaveBeenCalled();
  });

  test("task menus open the custom permanent-deletion confirmation", async () => {
    const deletion = deletionController();
    deletion.state.set({ records: [], error: "" });
    const h = render(null, undefined, deletion.controller);
    h.state.update(state => ({ ...state, snapshot: { ...snapshot, account: { ...snapshot.account, capabilities: { delete: true } } } }));
    flushSync();
    h.target.querySelector<HTMLButtonElement>('[aria-label="Actions for Shopping"]')!.click();
    await vi.waitFor(() => expect(h.target.querySelector('[role="menu"]')).not.toBeNull());
    const button = Array.from(h.target.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')).find(button => button.textContent?.includes("Delete from Todoist"))!;
    button.click();
    await vi.waitFor(() => { flushSync(); expect(h.target.querySelector('form[aria-label="Confirm task deletion"]')?.textContent).toContain("Shopping"); });
    expect(deletion.confirm).not.toHaveBeenCalled();
    Array.from(h.target.querySelectorAll<HTMLButtonElement>("button")).find(button => button.textContent === "Cancel")!.click();
    flushSync();
    expect(get(h.action)).toBe(null);
    expect(deletion.confirm).not.toHaveBeenCalled();
  });

  test("saving deletion holds the form open until its durable confirmation completes", async () => {
    const deletion = deletionController();
    let finish!: (result: Awaited<ReturnType<TaskDeletionController["confirm"]>>) => void;
    deletion.confirm.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const h = render({ kind: "delete", task }, undefined, deletion.controller);
    await vi.waitFor(() => { flushSync(); expect(h.target.querySelector('button[type="submit"]')).not.toBeNull(); });
    h.target.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(deletion.confirm).toHaveBeenCalledOnce());
    press(h.target.querySelector("form")!, "Escape");
    expect(get(h.action)?.kind).toBe("delete");
    expect(h.target.querySelector<HTMLButtonElement>('[aria-label="Close task form"]')?.disabled).toBe(true);
    finish({ kind: "saved", id: deletion.record.id });
    await vi.waitFor(() => { flushSync(); expect(get(h.action)).toBe(null); });
  });

  test("changed confirmation details remain visible and require another submission", async () => {
    const deletion = deletionController();
    deletion.confirm.mockResolvedValueOnce({ kind: "changed", review: { ...deletion.review, fingerprint: "changed", record: { ...deletion.record, tasks: [{ ...task, title: "New title" }] } } });
    const h = render({ kind: "delete", task }, undefined, deletion.controller);
    await vi.waitFor(() => { flushSync(); expect(h.target.querySelector('button[type="submit"]')).not.toBeNull(); });
    h.target.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await vi.waitFor(() => { flushSync(); expect(h.target.textContent).toContain("New title"); });
    expect(get(h.action)?.kind).toBe("delete");
    expect(deletion.confirm).toHaveBeenCalledOnce();
    expect(h.target.textContent).toContain("confirm again");
  });

  test("completed deletion history opens its saved details when the active list is empty", () => {
    const deletion = deletionController();
    deletion.state.set({ records: [{ ...deletion.record, phase: "complete" }], error: "" });
    const h = render(null, undefined, deletion.controller);
    h.state.update(state => ({ ...state, snapshot: { ...snapshot, tasks: [] } }));
    flushSync();
    expect(h.target.textContent).toContain("Deletion history");
    Array.from(h.target.querySelectorAll<HTMLButtonElement>("button")).find(button => button.textContent === "Review")!.click();
    flushSync();
    expect(h.target.querySelector('[aria-label="Task deletion recovery"]')?.textContent).toContain("Groceries");
    expect(h.target.textContent).toContain("Deletion verified");
  });

  test("restored identity issues offer a recheck without entering project capture", () => {
    const h = render();
    h.capture.state.set({
      issues: [
        {
          kind: "identity",
          candidate: parseCaptureCandidates(
            "Tasks.md",
            "- [ ] Shopping #todoist",
          )[0]!,
          message: "Keep one original block, then recheck its link.",
        },
      ],
      identityIssues: [],
      error: "",
    });
    flushSync();
    const buttons = Array.from(h.target.querySelectorAll("button"));
    expect(
      buttons.some((button) => button.textContent === "Choose project"),
    ).toBe(false);
    buttons.find((button) => button.textContent === "Recheck link")!.click();
    flushSync();
    expect(h.capture.scan).toHaveBeenCalledOnce();
    expect(get(h.action)).toBeNull();
  });
  test("capture settings opens calendar feeds in the same custom panel", () => {
    const h = render({ kind: "settings" });
    const button = Array.from(h.target.querySelectorAll("button")).find(
      (item) => item.textContent === "Task calendar feeds",
    )!;
    button.click();
    flushSync();
    expect(get(h.action)?.kind).toBe("calendars");
    expect(
      h.target.querySelector('form[aria-label="Task calendar feeds"]'),
    ).not.toBeNull();
    expect(h.fallbackSettings).not.toHaveBeenCalled();
  });
  test.each(["Cancel", "Close", "Escape"])(
    "%s restores a removed capture tag before closing its decision",
    async (close) => {
      const keepLinked = vi.fn(async () => {});
      const reconciler = {
        state: writable({ issues: [], error: "" }),
        keepLinked,
      } as unknown as TaskReconciler;
      const h = render(
        {
          kind: "unlink",
          linkUid: "link",
          title: "Shopping",
          restoreTagOnCancel: true,
        },
        reconciler,
      );
      if (close === "Cancel")
        h.target
          .querySelector<HTMLButtonElement>(
            ".task-action-area .task-text-button",
          )!
          .click();
      else if (close === "Close")
        h.target
          .querySelector<HTMLButtonElement>('[aria-label="Close task form"]')!
          .click();
      else press(h.target.querySelector("section")!, "Escape");
      await vi.waitFor(() => expect(get(h.action)).toBeNull());
      expect(keepLinked).toHaveBeenCalledExactlyOnceWith("link");
    },
  );

  test("switching forms restores a removed capture tag before opening the next editor", async () => {
    let finish!: () => void;
    const keepLinked = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const reconciler = {
      state: writable({ issues: [], error: "" }),
      keepLinked,
    } as unknown as TaskReconciler;
    const h = render(
      {
        kind: "unlink",
        linkUid: "link",
        title: "Shopping",
        restoreTagOnCancel: true,
      },
      reconciler,
    );
    h.target
      .querySelector<HTMLButtonElement>('[aria-label="New task"]')!
      .click();
    flushSync();
    expect(keepLinked).toHaveBeenCalledOnce();
    expect(get(h.action)?.kind).toBe("unlink");
    expect(h.target.textContent).toContain("Restoring link…");
    finish();
    await vi.waitFor(() => expect(get(h.action)?.kind).toBe("create"));
    expect(
      h.target.querySelector<HTMLInputElement>('[aria-label="Task title"]')
        ?.value,
    ).toBe("");
  });

  test("a failed tag restoration retains the decision and error for retry", async () => {
    const keepLinked = vi.fn(async () => {
      throw new Error("The tag restoration is saved. Retry its note write.");
    });
    const reconciler = {
      state: writable({ issues: [], error: "" }),
      keepLinked,
    } as unknown as TaskReconciler;
    const h = render(
      {
        kind: "unlink",
        linkUid: "link",
        title: "Shopping",
        restoreTagOnCancel: true,
      },
      reconciler,
    );
    h.target
      .querySelector<HTMLButtonElement>('[aria-label="Close task form"]')!
      .click();
    await vi.waitFor(() =>
      expect(h.target.textContent).toContain("Retry its note write"),
    );
    expect(get(h.action)?.kind).toBe("unlink");
    expect(
      h.target.querySelector<HTMLButtonElement>(
        '[aria-label="Close task form"]',
      )?.disabled,
    ).toBe(false);
  });

  test("confirming unlink after capture-tag removal skips tag restoration", async () => {
    const unlink = vi.fn(async () => {}),
      keepLinked = vi.fn(async () => {});
    const reconciler = {
      state: writable({ issues: [], error: "" }),
      unlink,
      keepLinked,
    } as unknown as TaskReconciler;
    const h = render(
      {
        kind: "unlink",
        linkUid: "link",
        title: "Shopping",
        restoreTagOnCancel: true,
      },
      reconciler,
    );
    h.target
      .querySelector<HTMLButtonElement>(".task-action-area .task-primary")!
      .click();
    await vi.waitFor(() => expect(get(h.action)).toBeNull());
    expect(unlink).toHaveBeenCalledExactlyOnceWith("link");
    expect(keepLinked).not.toHaveBeenCalled();
  });

  test("capture-tag removal opens its own link decision from the compact review list", () => {
    const reconciler = {
      state: writable({
        issues: [
          {
            id: crypto.randomUUID(),
            provider: "todoist",
            accountId: "account",
            linkUid: "link",
            taskId: task.id,
            fields: ["unlink"],
            remote: task,
            message: "The capture tag was removed.",
            source: {
              path: "Tasks.md",
              from: 0,
              raw: "- [ ] Shopping",
              title: "Shopping",
            },
          },
        ],
        error: "",
      }),
    } as unknown as TaskReconciler;
    const h = render(null, reconciler);
    const disclosure =
      h.target.querySelector<HTMLDetailsElement>(".task-review")!;
    disclosure.open = true;
    disclosure.dispatchEvent(new Event("toggle"));
    flushSync();
    expect(disclosure.open).toBe(true);
    const review = Array.from(
      h.target.querySelectorAll<HTMLButtonElement>(".task-review button"),
    ).find((button) => button.textContent === "Review link")!;
    expect(review).toBeDefined();
    review.click();
    flushSync();
    expect(get(h.action)).toEqual({
      kind: "unlink",
      linkUid: "link",
      title: "Shopping",
      restoreTagOnCancel: true,
    });
    expect(disclosure.open).toBe(false);
    expect(h.target.textContent?.replace(/\s+/g, " ")).toContain(
      "separately. Cancel restores #todoist",
    );
  });

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
    expect(h.target.textContent?.replace(/\s+/g, " ")).toContain(
      "separately. Remove its #todoist",
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

  function stateRestoreFixture(canRestore = true, readError?: Error) {
    const h = render();
    const review = { fingerprint: "a".repeat(64), loaded: { readable: true, version: 19, namespace: "vault", commands: 1, links: 1 }, saved: { readable: true, version: 19, namespace: "vault", commands: 3, links: 2 }, canRestore };
    const reviewRestoration = readError ? vi.fn().mockRejectedValue(readError) : vi.fn().mockResolvedValue(review);
    const restoreTracking = vi.fn<TaskService["restoreTracking"]>().mockResolvedValue({ kind: "saved" });
    Object.assign(h.service, { registry: { reviewRestoration }, restoreTracking });
    h.state.update(state => ({ ...state, writable: false, restoration: review }));
    flushSync();
    Array.from(h.target.querySelectorAll<HTMLButtonElement>("button")).find(button => button.textContent === "Review tracking")!.click();
    flushSync();
    return { ...h, review, reviewRestoration, restoreTracking };
  }

  test("tracking repair is reachable while cached task writes are held and Cancel keeps recovery visible", async () => {
    const h = stateRestoreFixture();
    await vi.waitFor(() => expect(h.target.querySelector('[aria-label="Saved tracking"]')?.textContent).toContain("3 saved commands"));
    expect(h.target.querySelector<HTMLButtonElement>('[aria-label="Refresh tasks"]')?.disabled).toBe(true);
    expect(h.target.textContent).not.toContain("Saved task tracking needs review");
    const form = h.target.querySelector('form[aria-label="Restore saved task tracking"]')!;
    expect(form.querySelector("details")?.textContent).toContain("separate checkpoint");
    Array.from(form.querySelectorAll<HTMLButtonElement>("button")).find(button => button.textContent === "Cancel")!.click();
    flushSync();
    expect(get(h.action)).toBeNull();
    expect(h.target.textContent).toContain("Saved task tracking needs review");
    expect(h.restoreTracking).not.toHaveBeenCalled();
    expect(h.mutate).not.toHaveBeenCalled();
  });

  test("tracking repair refreshes changed comparisons and holds close and Escape during persistence", async () => {
    const h = stateRestoreFixture();
    await vi.waitFor(() => expect(h.target.querySelector('form button[type="submit"]')).not.toBeNull());
    let finish!: (result: Awaited<ReturnType<TaskService["restoreTracking"]>>) => void;
    h.restoreTracking.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const form = h.target.querySelector("form")!;
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(h.restoreTracking).toHaveBeenCalledOnce());
    h.state.update(state => ({ ...state, restoration: null, needsTrackingReadback: true }));
    flushSync();
    expect(h.target.textContent).not.toContain("Tracking restored. Refresh tasks");
    press(form, "Escape");
    expect(get(h.action)?.kind).toBe("state-recovery");
    expect(h.target.querySelector<HTMLButtonElement>('[aria-label="Close task form"]')?.disabled).toBe(true);
    finish({ kind: "changed", review: { ...h.review, fingerprint: "b".repeat(64), saved: { ...h.review.saved, commands: 4 } } });
    await vi.waitFor(() => expect(form.textContent).toContain("tracking files changed"));
    expect(form.textContent).toContain("4 saved commands");
    expect(h.target.querySelector<HTMLButtonElement>('[aria-label="Close task form"]')?.disabled).toBe(false);
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(get(h.action)).toBeNull());
    expect(h.restoreTracking).toHaveBeenLastCalledWith(expect.objectContaining({ fingerprint: "b".repeat(64) }));
    expect(h.mutate).not.toHaveBeenCalled();
  });

  test("unsupported tracking comparisons hold confirmation and review loading errors can retry", async () => {
    const blocked = stateRestoreFixture(false);
    await vi.waitFor(() => expect(blocked.target.querySelector('form button[type="submit"]')?.hasAttribute("disabled")).toBe(true));
    blocked.target.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    expect(blocked.restoreTracking).not.toHaveBeenCalled();
    const h = stateRestoreFixture(true, new Error("Tracking temporarily unavailable"));
    await vi.waitFor(() => expect(h.target.textContent).toContain("Tracking temporarily unavailable"));
    h.reviewRestoration.mockResolvedValue(h.review);
    Array.from(h.target.querySelectorAll<HTMLButtonElement>("button")).find(button => button.textContent === "Retry review")!.click();
    await vi.waitFor(() => expect(h.target.querySelector('[aria-label="Saved tracking"]')?.textContent).toContain("3 saved commands"));
    expect(h.restoreTracking).not.toHaveBeenCalled();
  });

  test("failed tracking confirmation remains retryable", async () => {
    const h = stateRestoreFixture();
    await vi.waitFor(() => expect(h.target.querySelector('form button[type="submit"]')).not.toBeNull());
    h.restoreTracking.mockRejectedValueOnce(new Error("Backup unavailable"));
    h.target.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(h.target.textContent).toContain("Backup unavailable"));
    expect(get(h.action)?.kind).toBe("state-recovery");
    expect(h.target.querySelector<HTMLButtonElement>('form button[type="submit"]')?.disabled).toBe(false);
    expect(h.mutate).not.toHaveBeenCalled();
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
