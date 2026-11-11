import { Modal, type App } from "obsidian";
import { mount, unmount } from "svelte";
import type { Writable } from "svelte/store";

import type { DayPlannerSettings } from "../settings";
import type { CaptureIssue, TaskCapture } from "../tasks/capture";
import type { TaskService } from "../tasks/service";

import TaskPanelCaptureSettings from "./components/task-panel-capture-settings.svelte";
import TaskPanelRoute from "./components/task-panel-route.svelte";

export class TaskCaptureSettingsModal extends Modal {
  private component?: ReturnType<typeof mount>;
  constructor(
    app: App,
    private readonly service: TaskService,
    private readonly settings: Writable<DayPlannerSettings>,
    private readonly capture: TaskCapture,
  ) {
    super(app);
  }
  onOpen() {
    this.modalEl.addClass("task-panel-modal");
    this.contentEl.addClass("dp-task-panel");
    this.component = mount(TaskPanelCaptureSettings, {
      target: this.contentEl,
      props: {
        service: this.service,
        settings: this.settings,
        capture: this.capture,
        saved: () => this.close(),
        cancel: () => this.close(),
      },
    });
  }
  onClose() {
    if (this.component) void unmount(this.component);
    this.component = undefined;
    this.contentEl.empty();
  }
}

export class TaskCaptureRouteModal extends Modal {
  private component?: ReturnType<typeof mount>;
  constructor(
    app: App,
    private readonly issue: CaptureIssue,
    private readonly service: TaskService,
    private readonly capture: TaskCapture,
  ) {
    super(app);
  }
  onOpen() {
    this.modalEl.addClass("task-panel-modal");
    this.contentEl.addClass("dp-task-panel");
    this.component = mount(TaskPanelRoute, {
      target: this.contentEl,
      props: {
        service: this.service,
        capture: this.capture,
        issue: this.issue,
        saved: () => this.close(),
        cancel: () => this.close(),
      },
    });
  }
  onClose() {
    if (this.component) void unmount(this.component);
    this.component = undefined;
    this.contentEl.empty();
  }
}
