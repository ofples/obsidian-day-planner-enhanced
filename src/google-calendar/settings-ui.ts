import {
  Setting,
  type App,
  type SettingDefinitionGroup,
  type SettingDefinitionRender,
} from "obsidian";

import type { DayPlannerSettings } from "../settings";

import { GoogleCalendarPicker } from "./calendar-picker";
import { eventColorOptions } from "./colors";
import type { GoogleCalendarSettings, GoogleCalendarSync } from "./service";

/** Native disclosure works in both searchable settings and the legacy settings tab. */
export function addGoogleCalendarSetupDetails(
  container: HTMLElement,
  custom = false,
) {
  const document = container.ownerDocument;
  const details = document.createElement("details");
  details.className = "planner-google-setup-details";
  const summary = document.createElement("summary");
  summary.textContent = "How to set up Google Calendar sync";
  details.appendChild(summary);
  if (!custom) {
    const instructions = document.createElement("p");
    instructions.textContent =
      "Open Connections and choose Sign in with Google. Select your account, approve calendar access, then choose the target calendar for your schedule. The Google app configuration is included in the installed build.";
    details.appendChild(instructions);
    container.appendChild(details);
    return;
  }
  const intro = document.createElement("p");
  intro.textContent =
    "One-time setup on desktop: create your own Google connection, then choose a calendar for your schedule. You do not need a paid Google Cloud plan.";
  details.appendChild(intro);
  const steps = document.createElement("ol");
  const addStep = (
    title: string,
    text: string,
    link?: { label: string; url: string },
  ) => {
    const item = document.createElement("li");
    const heading = document.createElement("strong");
    heading.textContent = `${title} `;
    item.append(heading, document.createTextNode(text));
    if (link) {
      const anchor = document.createElement("a");
      anchor.textContent = link.label;
      anchor.href = link.url;
      anchor.target = "_blank";
      anchor.rel = "noopener noreferrer";
      item.append(document.createTextNode(" "), anchor);
    }
    steps.appendChild(item);
  };
  addStep(
    "Create a Google Cloud project.",
    "Use a project for Day Planner and enable Google Calendar API. Standard Calendar API use is free. Google may require a billing account when you create a project; no paid resources are needed for this setup.",
    {
      label: "Open Google Calendar API setup",
      url: "https://console.cloud.google.com/apis/library/calendar-json.googleapis.com",
    },
  );
  addStep(
    "Set up Google Auth Platform.",
    "Under Branding, enter an app name (for example, Day Planner) and your support/contact email. Under Audience, choose External for a personal Gmail account and add yourself as a test user if the app is in Testing.",
    {
      label: "Open Google Auth Platform",
      url: "https://console.cloud.google.com/auth/overview",
    },
  );
  addStep(
    "Create a Desktop app client.",
    "Under Clients, create an OAuth client with application type Desktop app. Enable Use your own Google app, enter its client ID and secret, and click Save secret. A Web application client or an API key will not work. Keep the secret private.",
    {
      label: "Open OAuth clients",
      url: "https://console.cloud.google.com/auth/clients",
    },
  );
  addStep(
    "Choose a calendar.",
    "Create a separate calendar such as Day Planner in Google Calendar. Open Sync calendar in Day Planner settings and select it by name.",
    {
      label: "Open Google Calendar",
      url: "https://calendar.google.com/calendar/u/0/r/settings",
    },
  );
  addStep(
    "Connect and test.",
    "Open Connections and choose Sign in with Google, choose your Google account in the browser and approve calendar access. Then click Sync. Test one disposable block in each direction before enabling automatic sync. Keep automatic sync enabled on only one desktop at a time.",
  );
  details.appendChild(steps);
  const note = document.createElement("p");
  note.textContent =
    "If Google reports access_denied, add the signed-in account as a test user. If sign-in expires after about seven days, the Google app may still be in Testing: reconnect, or review Google's publishing options for personal use. If the browser does not return to Obsidian, check that the client type is Desktop app and local connections to 127.0.0.1 are allowed.";
  details.appendChild(note);
  const privacy = document.createElement("p");
  privacy.textContent =
    "Your refresh token and client secret are saved in Obsidian SecretStorage. Sync talks directly to Google. A sync start date enables Google-canonical sync for eligible notes; earlier notes remain untouched. Choose additional calendars for display-only events. Google consent allows event access across your calendars.";
  details.appendChild(privacy);
  container.appendChild(details);
}

