import { Modal, Setting, type App } from "obsidian";
import { get, type Writable } from "svelte/store";

import type { DayPlannerSettings } from "../settings";
import type { CaptureIssue, TaskCapture } from "../tasks/capture";
import {
  taskAccountKey,
  taskAccountSettings,
  taskCaptureSettingsSchema,
} from "../tasks/capture-settings";
import type { TaskService } from "../tasks/service";
import { TaskReadError } from "../tasks/types";

export class TaskCaptureSettingsModal extends Modal {
  constructor(
    app: App,
    private readonly service: TaskService,
    private readonly settings: Writable<DayPlannerSettings>,
    private readonly capture: TaskCapture,
  ) {
    super(app);
  }

  onOpen() {
    this.titleEl.setText("Todoist capture and routing");
    const snapshot = get(this.service.state).snapshot;
    let config = structuredClone(get(this.settings).taskCapture);
    const account = snapshot ? taskAccountSettings(config, snapshot) : null;
    const projectTags = new Map(
      (snapshot?.projects ?? []).map((project) => [
        project.id,
        Object.entries(account?.projectMappings ?? {})
          .filter(([, id]) => id === project.id)
          .map(([tag]) => tag),
      ]),
    );
    let validLabelMappings = true;
    new Setting(this.contentEl)
      .setName("Capture #todoist tasks")
      .setDesc(
        "Send unchecked tagged tasks after you leave their line. Task links are stored internally.",
      )
      .addToggle((toggle) =>
        toggle.setValue(config.enabled).onChange((value) => {
          config.enabled = value;
        }),
      );
    new Setting(this.contentEl)
      .setName("Capture folders")
      .setDesc(
        "One vault-relative folder per line. Leave empty to use all indexed Markdown notes.",
      )
      .addTextArea((text) =>
        text.setValue(config.roots.join("\n")).onChange((value) => {
          config.roots = value
            .split(/\r?\n/)
            .map((root) =>
              root
                .trim()
                .replace(/\\/g, "/")
                .replace(/^\/+|\/+$/g, ""),
            )
            .filter(Boolean);
        }),
      );
    if (snapshot && account) {
      new Setting(this.contentEl)
        .setName("Default project")
        .addDropdown((dropdown) =>
          dropdown
            .addOption("", "Choose a project")
            .addOptions(
              Object.fromEntries(
                snapshot.projects.map((project) => [project.id, project.name]),
              ),
            )
            .setValue(account.defaultProjectId)
            .onChange((value) => {
              account.defaultProjectId = value;
            }),
        );
      this.contentEl.createEl("h3", { text: "Project tags" });
      this.contentEl.createEl("p", {
        text: "Comma-separated tags for each project. Multiple matching projects pause capture for a routing choice. Changes apply to new captures.",
      });
      for (const project of snapshot.projects) {
        new Setting(this.contentEl).setName(project.name).addText((text) =>
          text
            .setPlaceholder("work, haven")
            .setValue(
              Object.entries(account.projectMappings)
                .filter(([, id]) => id === project.id)
                .map(([tag]) => tag)
                .join(", "),
            )
            .onChange((value) => {
              const tags = value
                .split(",")
                .map((tag) => tag.trim().replace(/^#/, "").toLowerCase())
                .filter(Boolean);
              projectTags.set(project.id, tags);
            }),
        );
      }
      new Setting(this.contentEl)
        .setName("Label tags")
        .setDesc(
          "One tag = Todoist label per line. Unmapped tags stay in the task title.",
        )
        .addTextArea((text) =>
          text
            .setValue(
              Object.entries(account.labelMappings)
                .map(([tag, label]) => `${tag} = ${label}`)
                .join("\n"),
            )
            .onChange((value) => {
              validLabelMappings = value
                .split(/\r?\n/)
                .every(
                  (line) =>
                    !line.trim() ||
                    /^\s*#?[\p{L}\p{M}\p{N}_/-]+\s*=\s*\S.*$/u.test(line),
                );
              account.labelMappings = Object.fromEntries(
                value.split(/\r?\n/).flatMap((line) => {
                  const match = line.match(
                    /^\s*#?([\p{L}\p{M}\p{N}_/-]+)\s*=\s*(.+?)\s*$/u,
                  );
                  return match ? [[match[1]!.toLowerCase(), match[2]!]] : [];
                }),
              );
            }),
        );
    }
    const status = this.contentEl.createEl("p", { attr: { role: "status" } });
    new Setting(this.contentEl)
      .addButton((button) =>
        button
          .setButtonText("Save")
          .setCta()
          .onClick(() => {
            if (!validLabelMappings) {
              status.setText(
                "Enter each label mapping as tag = Todoist label.",
              );
              return;
            }
            const mappings = [...projectTags].flatMap(([id, tags]) =>
              tags.map((tag) => [tag, id] as const),
            );
            if (
              new Set(mappings.map(([tag]) => tag)).size !== mappings.length
            ) {
              status.setText(
                "Map each tag to one project. Use different tags to request a routing choice.",
              );
              return;
            }
            if (account) account.projectMappings = Object.fromEntries(mappings);
            if (snapshot && account)
              config.accounts[taskAccountKey(snapshot)] = account;
            const validTags = Object.values(config.accounts).every((settings) =>
              [
                ...Object.keys(settings.projectMappings),
                ...Object.keys(settings.labelMappings),
              ].every(
                (tag) =>
                  tag !== "todoist" && /^[\p{L}\p{M}\p{N}_/-]+$/u.test(tag),
              ),
            );
            if (!validTags) {
              status.setText(
                "Use valid Obsidian tags for routing. Reserve #todoist for capture.",
              );
              return;
            }
            config = taskCaptureSettingsSchema.parse(config);
            this.settings.update((settings) => ({
              ...settings,
              taskCapture: config,
            }));
            void this.capture.scan();
            this.close();
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

export class TaskCaptureRouteModal extends Modal {
  constructor(
    app: App,
    private readonly issue: CaptureIssue,
    private readonly service: TaskService,
    private readonly capture: TaskCapture,
  ) {
    super(app);
  }

  onOpen() {
    this.titleEl.setText("Route task to Todoist");
    this.contentEl.createEl("p", { text: this.issue.candidate.title });
    this.contentEl.createEl("p", { text: this.issue.message });
    let projectId = "";
    const snapshot = get(this.service.state).snapshot;
    new Setting(this.contentEl).setName("Project").addDropdown((dropdown) =>
      dropdown
        .addOption("", "Choose a project")
        .addOptions(
          Object.fromEntries(
            (snapshot?.projects ?? []).map((project) => [
              project.id,
              project.name,
            ]),
          ),
        )
        .onChange((value) => {
          projectId = value;
        }),
    );
    const status = this.contentEl.createEl("p", { attr: { role: "status" } });
    new Setting(this.contentEl)
      .addButton((button) =>
        button
          .setButtonText("Send to Todoist")
          .setCta()
          .onClick(async () => {
            if (!projectId) {
              status.setText("Choose a project first.");
              return;
            }
            button.setDisabled(true);
            try {
              await this.capture.create(this.issue.candidate, projectId);
              void this.capture.scan();
              this.close();
            } catch (error) {
              status.setText(
                error instanceof TaskReadError
                  ? error.message
                  : "Could not save this capture. Try again.",
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
