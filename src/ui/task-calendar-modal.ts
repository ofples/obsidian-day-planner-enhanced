import { Modal, Setting, type App } from "obsidian";
import { get, type Writable } from "svelte/store";

import type { GoogleCalendarSync } from "../google-calendar/service";
import type { DayPlannerSettings } from "../settings";
import { taskAccountKey, taskAccountSettings } from "../tasks/capture-settings";
import type { TaskService } from "../tasks/service";

export class TaskCalendarDisplayModal extends Modal {
  constructor(
    app: App,
    private readonly service: TaskService,
    private readonly calendar: GoogleCalendarSync,
    private readonly settings: Writable<DayPlannerSettings>,
  ) {
    super(app);
  }

  onOpen() {
    this.titleEl.setText("Task calendar feeds");
    const snapshot = get(this.service.state).snapshot;
    if (!snapshot) {
      this.contentEl.createEl("p", {
        text: "Connect a task account to configure its calendar feeds.",
      });
      return;
    }
    const account = structuredClone(
      taskAccountSettings(get(this.settings).taskCapture, snapshot),
    );
    const policy = account.calendarDisplay ?? {
      enabled: false,
      googleCalendarIds: [],
      icalUrls: [],
    };
    const google = new Set(policy.googleCalendarIds),
      icals = new Set(policy.icalUrls);
    this.contentEl.createEl("p", {
      text: "Select Todoist feeds for Day Planner to hide while this task account is connected. Disconnecting the task account restores their display.",
    });
    new Setting(this.contentEl)
      .setName("Hide selected task feeds")
      .addToggle((toggle) =>
        toggle.setValue(policy.enabled).onChange((value) => {
          policy.enabled = value;
        }),
      );
    const googleList = this.contentEl.createDiv();
    const status = this.contentEl.createEl("p", { attr: { role: "status" } });
    const renderGoogle = (calendars: { id: string; summary: string }[]) => {
      googleList.empty();
      for (const calendar of calendars)
        new Setting(googleList)
          .setName(calendar.summary)
          .setDesc(calendar.id)
          .addToggle((toggle) =>
            toggle.setValue(google.has(calendar.id)).onChange((value) => {
              if (value) google.add(calendar.id);
              else google.delete(calendar.id);
            }),
          );
    };
    renderGoogle(
      [...google].map((id) => ({ id, summary: "Saved Google calendar" })),
    );
    new Setting(this.contentEl)
      .setName("Google calendars")
      .addButton((button) =>
        button.setButtonText("Load calendars").onClick(async () => {
          button.setDisabled(true);
          try {
            const calendars = await this.calendar.calendars();
            if (!this.contentEl.isConnected) return;
            renderGoogle([
              ...calendars,
              ...[...google]
                .filter(
                  (id) => !calendars.some((calendar) => calendar.id === id),
                )
                .map((id) => ({ id, summary: "Unavailable saved calendar" })),
            ]);
            status.setText(
              calendars.length ? "" : "No Google calendars are available.",
            );
          } catch {
            status.setText(
              "Connect Google Calendar in Day Planner settings, then load calendars again.",
            );
          } finally {
            button.setDisabled(false);
          }
        }),
      );
    const sources = [
      ...new Map([
        ...get(this.settings).icals.map(
          (ical) => [ical.url, ical.name] as const,
        ),
        ...[...icals]
          .filter(
            (url) => !get(this.settings).icals.some((ical) => ical.url === url),
          )
          .map((url) => [url, "Unavailable saved internet calendar"] as const),
      ]).entries(),
    ];
    for (const [url, name] of sources)
      new Setting(this.contentEl)
        .setName(name)
        .setDesc("Internet calendar feed")
        .addToggle((toggle) =>
          toggle.setValue(icals.has(url)).onChange((value) => {
            if (value) icals.add(url);
            else icals.delete(url);
          }),
        );
    new Setting(this.contentEl)
      .addButton((button) =>
        button
          .setButtonText("Save")
          .setCta()
          .onClick(() => {
            account.calendarDisplay = {
              ...policy,
              googleCalendarIds: [...google],
              icalUrls: [...icals],
            };
            this.settings.update((settings) => ({
              ...settings,
              taskCapture: {
                ...settings.taskCapture,
                accounts: {
                  ...settings.taskCapture.accounts,
                  [taskAccountKey(snapshot)]: {
                    ...taskAccountSettings(settings.taskCapture, snapshot),
                    calendarDisplay: account.calendarDisplay,
                  },
                },
              },
            }));
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