export function googleCalendarSettingDefinitions(
  getSettings: () => DayPlannerSettings,
  update: (patch: Partial<GoogleCalendarSettings>) => void,
  service: () => GoogleCalendarSync,
  app: App,
  openConnections: () => void,
): SettingDefinitionGroup[] {
  const toggle = (
    name: string,
    key:
      | "autoSync"
      | "showCalendarEvents"
      | "importEventsToNotes"
      | "syncDeletions",
    desc: string,
  ): SettingDefinitionRender => ({
    name,
    desc,
    render: (setting) => {
      setting.addToggle((control) =>
        control
          .setValue(getSettings().googleCalendar[key])
          .onChange((value) => update({ [key]: value })),
      );
    },
  });
  const syncOptions: SettingDefinitionRender[] = [
    ...(["daysPast", "daysAhead"] as const).map(
      (key): SettingDefinitionRender => ({
        name:
          key === "daysPast"
            ? "Days to sync in the past"
            : "Days to sync ahead",
        render: (setting) => {
          setting.addText((control) => {
            control.inputEl.type = "number";
            control.inputEl.min = "0";
            control.inputEl.max = "365";
            control
              .setValue(String(getSettings().googleCalendar[key]))
              .onChange((value) => {
                const days = Number(value);
                if (
                  value.trim() &&
                  Number.isInteger(days) &&
                  days >= 0 &&
                  days <= 365
                )
                  update({ [key]: days });
              });
          });
        },
      }),
    ),
    toggle(
      "Import new Google events into daily notes",
      "importEventsToNotes",
      "Create Markdown tasks for new timed events in the sync calendar. Linked blocks continue syncing both ways.",
    ),
    toggle(
      "Sync local deletions to Google",
      "syncDeletions",
      "Removing a linked block deletes its unchanged Google event. Missing notes and ambiguous removals need review.",
    ),
  ];
  return [
    {
      type: "group",
      heading: "Google Calendar - Schedule sync",
      items: [
        {
          name: "Sync calendar",
          desc: "Daily-note time blocks sync both ways with this calendar.",
          render: (setting) => {
            const label = setting.descEl.ownerDocument.createElement("span");
            label.className = "planner-calendar-selected";
            const refresh = () => {
              const id = getSettings().googleCalendar.calendarId;
              label.textContent = id
                ? service().calendarName(id) || "Calendar selected"
                : "Choose a calendar to get started";
            };
            refresh();
            setting.descEl.prepend(label);
            setting.addButton((button) =>
              button.setButtonText("Choose calendar").onClick(() =>
                new GoogleCalendarPicker(app, {
                  mode: "sync",
                  settings: getSettings,
                  service,
                  update,
                  openConnections,
                  onApplied: refresh,
                }).open(),
              ),
            );
          },
        },
        toggle(
          "Automatic sync",
          "autoSync",
          "Sync after editing has been idle for the delay below, and check periodically while Obsidian is open.",
        ),
        {
          name: "Wait after edits (seconds)",
          desc: "Wait 5–300 seconds after the last schedule edit before automatic sync. Default: 20 seconds. Sync now remains an explicit action.",
          render: (setting) =>
            setting.addText((control) => {
              control.inputEl.type = "number";
              control.inputEl.min = "5";
              control.inputEl.max = "300";
              control
                .setValue(
                  String(getSettings().googleCalendar.autoSyncDelaySeconds),
                )
                .onChange((value) => {
                  const seconds = Number(value);
                  if (
                    value.trim() &&
                    Number.isInteger(seconds) &&
                    seconds >= 5 &&
                    seconds <= 300
                  )
                    update({ autoSyncDelaySeconds: seconds });
                });
            }),
        },
        {
          name: "Sync and conflicts",
          desc: "Run a sync or review changes that need your choice.",
          render: (setting) => {
            setting.addButton((button) =>
              button.setButtonText("Sync now").onClick(() => service().run()),
            );
            setting.addButton((button) =>
              button
                .setButtonText("Review conflicts")
                .onClick(() => service().reviewConflicts()),
            );
          },
        },
        {
          name: "Sync start date",
          desc: "Sync schedules from this day onward. Leave blank for the original sync mode. Exclude an individual note with sync: off.",
          render: (setting) => {
            setting.addText((control) => {
              control.inputEl.type = "date";
              control
                .setValue(getSettings().googleCalendar.syncStartDate)
                .onChange((value) => {
                  if (
                    !value ||
                    window.moment(value, "YYYY-MM-DD", true).isValid()
                  )
                    update({ syncStartDate: value });
                });
            });
          },
        },
        {
          name: "More sync options",
          desc: "Date range, importing events and deleting linked events.",
          render: (setting, group) => {
            const details =
              setting.descEl.ownerDocument.createElement("details");
            details.className = "planner-google-options";
            const summary = details.ownerDocument.createElement("summary");
            summary.textContent = "Show options";
            details.append(summary);
            setting.descEl.append(details);
            for (const item of syncOptions) {
              const row = new Setting(details).setName(item.name);
              if (typeof item.desc === "string") row.setDesc(item.desc);
              item.render(row, group);
            }
          },
        },
      ],
    },
    {
      type: "group",
      heading: "Google Calendar - Planner display",
      items: [
        toggle(
          "Show Google calendar events",
          "showCalendarEvents",
          "Show events from the calendars below in the planner. Refreshes every minute and when changing dates.",
        ),
        {
          name: "Calendars shown in the planner",
          desc: "Display additional calendars alongside your schedule. Linked schedule blocks appear once.",
          render: (setting) => {
            const label = setting.descEl.ownerDocument.createElement("span");
            label.className = "planner-calendar-selected";
            const refresh = () => {
              const ids = getSettings().googleCalendar.visibleCalendarIds;
              label.textContent =
                ids === null
                  ? "Following Google Calendar selection"
                  : ids.length === 1
                    ? service().calendarName(ids[0]!) || "1 calendar selected"
                    : `${ids.length} calendars selected`;
            };
            refresh();
            setting.descEl.prepend(label);
            setting.addButton((button) =>
              button.setButtonText("Choose calendars").onClick(() =>
                new GoogleCalendarPicker(app, {
                  mode: "display",
                  settings: getSettings,
                  service,
                  update,
                  openConnections,
                  onApplied: refresh,
                }).open(),
              ),
            );
          },
        },
        {
          name: "Google event colors",
          desc: "Choose how planner colors map to new Google events.",
          render: (setting) => {
            const details =
              setting.descEl.ownerDocument.createElement("details");
            const summary = details.ownerDocument.createElement("summary");
            summary.textContent = "Color mappings";
            details.appendChild(summary);
            setting.descEl.appendChild(details);
            for (const override of getSettings().colorOverrides)
              new Setting(details)
                .setName(override.text || "Empty text rule")
                .setDesc(
                  `Planner color ${override.color}. First matching rule wins.`,
                )
                .addDropdown((control) =>
                  control
                    .addOptions(eventColorOptions)
                    .setValue(
                      getSettings().googleCalendar.colorMappings[
                        override.text
                      ] ?? "",
                    )
                    .onChange((value) =>
                      update({
                        colorMappings: {
                          ...getSettings().googleCalendar.colorMappings,
                          [override.text]: value,
                        },
                      }),
                    ),
                );
            new Setting(details)
              .setName("Other schedule blocks")
              .setDesc(
                "Sets the initial Google color; later Google color changes are preserved.",
              )
              .addDropdown((control) =>
                control
                  .addOptions(eventColorOptions)
                  .setValue(getSettings().googleCalendar.fallbackColorId)
                  .onChange((fallbackColorId) => update({ fallbackColorId })),
              );
          },
        },
      ],
    },
    {
      type: "group",
      heading: "Google Calendar - Advanced",
      items: [
        {
          name: "Advanced Google connection",
          desc: "Optional app configuration for developers and custom Google projects.",
          render: (setting) => {
            const details =
              setting.descEl.ownerDocument.createElement("details");
            const summary = details.ownerDocument.createElement("summary");
            summary.textContent = "Developer options";
            details.appendChild(summary);
            setting.descEl.appendChild(details);
            const custom = details.ownerDocument.createElement("div");
            custom.hidden = !getSettings().googleCalendar.useCustomClient;
            new Setting(details)
              .setName("Use your own Google app")
              .setDesc(
                "Use a custom Desktop OAuth client. Changing apps requires signing in again.",
              )
              .addToggle((toggle) =>
                toggle
                  .setValue(getSettings().googleCalendar.useCustomClient)
                  .onChange((useCustomClient) => {
                    update({ useCustomClient });
                    custom.hidden = !useCustomClient;
                  }),
              );
            details.appendChild(custom);
            new Setting(custom)
              .setName("Google OAuth client ID")
              .setDesc(
                "Use a Desktop app client with the Calendar API enabled.",
              )
              .addText((control) =>
                control
                  .setValue(getSettings().googleCalendar.clientId)
                  .onChange((value) => update({ clientId: value.trim() })),
              );
            let secret = "";
            new Setting(custom)
              .setName("Google OAuth client secret")
              .setDesc(
                "Stored in Obsidian SecretStorage. Leave blank to keep the saved secret.",
              )
              .addText((control) => {
                control.inputEl.type = "password";
                control.onChange((value) => {
                  secret = value;
                });
              })
              .addButton((button) =>
                button
                  .setButtonText("Save secret")
                  .onClick(() => service().setClientSecret(secret)),
              );
            addGoogleCalendarSetupDetails(custom, true);
          },
        },
        {
          name: "Setup help",
          render: (setting) => addGoogleCalendarSetupDetails(setting.descEl),
        },
      ],
    },
  ];
}
