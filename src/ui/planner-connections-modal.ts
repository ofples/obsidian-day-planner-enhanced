import { Modal, type App } from "obsidian";
import { mount, unmount } from "svelte";

import type { GoogleCalendarSync } from "../google-calendar/service";
import type { TaskService } from "../tasks/service";

import PlannerConnections from "./components/planner-connections.svelte";

export class PlannerConnectionsModal extends Modal {
  private component?: ReturnType<typeof mount>;
  constructor(
    app: App,
    private readonly service: TaskService,
    private readonly calendar: GoogleCalendarSync,
  ) {
    super(app);
  }
  onOpen() {
    this.modalEl.addClass("task-panel-modal", "planner-connections-modal");
    this.component = mount(PlannerConnections, {
      target: this.contentEl,
      props: {
        service: this.service,
        calendar: this.calendar,
        close: () => this.close(),
      },
    });
  }
  onClose() {
    if (this.component) void unmount(this.component);
    this.component = undefined;
    this.contentEl.empty();
  }
}
