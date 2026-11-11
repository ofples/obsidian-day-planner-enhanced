import { Modal, type App } from "obsidian";
import { mount, unmount } from "svelte";

import type { TaskScheduler } from "../tasks/schedule";
import type { ScheduleInterval } from "../tasks/schedule-types";
import type { ProviderTask } from "../tasks/types";

import TaskPanelSchedule from "./components/task-panel-schedule.svelte";

/** Standalone timeline entry points share the panel's custom scheduling form. */
export class TaskScheduleModal extends Modal {
  private component?: ReturnType<typeof mount>;

  constructor(
    app: App,
    private readonly scheduler: TaskScheduler,
    private readonly task: ProviderTask,
    private readonly defaultDuration: number,
    private readonly initial?: ScheduleInterval,
  ) {
    super(app);
  }

  onOpen() {
    this.modalEl.addClass("task-panel-modal");
    this.contentEl.addClass("dp-task-panel");
    this.component = mount(TaskPanelSchedule, {
      target: this.contentEl,
      props: {
        scheduler: this.scheduler,
        task: this.task,
        defaultDuration: this.defaultDuration,
        initial: this.initial,
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
