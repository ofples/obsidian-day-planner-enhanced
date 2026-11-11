import {
  type SettingDefinitionGroup,
  type SettingDefinitionRender,
} from "obsidian";

import type { DayPlannerSettings } from "../settings";

import type { GoogleCalendarSettings, GoogleCalendarSync } from "./service";

/** Native disclosure works in both searchable settings and the legacy settings tab. */
export function addGoogleCalendarSetupDetails(container: HTMLElement) {
  const document = container.ownerDocument;
  const details = document.createElement("details");
  details.className = "planner-google-setup-details";
  const summary = document.createElement("summary");
  summary.textContent = "How to set up Google Calendar sync";
  details.appendChild(summary);
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
    "Under Clients, create an OAuth client with application type Desktop app. Copy its client ID and client secret into the fields below, then click Save secret. A Web application client or an API key will not work here. Keep the secret private.",
    {
      label: "Open OAuth clients",
      url: "https://console.cloud.google.com/auth/clients",
    },
  );
  addStep(
    "Choose a calendar.",
    "Create a separate calendar such as Day Planner in Google Calendar. Under its Settings → Integrate calendar, copy Calendar ID into Target Google calendar ID below. Use the ID, not the secret iCal/ICS URL.",
    {
      label: "Open Google Calendar",
      url: "https://calendar.google.com/calendar/u/0/r/settings",
    },
  );
  addStep(
    "Connect and test.",
    "Click Connect below, choose your Google account in the browser and approve calendar access. Then click Sync now. Test one disposable block in each direction before enabling automatic sync. Keep automatic sync enabled on only one desktop at a time.",
  );
  details.appendChild(steps);
  const note = document.createElement("p");
  note.textContent =
    "If Google reports access_denied, add the signed-in account as a test user. If sign-in expires after about seven days, the Google app may still be in Testing: reconnect, or review Google's publishing options for personal use. If the browser does not return to Obsidian, check that the client type is Desktop app and local connections to 127.0.0.1 are allowed.";
  details.appendChild(note);
  const privacy = document.createElement("p");
  privacy.textContent =
    "Your refresh token and client secret are saved in Obsidian SecretStorage. Sync talks directly to Google. It mirrors titles and times for the selected calendar; other event fields and nested note content stay as they are. Google consent allows event access across calendars, while this plugin uses only the calendar ID you select.";
  details.appendChild(privacy);
  container.appendChild(details);
}

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
        desc: "Sync titles and times with a dedicated Google calendar. Nested items stay in notes. Requires Obsidian 1.11.4+; all-day events and events over 24 hours are excluded.",
        searchable: true,
        render: (setting) => addGoogleCalendarSetupDetails(setting.descEl),
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
