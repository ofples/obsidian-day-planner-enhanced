import {
  type SettingDefinitionGroup,
  type SettingDefinitionRender,
} from "obsidian";

import type { DayPlannerSettings } from "../settings";

import type { GoogleCalendarSettings, GoogleCalendarSync } from "./service";

export function googleCalendarSettingDefinitions(
  getSettings: () => DayPlannerSettings,
  update: (patch: Partial<GoogleCalendarSettings>) => void,
  service: () => GoogleCalendarSync,
): SettingDefinitionGroup {
  const text = (
    name: string,
    key: "clientId" | "calendarId",
    desc: string,
  ): SettingDefinitionRender => ({
    name,
    desc,
    render: (setting) => {
      setting.addText((control) =>
        control
          .setValue(getSettings().googleCalendar[key])
          .onChange((value) => update({ [key]: value.trim() })),
      );
    },
  });
  return {
    type: "group",
    heading: "Google Calendar two-way sync",
    items: [
      {
        name: "Sync daily-note time blocks",
        desc: "Mirrors titles and times, including nested content kept in notes. Use a dedicated calendar. All-day and multi-day events over 24 hours are not imported. Requires Obsidian 1.11.4+. See the fork's GOOGLE-CALENDAR.md for Google OAuth setup.",
        searchable: true,
      },
      text(
        "Google OAuth client ID",
        "clientId",
        "Create a Desktop app OAuth client with the Calendar API enabled.",
      ),
      {
        name: "Google OAuth client secret",
        desc: "From the Desktop OAuth credentials. Stored in Obsidian SecretStorage; leave blank to keep the saved value.",
        render: (setting) => {
          let secret = "";
          setting.addText((control) => {
            control.inputEl.type = "password";
            control.onChange((value) => {
              secret = value;
            });
          });
          setting.addButton((button) =>
            button.setButtonText("Save secret").onClick(() => {
              service().setClientSecret(secret);
            }),
          );
        },
      },
      text(
        "Target Google calendar ID",
        "calendarId",
        "Google Calendar → Settings → your calendar → Integrate calendar → Calendar ID. All timed events in this calendar may be imported and edited.",
      ),
      {
        name: "Connect Google Calendar",
        render: (setting) => {
          setting.addButton((button) =>
            button.setButtonText("Connect").onClick(() => service().connect()),
          );
          setting.addButton((button) =>
            button.setButtonText("Sync now").onClick(() => service().run()),
          );
          setting.addButton((button) =>
            button
              .setButtonText("Disconnect")
              .onClick(() => service().disconnect()),
          );
        },
      },
      ...(["daysPast", "daysAhead"] as const).map(
        (key): SettingDefinitionRender => ({
          name:
            key === "daysPast"
              ? "Days to sync in the past"
              : "Days to sync ahead",
          render: (setting) => {
            setting.addText((control) =>
              control
                .setValue(String(getSettings().googleCalendar[key]))
                .onChange((value) => {
                  const days = Number(value);
                  if (Number.isInteger(days) && days >= 0 && days <= 365)
                    update({ [key]: days });
                }),
            );
          },
        }),
      ),
      {
        name: "Sync local deletions to Google",
        desc: "When enabled, removing a linked block from an existing daily note deletes its unchanged Google event. Missing notes and ambiguous removals are conflicts. Google cancellations are always preserved as cancelled note entries.",
        render: (setting) => {
          setting.addToggle((control) =>
            control
              .setValue(getSettings().googleCalendar.syncDeletions)
              .onChange((value) => update({ syncDeletions: value })),
          );
        },
      },
      {
        name: "Automatically sync Google Calendar",
        desc: "Sync every minute while Obsidian is open. Enable on only one device at a time. Start with manual sync to verify your setup.",
        render: (setting) => {
          setting.addToggle((control) =>
            control
              .setValue(getSettings().googleCalendar.autoSync)
              .onChange((value) => update({ autoSync: value })),
          );
        },
      },
    ],
  };
}
