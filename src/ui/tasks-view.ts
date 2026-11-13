import {
  ItemView,
  Notice,
  WorkspaceLeaf,
  type ViewStateResult,
} from "obsidian";
import { mount, unmount } from "svelte";
import { get, writable, type Writable } from "svelte/store";
import type { Readable } from "svelte/store";

import type { GoogleCalendarSync } from "../google-calendar/service";
import type { DayPlannerSettings } from "../settings";
import { taskViewStateSchema } from "../tasks/browser";
import type { TaskCapture } from "../tasks/capture";
import type { CaptureCandidate } from "../tasks/capture-parser";
import type { TaskDeletionController } from "../tasks/deletion";
import type { NoteTaskDrag } from "../tasks/note-drag";
import type { TaskReconciler } from "../tasks/reconcile";
import type { TaskScheduler } from "../tasks/schedule";
import type { TaskService } from "../tasks/service";
import { TaskReadError, type ProviderTask } from "../tasks/types";

import TasksPane from "./components/task-pane-root.svelte";
import type { TaskPanelAction } from "./task-panel-state";
import { TaskScheduleModal } from "./task-schedule-modal";

export const viewTypeTasks = "planner-tasks";

export class TasksView extends ItemView {
  readonly preferences = writable(taskViewStateSchema.parse({}));
  readonly panelAction = writable<TaskPanelAction | null>(null);
  private component?: ReturnType<typeof mount>;
  private stopSavingPreferences?: () => void;

  constructor(
    leaf: WorkspaceLeaf,
    private readonly service: TaskService,
    private readonly capture: TaskCapture,
    private readonly captureSettings: () => void,
    private readonly scheduler?: TaskScheduler,
    private readonly defaultDuration: () => number = () => 30,
    private readonly reconciler?: TaskReconciler,
    private readonly settings?: Writable<DayPlannerSettings>,
    private readonly calendar?: Pick<GoogleCalendarSync, "calendars"> &
      Partial<Pick<GoogleCalendarSync, "resetForUserRetry">>,
    private readonly deleter?: TaskDeletionController,
    private readonly noteTasks?: Readable<CaptureCandidate[]>,
    private readonly noteDrag?: NoteTaskDrag,
    private readonly openConnections?: () => void,
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
    this.stopSavingPreferences?.();
    let previousState = JSON.stringify(get(this.preferences));
    this.stopSavingPreferences = this.preferences.subscribe((state) => {
      const serialized = JSON.stringify(state);
      if (serialized === previousState) return;
      previousState = serialized;
      this.app.workspace.requestSaveLayout();
    });
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
        calendar: this.calendar,
        deleter: this.deleter,
        noteTasks: this.noteTasks,
        noteDrag: this.noteDrag,
        openConnections: this.openConnections,
        scheduleImported: (task: ProviderTask) => {
          if (this.scheduler)
            new TaskScheduleModal(
              this.app,
              this.scheduler,
              task,
              this.defaultDuration(),
            ).open();
        },
        openNote: (path: string, line: number) =>
          handle(
            this.app.workspace.openLinkText(path, "", false, {
              eState: { line },
            }),
          ),
        openSavedNote: (path: string) =>
          handle(this.app.workspace.openLinkText(path, "", false)),
        revealTask: (task: ProviderTask) => {
          if (this.scheduler) handle(this.scheduler.reveal(task.id));
        },
        retrySchedule: (id: string) => {
          if (!this.service.resetProviderForUserRetry()) {
            new Notice("Wait for Todoist's retry deadline before retrying.");
            return;
          }
          if (
            this.calendar?.resetForUserRetry &&
            !this.calendar.resetForUserRetry()
          ) {
            new Notice(
              "Wait for Google Calendar's retry deadline before retrying.",
            );
            return;
          }
          if (this.scheduler) handle(this.scheduler.retry(id));
        },
        completeTask: (task: ProviderTask) =>
          handle(this.service.complete(task)),
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
    this.stopSavingPreferences?.();
    this.stopSavingPreferences = undefined;
    const action = get(this.panelAction);
    if (
      action?.kind === "unlink" &&
      action.restoreTagOnCancel &&
      this.reconciler
    ) {
      try {
        await this.reconciler.keepLinked(action.linkUid);
        this.panelAction.set(null);
      } catch {
        new Notice(
          "The link decision is saved. Reopen Tasks to finish restoring its capture tag.",
        );
      }
    }
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
