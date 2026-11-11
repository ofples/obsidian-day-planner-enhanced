import { Modal, Setting, type App, type ButtonComponent } from "obsidian";
import { get } from "svelte/store";

import type {
  TaskConflictChoices,
  TaskConflictDisplay,
  TaskConflictController,
  TaskConflictValues,
} from "../tasks/conflict";
import type { TaskService } from "../tasks/service";
import { TaskReadError } from "../tasks/types";

const fieldNames: Record<string, string> = {
  title: "Title",
  description: "Description",
  placement: "Project and parent",
  schedule: "Task date and duration",
  interval: "Planned interval",
  projectId: "Project",
  completed: "Completion",
  labels: "Labels",
  priority: "Priority",
};

export class TaskConflictModal<
  Review extends TaskConflictDisplay,
> extends Modal {
  private closed = false;

  constructor(
    app: App,
    private readonly service: TaskService,
    private readonly id: string,
    private readonly controller: TaskConflictController<Review>,
  ) {
    super(app);
  }

  onOpen() {
    this.closed = false;
    this.modalEl.addClass("task-conflict-modal");
    this.titleEl.setText("Review task changes");
    this.contentEl.setText("Loading current task…");
    void this.load();
  }

  private async load() {
    try {
      const review = await this.controller.inspectConflict(this.id);
      if (!this.closed) this.render(review);
    } catch (error) {
      if (this.closed) return;
      this.contentEl.empty();
      this.contentEl.createEl("p", {
        text: this.message(error),
        attr: { role: "status" },
      });
      new Setting(this.contentEl).addButton((button) =>
        button.setButtonText("Retry").onClick(() => {
          void this.load();
        }),
      );
    }
  }

  private message(error: unknown) {
    return error instanceof TaskReadError
      ? error.message
      : "Could not load the latest comparison. Try again when connected.";
  }

  private value(values: TaskConflictValues | null) {
    if (!values) return "Unavailable";
    const snapshot = get(this.service.state).snapshot;
    return Object.entries(values)
      .map(([field, value]) => {
        if (value == null) {
          if ("interval" in values && field === "due")
            return "Task date cleared";
          if ("interval" in values && field === "duration")
            return "Provider duration cleared";
          return "None";
        }
        if (field === "projectId")
          return (
            snapshot?.projects.find((project) => project.id === value)?.name ??
            String(value)
          );
        if (field === "parentId")
          return (
            snapshot?.tasks.find((task) => task.id === value)?.title ??
            String(value)
          );
        if (field === "completed") return value ? "Completed" : "Open";
        if (field === "interval")
          return `${new Date(values.interval!.start).toLocaleString()} – ${new Date(values.interval!.end).toLocaleString()}`;
        if (field === "due") {
          const due = values.due!;
          const date = [due.date, due.timezone, due.recurring ? due.text : null]
            .filter(Boolean)
            .join(" · ");
          return "interval" in values ? `Task date ${date}` : date;
        }
        if (field === "duration")
          return `${"interval" in values ? "Provider duration " : ""}${values.duration!.amount} ${values.duration!.unit}`;
        if (Array.isArray(value)) return value.join(", ") || "None";
        return String(value) || "Empty";
      })
      .join("\n");
  }

  private render(review: Review, changed = false) {
    this.contentEl.empty();
    this.contentEl.createEl("p", {
      text: review.title,
    });
    if (changed)
      this.contentEl.createEl("p", {
        text: "The task changed while this comparison was open. Review the refreshed values and choose again.",
        attr: { role: "status" },
      });
    if (!review.current)
      this.contentEl.createEl("p", {
        text: "The linked task is unavailable. Keeping its current state discards this saved command.",
      });
    const choices: TaskConflictChoices = {};
    let applyButton: ButtonComponent | undefined;
    let busy = false;
    const updateButton = () =>
      applyButton?.setDisabled(
        busy || review.fields.some((field) => !choices[field.key]),
      );
    for (const field of review.fields) {
      const name = field.fields.includes("interval")
        ? "Planned interval"
        : field.key.startsWith("label:")
          ? `Label ${field.key.slice(6)}`
          : (fieldNames[field.key] ?? field.key);
      this.contentEl.createEl("h3", {
        text: name,
      });
      const list = this.contentEl.createEl("dl");
      for (const [label, value] of [
        ["Original", field.base],
        [review.localLabel ?? "Saved change", field.local],
        ["Current Todoist", field.remote],
      ] as const) {
        list.createEl("dt", { text: label });
        list.createEl("dd", { text: this.value(value) });
      }
      if (!field.localAllowed && review.current)
        this.contentEl.createEl("p", {
          text:
            field.localUnavailableReason ??
            "This recurring occurrence has advanced. Review the current occurrence after keeping its completion state.",
        });
      if (!field.conflict)
        choices[field.key] = field.localAllowed ? "local" : "remote";
      new Setting(this.contentEl)
        .setName("Resolution")
        .addDropdown((dropdown) => {
          dropdown.selectEl.setAttribute("aria-label", `Resolve ${name}`);
          dropdown.addOption("", "Choose a value");
          if (field.localAllowed)
            dropdown.addOption(
              "local",
              review.localLabel === "Current note"
                ? "Use current note"
                : "Use saved change",
            );
          dropdown.addOption("remote", "Use current Todoist");
          dropdown.setValue(choices[field.key] ?? "").onChange((value) => {
            if (value === "local" || value === "remote")
              choices[field.key] = value;
            else delete choices[field.key];
            updateButton();
          });
        });
    }
    const status = this.contentEl.createEl("p", { attr: { role: "status" } });
    const save = async (selected: TaskConflictChoices) => {
      if (busy) return;
      busy = true;
      updateButton();
      try {
        const result = await this.controller.resolveConflict(review, selected);
        if (this.closed) return;
        if (result.kind === "changed") this.render(result.review, true);
        else this.close();
      } catch (error) {
        if (!this.closed) status.setText(this.message(error));
      } finally {
        busy = false;
        updateButton();
      }
    };
    new Setting(this.contentEl)
      .addButton((button) => {
        applyButton = button;
        button
          .setButtonText("Apply choices")
          .setCta()
          .onClick(() => save(choices));
        updateButton();
      })
      .addButton((button) =>
        button.setButtonText("Cancel").onClick(() => this.close()),
      );
  }

  onClose() {
    this.closed = true;
    this.contentEl.empty();
  }
}
