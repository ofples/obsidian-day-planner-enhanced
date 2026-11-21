import {
  FuzzySuggestModal,
  TFolder,
  Modal,
  Setting,
  type Plugin,
} from "obsidian";
import type { Writable } from "svelte/store";

import type { DayPlannerSettings } from "../settings";

import {
  collectionNoteLink,
  type CollectionNote,
} from "./note-collection-model";
import { NoteCollections } from "./note-collections";
import type { TaskScheduler } from "./schedule";

class CollectionFolderPicker extends FuzzySuggestModal<TFolder> {
  private selected = false;
  constructor(
    plugin: Plugin,
    private readonly finish: (path: string | null) => void,
  ) {
    super(plugin.app);
    this.setPlaceholder("Choose a notes folder");
  }
  getItems() {
    return this.app.vault
      .getAllLoadedFiles()
      .filter(
        (file): file is TFolder =>
          file instanceof TFolder && !!file.path && file.path !== "/",
      );
  }
  getItemText(folder: TFolder) {
    return folder.path;
  }
  onChooseItem(folder: TFolder) {
    this.selected = true;
    this.finish(folder.path);
  }
  onClose() {
    super.onClose();
    queueMicrotask(() => {
      if (!this.selected) this.finish(null);
    });
  }
}
class CollectionScheduleModal extends Modal {
  constructor(
    plugin: Plugin,
    private readonly note: CollectionNote,
    private readonly scheduler: TaskScheduler,
    private readonly duration: number,
  ) {
    super(plugin.app);
  }
  onOpen() {
    this.setTitle("Schedule a linked session");
    this.contentEl.createEl("p", { text: this.note.title });
    const initial = window
      .moment()
      .seconds(0)
      .milliseconds(0)
      .add(5 - (window.moment().minutes() % 5), "minutes");
    let start = initial.format("YYYY-MM-DDTHH:mm"),
      duration = this.note.durationMinutes ?? this.duration;
    new Setting(this.contentEl).setName("Start").addText((control) => {
      control.inputEl.type = "datetime-local";
      control.inputEl.setAttribute("aria-label", "Session start");
      control.setValue(start).onChange((value) => {
        start = value;
      });
    });
    new Setting(this.contentEl)
      .setName("Duration (minutes)")
      .addText((control) => {
        control.inputEl.type = "number";
        control.inputEl.min = "1";
        control.inputEl.max = "1440";
        control.inputEl.setAttribute("aria-label", "Session duration");
        control.setValue(String(duration)).onChange((value) => {
          duration = Number(value);
        });
      });
    this.contentEl.createEl("p", {
      text: "The session links to your note. Its contents and status stay as they are.",
      cls: "setting-item-description",
    });
    const issue = this.contentEl.createEl("p", { attr: { role: "alert" } });
    const id = crypto.randomUUID();
    new Setting(this.contentEl)
      .addButton((button) =>
        button.setButtonText("Cancel").onClick(() => this.close()),
      )
      .addButton((button) =>
        button
          .setButtonText("Schedule")
          .setCta()
          .onClick(() => {
            const date = window.moment(start, "YYYY-MM-DDTHH:mm", true);
            if (
              !date.isValid() ||
              !Number.isFinite(duration) ||
              duration < 1 ||
              duration > 1440
            ) {
              issue.setText(
                "Choose a valid start time and duration from 1 to 1,440 minutes.",
              );
              return;
            }
            button.setDisabled(true);
            void this.scheduler
              .placeNote(
                {
                  kind: "note",
                  noteId: this.note.id,
                  path: this.note.path,
                  title: this.note.title,
                  text: collectionNoteLink(this.note),
                  durationMinutes: duration,
                },
                {
                  start: date.toISOString(),
                  end: date.clone().add(duration, "minutes").toISOString(),
                },
                id,
              )
              .then(() => this.close())
              .catch((error: unknown) => {
                issue.setText(
                  error instanceof Error
                    ? error.message
                    : "The session could not be saved.",
                );
                button.setDisabled(false);
              });
          }),
      );
  }
  onClose() {
    this.contentEl.empty();
  }
}
export function createNoteCollections(
  plugin: Plugin,
  settings: Writable<DayPlannerSettings>,
  saved: () => Promise<void>,
  scheduler?: () => TaskScheduler | undefined,
  duration = () => 30,
) {
  const collections = new NoteCollections({
    settings,
    saved,
    schedule: async (note) => {
      const current = scheduler?.();
      if (!current)
        throw Error(
          "Scheduling is unavailable. Open the planner and try again.",
        );
      new CollectionScheduleModal(plugin, note, current, duration()).open();
    },
    paths: () => plugin.app.vault.getMarkdownFiles().map((file) => file.path),
    properties: (path) => plugin.app.metadataCache.getCache(path)?.frontmatter,
    folderExists: (path) =>
      plugin.app.vault.getAbstractFileByPath(path) instanceof TFolder,
    chooseFolder: () =>
      new Promise<string | null>((resolve) =>
        new CollectionFolderPicker(plugin, resolve).open(),
      ),
    open: async (path) => {
      await plugin.app.workspace.openLinkText(path, "", false);
    },
  });
  plugin.registerEvent(
    plugin.app.metadataCache.on("changed", (file) =>
      collections.changed(file.path),
    ),
  );
  plugin.registerEvent(
    plugin.app.vault.on("create", () => collections.refresh()),
  );
  plugin.registerEvent(
    plugin.app.vault.on("delete", (file) => collections.deleted(file.path)),
  );
  plugin.registerEvent(
    plugin.app.vault.on("rename", (file, oldPath) => {
      const newPath = file.path;
      // Folder rename events precede Obsidian's descendant-path cache update.
      window.setTimeout(() => collections.renamed(oldPath, newPath), 0);
    }),
  );
  plugin.app.workspace.onLayoutReady(() => collections.refresh());
  plugin.register(() => collections.dispose());
  return collections;
}
