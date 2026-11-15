import { Modal, Notice, Setting, type App } from "obsidian";

import type { DayPlannerSettings } from "../settings";
import type { TimelineTimeBlock } from "../time-block-types";
import type { Moment } from "../util/obsidian-moment";
import {
  createScheduleExportEntries,
  drawScheduleOverview,
  drawSchedulePng,
  filterScheduleExportBlocks,
  schedulePrintHtml,
} from "../util/schedule-export";

import { saveSchedulePdf } from "./schedule-export-pdf";

export class ScheduleExportModal extends Modal {
  private blob?: Blob;
  private objectUrl?: string;
  private generation = 0;
  private includeSubtasks = true;
  private includeAllDay = true;
  private includeOtherCalendars = true;
  private format: "png" | "pdf" = "png";
  private layout: "timeline" | "overview" = "timeline";
  private preview?: HTMLImageElement;
  private pdfPreview?: HTMLIFrameElement;
  private pdfHtml?: string;
  private saveButton?: HTMLButtonElement;
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
    this.titleEl.setText("Export schedule");
    this.contentEl.addClass("planner-export-modal");
    this.contentEl.createEl("p", {
      text: "Export the selected day as a timeline or a compact overview.",
    });
    new Setting(this.contentEl).setName("Format").addDropdown((dropdown) =>
      dropdown
        .addOptions({ png: "PNG image", pdf: "PDF document" })
        .setValue(this.format)
        .onChange((value) => {
          this.format = value === "pdf" ? "pdf" : "png";
          if (this.saveButton)
            this.saveButton.textContent =
              this.format === "pdf" ? "Save PDF" : "Save PNG";
          void this.renderPreview();
        }),
    );
    new Setting(this.contentEl).setName("Layout").addDropdown((dropdown) =>
      dropdown
        .addOptions({ timeline: "Timeline", overview: "Compact overview" })
        .setValue(this.layout)
        .onChange((value) => {
          this.layout = value === "overview" ? "overview" : "timeline";
          void this.renderPreview();
        }),
    );
    const details = this.contentEl.createEl("details");
    details.createEl("summary", { text: "Export options" });
    new Setting(details).setName("Include subtasks").addToggle((toggle) =>
      toggle.setValue(true).onChange((value) => {
        this.includeSubtasks = value;
        void this.renderPreview();
      }),
    );
    new Setting(details).setName("Include all-day events").addToggle((toggle) =>
      toggle.setValue(true).onChange((value) => {
        this.includeAllDay = value;
        void this.renderPreview();
      }),
    );
    new Setting(details)
      .setName("Include other calendars")
      .addToggle((toggle) =>
        toggle.setValue(true).onChange((value) => {
          this.includeOtherCalendars = value;
          void this.renderPreview();
        }),
      );
    const buttons = this.contentEl.createDiv({ cls: "planner-export-buttons" });
    new Setting(buttons).addButton((button) => {
      this.saveButton = button.buttonEl;
      button
        .setButtonText("Save PNG")
        .setCta()
        .onClick(() => {
          void this.save();
        });
    });
    this.preview = this.contentEl.createEl("img", {
      cls: "planner-export-preview",
      attr: { alt: `Schedule for ${this.day.format("D MMMM YYYY")}` },
    });
    this.pdfPreview = this.contentEl.createEl("iframe", {
      cls: "planner-export-preview",
      attr: { title: "PDF preview", sandbox: "" },
    });
    void this.renderPreview();
  }

  private async renderPreview() {
    const generation = ++this.generation;
    this.blob = undefined;
    this.pdfHtml = undefined;
    try {
      const blocks = filterScheduleExportBlocks(this.blocks, {
        allDay: this.includeAllDay,
        otherCalendars: this.includeOtherCalendars,
      });
      const entries = createScheduleExportEntries(
        blocks,
        this.settings,
        this.includeSubtasks,
      );
      if (this.preview) this.preview.hidden = this.format !== "png";
      if (this.pdfPreview) this.pdfPreview.hidden = this.format !== "pdf";
      if (this.format === "pdf") {
        this.pdfHtml = schedulePrintHtml(
          this.day,
          entries,
          this.layout === "overview",
        );
        if (this.pdfPreview) this.pdfPreview.srcdoc = this.pdfHtml;
        return;
      }
      await this.contentEl.ownerDocument.fonts.ready;
      if (generation !== this.generation) return;
      const canvas = this.contentEl.ownerDocument.createElement("canvas");
      (this.layout === "overview" ? drawScheduleOverview : drawSchedulePng)(
        canvas,
        this.day,
        entries,
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
    const html = this.pdfHtml;
    if ((this.format === "png" && !blob) || (this.format === "pdf" && !html)) {
      new Notice("The image is still being prepared. Try again in a moment.");
      return;
    }
    this.saving = true;
    try {
      if (this.format === "pdf" && html) {
        const saved = await saveSchedulePdf(
          html,
          `schedule-${this.day.format("YYYY-MM-DD")}.pdf`,
        );
        if (saved) {
          new Notice("Saved PDF schedule.");
          this.close();
        }
        return;
      }
      if (!blob) return;
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
    this.pdfHtml = undefined;
    this.objectUrl = undefined;
    this.contentEl.empty();
  }
}
