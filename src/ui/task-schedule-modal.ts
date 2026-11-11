import { DateTime } from "luxon";
import { Modal, Setting, type App, type DropdownComponent } from "obsidian";
import { z } from "zod";

import type { TaskScheduler } from "../tasks/schedule";
import {
  resolveScheduleInput,
  type ScheduleInterval,
} from "../tasks/schedule-types";
import type { ProviderTask } from "../tasks/types";

export class TaskScheduleModal extends Modal {
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
    const projection = this.scheduler.projection(this.task.id);
    this.titleEl.setText(
      projection?.interval ? "Move schedule" : "Schedule task",
    );
    this.contentEl.createEl("p", { text: this.task.title });
    const zone = DateTime.local().zoneName;
    const initial = this.initial ?? projection?.interval;
    const start = initial
      ? DateTime.fromISO(initial.start).setZone(zone)
      : DateTime.now().setZone(zone).startOf("hour").plus({ hours: 1 });
    let date = start.toISODate() ?? "",
      time = start.toFormat("HH:mm"),
      duration = initial
        ? (Date.parse(initial.end) - Date.parse(initial.start)) / 60_000
        : this.scheduler.duration(this.task, this.defaultDuration);
    let selectedOffset: number | undefined = initial ? start.offset : undefined;
    let offsets: DropdownComponent;
    const offsetSetting = new Setting(this.contentEl)
      .setName("Time offset")
      .addDropdown((dropdown) => {
        offsets = dropdown;
      });
    const updateOffsets = () => {
      const value = DateTime.fromISO(`${date}T${time}`, { zone });
      const choices = value.isValid ? value.getPossibleOffsets() : [];
      offsetSetting.settingEl.toggle(choices.length > 1);
      offsets.selectEl.empty();
      offsets.addOption("", "Choose an offset");
      for (const choice of choices)
        offsets.addOption(String(choice.offset), `UTC${choice.toFormat("ZZ")}`);
      offsets.setValue(
        selectedOffset === undefined ? "" : String(selectedOffset),
      );
    };
    new Setting(this.contentEl).setName("Date").addText((input) => {
      input.inputEl.type = "date";
      input.inputEl.setAttribute("aria-label", "Schedule date");
      input.setValue(date).onChange((value) => {
        date = value;
        selectedOffset = undefined;
        updateOffsets();
      });
    });
    new Setting(this.contentEl)
      .setName("Start")
      .setDesc(zone)
      .addText((input) => {
        input.inputEl.type = "time";
        input.inputEl.setAttribute("aria-label", "Schedule start");
        input.setValue(time).onChange((value) => {
          time = value;
          selectedOffset = undefined;
          updateOffsets();
        });
      });
    new Setting(this.contentEl)
      .setName("Duration in minutes")
      .addText((input) => {
        input.inputEl.type = "number";
        input.inputEl.min = "1";
        input.inputEl.max = "1440";
        input.inputEl.step = "1";
        input.inputEl.setAttribute("aria-label", "Schedule duration");
        input.setValue(String(duration)).onChange((value) => {
          duration = Number(value);
        });
      });
    offsets!.onChange((value) => {
      selectedOffset = value ? Number(value) : undefined;
    });
    this.contentEl.appendChild(offsetSetting.settingEl);
    updateOffsets();
    const status = this.contentEl.createEl("p", { attr: { role: "status" } });
    const id = crypto.randomUUID();
    new Setting(this.contentEl)
      .addButton((button) =>
        button
          .setButtonText(projection?.interval ? "Move schedule" : "Schedule")
          .setCta()
          .onClick(async () => {
            button.setDisabled(true);
            try {
              const interval = resolveScheduleInput(
                date,
                time,
                duration,
                zone,
                selectedOffset,
              );
              await this.scheduler.schedule(this.task.id, interval, id);
              this.close();
            } catch (error) {
              status.setText(
                error instanceof z.ZodError
                  ? (error.issues[0]?.message ?? "Choose a valid schedule.")
                  : error instanceof Error
                    ? error.message
                    : "Could not save this schedule. Try again.",
              );
            } finally {
              button.setDisabled(false);
            }
          }),
      )
      .addButton((button) =>
        button.setButtonText("Cancel").onClick(() => this.close()),
      );
    this.contentEl.querySelector<HTMLInputElement>("input")?.focus();
  }

  onClose() {
    this.contentEl.empty();
  }
}
