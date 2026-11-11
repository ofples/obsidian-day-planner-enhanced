import {
  ItemView,
  Notice,
  WorkspaceLeaf,
  type ViewStateResult,
} from "obsidian";
import { mount, unmount } from "svelte";
import { get, writable, type Writable } from "svelte/store";

import type { DayPlannerSettings } from "../settings";
import { taskViewStateSchema } from "../tasks/browser";
import type { TaskCapture } from "../tasks/capture";
import type { TaskReconciler } from "../tasks/reconcile";
import type { TaskScheduler } from "../tasks/schedule";
import type { TaskService } from "../tasks/service";
import { TaskReadError, type ProviderTask } from "../tasks/types";

import TasksPane from "./components/tasks-pane.svelte";
import type { TaskPanelAction } from "./task-panel-state";

export const viewTypeTasks = "planner-tasks";

export class TasksView extends ItemView {
  readonly preferences = writable(taskViewStateSchema.parse({}));
  readonly panelAction = writable<TaskPanelAction | null>(null);
  private component?: ReturnType<typeof mount>;

  constructor(
    leaf: WorkspaceLeaf,
    private readonly service: TaskService,
    private readonly capture: TaskCapture,
    private readonly captureSettings: () => void,
    private readonly scheduler?: TaskScheduler,
    private readonly defaultDuration: () => number = () => 30,
    private readonly reconciler?: TaskReconciler,
    private readonly settings?: Writable<DayPlannerSettings>,
  ) {
    super(leaf);
  }

  getViewType() {
    return viewTypeTasks;
  }
  getDisplayText() {
    return "Tasks";
  }
  getIcon() {
    return "list-todo";
  }
  getState() {
    return get(this.preferences);
  }

  async setState(state: unknown, result: ViewStateResult) {
    const parsed = taskViewStateSchema.safeParse(state);
    this.preferences.set(
      parsed.success ? parsed.data : taskViewStateSchema.parse({}),
    );
    await super.setState(state, result);
  }

  async onOpen() {
    this.contentEl.addClass("day-planner-tasks-view");
    const handle = (operation: Promise<unknown>) => {
      void operation.catch((error: unknown) => {
        new Notice(
          error instanceof TaskReadError
            ? error.message
            : "Could not save this task change. Try again.",
        );
      });
    };
    this.component = mount(TasksPane, {
      target: this.contentEl,
      props: {
        service: this.service,
        capture: this.capture,
        reconciler: this.reconciler,
        scheduler: this.scheduler,
        action: this.panelAction,
        defaultDuration: this.defaultDuration(),
        preferences: this.preferences,
        captureSettings: this.captureSettings,
        settings: this.settings,
        revealTask: (task: ProviderTask) => {
          if (this.scheduler) handle(this.scheduler.reveal(task.id));
        },
        retrySchedule: (id: string) => {
          if (this.scheduler) handle(this.scheduler.retry(id));
        },
        completeTask: (task: ProviderTask) =>
          handle(this.service.mutate({ kind: "complete", taskId: task.id })),
        reopenTask: (task: ProviderTask) =>
          handle(this.service.mutate({ kind: "reopen", taskId: task.id })),
        retry: (id: string) => handle(this.service.retryOperation(id)),
      },
    });
    void this.service.refresh();
    this.registerInterval(
      window.setInterval(() => {
        if (this.containerEl.isShown()) void this.service.refresh();
      }, 60_000),
    );
  }

  async onClose() {
    if (this.component) await unmount(this.component);
    this.component = undefined;
    this.contentEl.removeClass("day-planner-tasks-view");
  }

  scheduleTask(task?: ProviderTask) {
    const selected =
      task ??
      get(this.service.state).snapshot?.tasks.find(
        (item) => item.id === get(this.preferences).selectedId,
      );
    if (!selected || !this.scheduler) {
      new Notice(
        "Select a connected task in the Tasks pane before scheduling.",
      );
      return;
    }
    this.panelAction.set({ kind: "schedule", task: selected });
  }
}
