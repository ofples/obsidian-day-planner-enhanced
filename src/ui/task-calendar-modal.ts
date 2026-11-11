import { Modal, type App } from "obsidian";
import { mount, unmount } from "svelte";
import type { Writable } from "svelte/store";

import type { GoogleCalendarSync } from "../google-calendar/service";
import type { DayPlannerSettings } from "../settings";
import type { TaskService } from "../tasks/service";

import TaskPanelCalendars from "./components/task-panel-calendars.svelte";

export class TaskCalendarDisplayModal extends Modal {
  private component?: ReturnType<typeof mount>;
  constructor(
    app: App,
    private readonly service: TaskService,
    private readonly calendar: GoogleCalendarSync,
    private readonly settings: Writable<DayPlannerSettings>,
  ) {
    super(app);
  }
  onOpen() {
    this.modalEl.addClass("task-panel-modal");
    this.contentEl.addClass("dp-task-panel");
    this.component = mount(TaskPanelCalendars, {
      target: this.contentEl,
      props: {
        service: this.service,
        calendar: this.calendar,
        settings: this.settings,
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
