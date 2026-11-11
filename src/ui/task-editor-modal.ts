import { DateTime } from "luxon";
import { Modal, Setting, type App } from "obsidian";
import { get } from "svelte/store";
import { z } from "zod";

import { taskDay } from "../tasks/browser";
import {
  operationTaskId,
  sameTaskField,
  taskDraftSchema,
  type TaskPatch,
} from "../tasks/operations";
import type { TaskService } from "../tasks/service";
import { TaskReadError, type ProviderTask } from "../tasks/types";

export class TaskEditorModal extends Modal {
  constructor(
    app: App,
    private readonly service: TaskService,
    private readonly task?: ProviderTask,
    private readonly parent?: ProviderTask,
    private readonly saved: (id: string) => void = () => {},
  ) {
    super(app);
  }

  onOpen() {
    const snapshot = get(this.service.state).snapshot;
    if (!snapshot) {
      this.close();
      return;
    }
    const task = this.task;
    this.titleEl.setText(
      task ? "Edit task" : this.parent ? "Add subtask" : "New task",
    );
    let title = task?.title ?? "";
    let description = task?.description ?? "";
    let projectId =
      task?.projectId ??
      this.parent?.projectId ??
      snapshot.projects.find((project) => project.inbox)?.id ??
      snapshot.projects[0]?.id ??
      "";
    let priority = task?.priority ?? 1;
    let labels = task?.labels.join(", ") ?? "";
    let date = task ? (taskDay(task, snapshot.account.timezone) ?? "") : "";
    const initialDate = date;
    const status = this.contentEl.createEl("p", { attr: { role: "status" } });
    new Setting(this.contentEl).setName("Task").addText((text) => {
      text.setValue(title).onChange((value) => {
        title = value;
      });
      text.inputEl.setAttribute("aria-label", "Task title");
      text.inputEl.addEventListener("keydown", (event) => {
        if (event.key === "Enter" && !event.isComposing) saveButton?.click();
      });
      text.inputEl.focus();
    });
    new Setting(this.contentEl).setName("Project").addDropdown((dropdown) =>
      dropdown
        .addOptions(
          Object.fromEntries(
            snapshot.projects.map((project) => [project.id, project.name]),
          ),
        )
        .setValue(projectId)
        .setDisabled(Boolean(this.parent))
        .onChange((value) => {
          projectId = value;
        }),
    );
    new Setting(this.contentEl).setName("Date").addText((text) => {
      text.inputEl.type = "date";
      text.setValue(date).onChange((value) => {
        date = value;
      });
      text.inputEl.setAttribute("aria-label", "Task date");
    });
    new Setting(this.contentEl).setName("Priority").addDropdown((dropdown) =>
      dropdown
        .addOptions({
          "1": "Normal",
          "2": "Priority 3",
          "3": "Priority 2",
          "4": "Priority 1",
        })
        .setValue(String(priority))
        .onChange((value) => {
          priority = Number(value);
        }),
    );
    new Setting(this.contentEl)
      .setName("Labels")
      .setDesc("Separate labels with commas.")
      .addText((text) =>
        text.setValue(labels).onChange((value) => {
          labels = value;
        }),
      );
    new Setting(this.contentEl).setName("Description").addTextArea((text) =>
      text.setValue(description).onChange((value) => {
        description = value;
      }),
    );
    let saveButton: HTMLButtonElement | undefined;
    new Setting(this.contentEl)
      .addButton((button) => {
        saveButton = button.buttonEl;
        button
          .setButtonText(task ? "Save changes" : "Add task")
          .setCta()
          .onClick(async () => {
            button.setDisabled(true);
            status.setText("Saving…");
            try {
              let due = task?.due ?? null;
              if (date !== initialDate) {
                const day = DateTime.fromISO(date, {
                  zone: snapshot.account.timezone,
                });
                if (date && !day.isValid)
                  throw new TaskReadError("Choose a valid task date.");
                const instant =
                  date && task?.due?.date.includes("T")
                    ? DateTime.fromISO(task.due.date, {
                        zone: task.due.timezone ?? snapshot.account.timezone,
                      })
                        .setZone(snapshot.account.timezone)
                        .set({ year: day.year, month: day.month, day: day.day })
                        .toISO()
                    : null;
                due = date
                  ? {
                      date: instant ?? date,
                      recurring: task?.due?.recurring ?? false,
                      text: task?.due?.recurring
                        ? task.due.text
                        : (instant ?? date),
                      timezone: task?.due?.timezone ?? null,
                    }
                  : null;
              }
              const draft = taskDraftSchema.parse({
                title,
                description,
                projectId,
                parentId: task?.parentId ?? this.parent?.id ?? null,
                priority,
                labels: [
                  ...new Set(
                    labels
                      .split(",")
                      .map((label) => label.trim())
                      .filter(Boolean),
                  ),
                ],
                due,
              });
              let selectedId = task?.id;
              if (task) {
                const changes: TaskPatch = {};
                for (const field of [
                  "title",
                  "description",
                  "priority",
                  "labels",
                  "due",
                ] as const) {
                  if (!sameTaskField(task[field], draft[field], field))
                    Object.assign(changes, { [field]: draft[field] });
                }
                if (Object.keys(changes).length)
                  await this.service.mutate({
                    kind: "update",
                    taskId: task.id,
                    changes,
                  });
                if (draft.projectId !== task.projectId)
                  await this.service.mutate({
                    kind: "moveProject",
                    taskId: task.id,
                    projectId: draft.projectId,
                  });
              } else
                selectedId = operationTaskId(
                  await this.service.mutate({ kind: "create", task: draft }),
                );
              if (selectedId) this.saved(selectedId);
              this.close();
            } catch (error) {
              status.setText(
                error instanceof TaskReadError
                  ? error.message
                  : error instanceof z.ZodError
                    ? (error.issues[0]?.message ?? "Check the task fields.")
                    : "Could not save this change. Try again.",
              );
            } finally {
              button.setDisabled(false);
            }
          });
      })
      .addButton((button) =>
        button.setButtonText("Cancel").onClick(() => this.close()),
      );
  }

  onClose() {
    this.contentEl.empty();
  }
}
