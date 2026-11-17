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

import {
  defaultScheduleExportFolder,
  saveScheduleExport,
} from "./schedule-export-file";
import { renderSchedulePdf } from "./schedule-export-pdf";

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
  private status?: HTMLElement;
  private controls?: HTMLElement;
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
    this.modalEl.addClass("planner-export-dialog");
    this.contentEl.addClass("planner-export-modal");
    this.contentEl.createEl("p", {
      cls: "planner-export-date",
      text: this.day.format("dddd, D MMMM YYYY"),
    });
    const workspace = this.contentEl.createDiv({
      cls: "planner-export-workspace",
    });
    this.controls = workspace.createDiv({ cls: "planner-export-controls" });
    this.addSelect(
      "Format",
      { png: "PNG image", pdf: "PDF document" },
      this.format,
      (value) => {
        this.format = value === "pdf" ? "pdf" : "png";
      },
    );
    this.addSelect(
      "Layout",
      { timeline: "Timeline", overview: "Compact overview" },
      this.layout,
      (value) => {
        this.layout = value === "overview" ? "overview" : "timeline";
      },
    );
    const include = this.controls.createEl("fieldset", {
      cls: "planner-export-include",
    });
    include.createEl("legend", { text: "Include" });
    for (const [name, update] of [
      [
        "Subtasks",
        (value: boolean) => {
          this.includeSubtasks = value;
        },
      ],
      [
        "All-day events",
        (value: boolean) => {
          this.includeAllDay = value;
        },
      ],
      [
        "Other calendars",
        (value: boolean) => {
          this.includeOtherCalendars = value;
        },
      ],
    ] as const) {
      new Setting(include).setName(name).addToggle((toggle) =>
        toggle.setValue(true).onChange((value) => {
          update(value);
          void this.renderPreview();
        }),
      );
    }
    const preview = workspace.createDiv({ cls: "planner-export-preview-pane" });
    this.preview = preview.createEl("img", {
      cls: "planner-export-preview",
      attr: { alt: `Schedule for ${this.day.format("D MMMM YYYY")}` },
    });
    this.pdfPreview = preview.createEl("iframe", {
      cls: "planner-export-preview",
      attr: { title: "PDF preview", sandbox: "" },
    });
    const footer = this.contentEl.createDiv({ cls: "planner-export-footer" });
    const destination = footer.createDiv({ cls: "planner-export-destination" });
    const folder =
      this.settings.scheduleExportFolder.trim() || defaultScheduleExportFolder;
    destination.createEl("span", { text: "Save to" });
    destination.createEl("strong", { text: folder, attr: { title: folder } });
    const buttons = footer.createDiv({ cls: "planner-export-buttons" });
    const cancel = buttons.createEl("button", {
      text: "Cancel",
      attr: { type: "button" },
    });
    cancel.addEventListener("click", () => this.close());
    this.saveButton = buttons.createEl("button", {
      text: "Save PNG",
      cls: "mod-cta",
      attr: { type: "button" },
    });
    this.saveButton.addEventListener("click", () => {
      void this.save();
    });
    this.status = this.contentEl.createDiv({
      cls: "planner-export-status",
      attr: { role: "status", "aria-live": "polite" },
    });
    void this.renderPreview();
  }

  private addSelect(
    name: string,
    options: Record<string, string>,
    value: string,
    update: (value: string) => void,
  ) {
    const label = this.controls!.createEl("label", {
      cls: "planner-export-field",
    });
    label.createEl("span", { text: name });
    const select = label.createEl("select", { cls: "dropdown" });
    for (const [value, text] of Object.entries(options))
      select.createEl("option", { attr: { value }, text });
    select.value = value;
    select.addEventListener("change", () => {
      update(select.value);
      void this.renderPreview();
    });
  }

  private async renderPreview() {
    const generation = ++this.generation;
    this.blob = undefined;
    this.pdfHtml = undefined;
    if (this.saveButton) {
      this.saveButton.disabled = true;
      this.saveButton.textContent =
        this.format === "pdf" ? "Save PDF" : "Save PNG";
    }
    if (this.status) this.status.textContent = "Preparing preview…";
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
      } else {
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
              value
                ? resolve(value)
                : reject(new Error("PNG encoding failed.")),
            "image/png",
          ),
        );
        if (generation !== this.generation) return;
        if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
        this.blob = blob;
        this.objectUrl = URL.createObjectURL(blob);
        if (this.preview) this.preview.src = this.objectUrl;
      }
      if (this.status) this.status.textContent = "";
      if (this.saveButton) this.saveButton.disabled = this.saving;
    } catch (error) {
      if (generation === this.generation && this.status)
        this.status.textContent =
          error instanceof Error ? error.message : "Schedule export failed.";
    }
  }

  private async save() {
    if (this.saving) return;
    const blob = this.blob,
      html = this.pdfHtml,
      format = this.format;
    if ((format === "png" && !blob) || (format === "pdf" && !html)) return;
    this.saving = true;
    if (this.saveButton) {
      this.saveButton.disabled = true;
      this.saveButton.textContent = "Saving…";
    }
    this.controls!.inert = true;
    try {
      const data =
        format === "pdf" && html
          ? Uint8Array.from(await renderSchedulePdf(html)).buffer
          : await blob!.arrayBuffer();
      const result = await saveScheduleExport(
        this.app,
        this.settings.scheduleExportFolder,
        `schedule-${this.day.format("YYYY-MM-DD")}.${format}`,
        data,
      );
      new Notice(`Saved ${result.path}`);
      this.close();
      if (format === "png" && result.file)
        await this.app.workspace.getLeaf("tab").openFile(result.file);
    } catch (error) {
      new Notice(
        error instanceof Error ? error.message : "Could not save schedule.",
      );
    } finally {
      this.saving = false;
      if (this.saveButton) {
        this.saveButton.disabled = false;
        this.saveButton.textContent =
          format === "pdf" ? "Save PDF" : "Save PNG";
      }
      this.controls!.inert = false;
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
