import {
  ItemView,
  Modal,
  Notice,
  Setting,
  WorkspaceLeaf,
  type ViewStateResult,
} from "obsidian";
import { mount, unmount } from "svelte";
import { get, writable } from "svelte/store";

import { taskViewStateSchema } from "../tasks/browser";
import type { TaskCapture, CaptureIssue } from "../tasks/capture";
import type { TaskService } from "../tasks/service";
import { TaskReadError, type ProviderTask } from "../tasks/types";

import TasksPane from "./components/tasks-pane.svelte";
import { TaskCaptureRouteModal } from "./task-capture-modal";
import { TaskEditorModal } from "./task-editor-modal";

export const viewTypeTasks = "planner-tasks";

export class TaskConnectModal extends Modal {
  constructor(
    app: ItemView["app"],
    private readonly service: TaskService,
  ) {
    super(app);
  }

  onOpen() {
    this.titleEl.setText("Connect Todoist");
    let token = "";
    let replaceAccount = false;
    const status = this.contentEl.createEl("p", { attr: { role: "status" } });
    new Setting(this.contentEl).setName("API token").addText((text) => {
      text.inputEl.type = "password";
      text.inputEl.autocomplete = "off";
      text.inputEl.setAttribute("aria-label", "Todoist API token");
      text.onChange((value) => {
        token = value;
      });
    });
    this.contentEl.createEl("a", {
      text: "Find your API token",
      href: "https://app.todoist.com/app/settings/integrations/developer",
      attr: { target: "_blank", rel: "noopener noreferrer" },
    });
    if (get(this.service.state).snapshot)
      new Setting(this.contentEl)
        .setName("Switch account")
        .setDesc(
          "Allow replacing this connection with a different Todoist account.",
        )
        .addToggle((toggle) =>
          toggle.onChange((value) => {
            replaceAccount = value;
          }),
        );
    new Setting(this.contentEl)
      .addButton((button) =>
        button
          .setButtonText("Connect")
          .setCta()
          .onClick(async () => {
            button.setDisabled(true);
            status.setText("Connecting…");
            try {
              await this.service.connect(token, replaceAccount);
              this.close();
            } catch {
              status.setText(
                get(this.service.state).error ||
                  "Enter a valid Todoist API token and try again.",
              );
            } finally {
              button.setDisabled(false);
            }
          }),
      )
      .addButton((button) =>
        button.setButtonText("Cancel").onClick(() => this.close()),
      );
  }

  onClose() {
    this.contentEl.empty();
  }
}

export class TasksView extends ItemView {
  readonly preferences = writable(taskViewStateSchema.parse({}));
  private component?: ReturnType<typeof mount>;

  constructor(
    leaf: WorkspaceLeaf,
    private readonly service: TaskService,
    private readonly capture: TaskCapture,
    private readonly captureSettings: () => void,
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
    const editor = (task?: ProviderTask, parent?: ProviderTask) =>
      new TaskEditorModal(this.app, this.service, task, parent, (id) =>
        this.preferences.update((state) => ({ ...state, selectedId: id })),
      ).open();
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
        captureSettings: this.captureSettings,
        routeCapture: (issue: CaptureIssue) =>
          new TaskCaptureRouteModal(
            this.app,
            issue,
            this.service,
            this.capture,
          ).open(),
        preferences: this.preferences,
        connect: () => new TaskConnectModal(this.app, this.service).open(),
        createTask: () => editor(),
        editTask: (task: ProviderTask) => editor(task),
        addSubtask: (parent: ProviderTask) => editor(undefined, parent),
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
  }
}
