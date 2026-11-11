import { Modal, Notice, Setting, type App } from "obsidian";

import type { DayPlannerSettings } from "../settings";
import type { TimelineTimeBlock } from "../time-block-types";
import type { Moment } from "../util/obsidian-moment";
import {
  createScheduleExportEntries,
  drawSchedulePng,
} from "../util/schedule-export";

export class ScheduleExportModal extends Modal {
  private blob?: Blob;
  private objectUrl?: string;
  private generation = 0;
  private includeSubtasks = true;
  private preview?: HTMLImageElement;
  private saving = false;

  constructor(
    app: App,
    private readonly day: Moment,
    private readonly blocks: TimelineTimeBlock[],
    private readonly settings: DayPlannerSettings,
  ) {
    super(app);
  }

  onOpen() {
    this.titleEl.setText("Export schedule as PNG");
    this.contentEl.addClass("planner-export-modal");
    this.contentEl.createEl("p", {
      text: "A full-length image with room for every entry. Save it to Schedule Exports in your vault, then share the PNG.",
    });
    new Setting(this.contentEl)
      .setName("Include subtasks")
      .addToggle((toggle) =>
        toggle.setValue(true).onChange((value) => {
          this.includeSubtasks = value;
          void this.renderPreview();
        }),
      );
    const buttons = this.contentEl.createDiv({ cls: "planner-export-buttons" });
    new Setting(buttons).addButton((button) =>
      button
        .setButtonText("Save PNG")
        .setCta()
        .onClick(() => {
          void this.save();
        }),
    );
    this.preview = this.contentEl.createEl("img", {
      cls: "planner-export-preview",
      attr: { alt: `Schedule for ${this.day.format("D MMMM YYYY")}` },
    });
    void this.renderPreview();
  }

  private async renderPreview() {
    const generation = ++this.generation;
    this.blob = undefined;
    try {
      await this.contentEl.ownerDocument.fonts.ready;
      if (generation !== this.generation) return;
      const canvas = this.contentEl.ownerDocument.createElement("canvas");
      drawSchedulePng(
        canvas,
        this.day,
        createScheduleExportEntries(
          this.blocks,
          this.settings,
          this.includeSubtasks,
        ),
      );
      const blob = await new Promise<Blob>((resolve, reject) =>
        canvas.toBlob(
          (value) =>
            value ? resolve(value) : reject(new Error("PNG encoding failed.")),
          "image/png",
        ),
      );
      if (generation !== this.generation) return;
      if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
      this.blob = blob;
      this.objectUrl = URL.createObjectURL(blob);
      if (this.preview) this.preview.src = this.objectUrl;
    } catch (error) {
      if (generation === this.generation)
        new Notice(
          error instanceof Error ? error.message : "Schedule export failed.",
        );
    }
  }

  private async save() {
    if (this.saving) return;
    const blob = this.blob;
    if (!blob) {
      new Notice("The image is still being prepared. Try again in a moment.");
      return;
    }
    this.saving = true;
    try {
      const folder = "Schedule Exports";
      if (!this.app.vault.getAbstractFileByPath(folder))
        await this.app.vault.createFolder(folder);
      const base = `${folder}/schedule-${this.day.format("YYYY-MM-DD")}`;
      let path = `${base}.png`;
      for (let index = 2; this.app.vault.getAbstractFileByPath(path); index++)
        path = `${base}-${index}.png`;
      const file = await this.app.vault.createBinary(
        path,
        await blob.arrayBuffer(),
      );
      new Notice(`Saved ${file.path}`);
      this.close();
      await this.app.workspace.getLeaf("tab").openFile(file);
    } catch (error) {
      new Notice(
        error instanceof Error
          ? error.message
          : "Could not save schedule image.",
      );
    } finally {
      this.saving = false;
    }
  }

  onClose() {
    this.generation++;
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
    this.blob = undefined;
    this.objectUrl = undefined;
    this.contentEl.empty();
  }
}
