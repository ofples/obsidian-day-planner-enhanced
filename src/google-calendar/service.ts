import { Modal, Notice, Platform, type App, type Plugin } from "obsidian";
import { z } from "zod";

import type { PeriodicNotes } from "../service/periodic-notes";
import type { DayPlannerSettings } from "../settings";

import { GoogleCalendarApi } from "./api";
import { GoogleCalendarAuth } from "./auth";
import { syncCalendar } from "./engine";
import { ObsidianCalendarNotes } from "./notes";
import type { CalendarSyncState } from "./types";

export interface GoogleCalendarSettings {
  clientId: string;
  calendarId: string;
  autoSync: boolean;
  daysPast: number;
  daysAhead: number;
  syncDeletions: boolean;
}

const snapshotSchema = z.object({
  title: z.string(),
  start: z.iso.datetime(),
  end: z.iso.datetime(),
});
const blockSchema = z.object({
  uid: z.string(),
  path: z.string(),
  raw: z.string(),
  snapshot: snapshotSchema,
});
const stateSchema = z.object({
  version: z.literal(1),
  namespace: z.string().regex(/^[a-f0-9]{32}$/),
  calendarId: z.string(),
  records: z.record(
    z.string(),
    z.object({
      eventId: z.string(),
      path: z.string(),
      base: snapshotSchema,
      deleted: z.boolean().optional(),
    }),
  ),
  pendingImport: z
    .object({ uid: z.string(), eventId: z.string(), snapshot: snapshotSchema })
    .optional(),
  pendingMove: z
    .object({
      source: blockSchema,
      targetPath: z.string(),
      raw: z.string(),
      snapshot: snapshotSchema,
    })
    .optional(),
});

export class GoogleCalendarSync {
  private state!: CalendarSyncState;
  private auth!: GoogleCalendarAuth;
  private busy = false;
  private stopped = false;
  private lastSaved = "";
  private lastError = "";

  constructor(
    private readonly plugin: Plugin,
    private readonly daily: PeriodicNotes,
    private readonly getSettings: () => DayPlannerSettings,
  ) {}

  private get app(): App {
    return this.plugin.app;
  }
  private statePath() {
    return `${this.plugin.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.plugin.manifest.id}`}/gcal-state.json`;
  }

  async initialize() {
    if (await this.app.vault.adapter.exists(this.statePath())) {
      this.lastSaved = await this.app.vault.adapter.read(this.statePath());
      this.state = stateSchema.parse(JSON.parse(this.lastSaved));
    } else {
      this.state = {
        version: 1,
        namespace: crypto.randomUUID().replace(/-/g, ""),
        calendarId: "",
        records: {},
      };
      await this.save();
    }
    this.auth = new GoogleCalendarAuth(
      this.app,
      `day-planner-google-${this.state.namespace}`,
    );
    this.plugin.addCommand({
      id: "google-calendar-connect",
      name: "Connect Google Calendar",
      callback: () => {
        void this.connect();
      },
    });
    this.plugin.addCommand({
      id: "google-calendar-sync",
      name: "Sync Google Calendar now",
      callback: () => {
        void this.run();
      },
    });
    this.plugin.addCommand({
      id: "google-calendar-disconnect",
      name: "Disconnect Google Calendar on this device",
      callback: () => this.disconnect(),
    });
    this.plugin.registerInterval(
      window.setInterval(() => {
        if (
          Platform.isDesktopApp &&
          this.getSettings().googleCalendar.autoSync &&
          !this.stopped
        )
          void this.run(true);
      }, 60_000),
    );
    this.plugin.register(() => {
      this.stopped = true;
      this.auth.stop();
    });
  }

  private async save() {
    // Detect another client modifying shared sync state rather than silently resetting it.
    if (await this.app.vault.adapter.exists(this.statePath())) {
      const disk = await this.app.vault.adapter.read(this.statePath());
      if (disk !== this.lastSaved)
        throw new Error(
          "Calendar sync state changed on another device. Restart Obsidian before syncing again.",
        );
    }
    const serialized = JSON.stringify(this.state, null, 2);
    if (serialized === this.lastSaved) return;
    await this.app.vault.adapter.write(this.statePath(), serialized);
    this.lastSaved = serialized;
  }

  async connect() {
    if (this.busy) {
      new Notice("A calendar operation is already running.");
      return;
    }
    this.busy = true;
    try {
      await this.auth.connect(
        this.getSettings().googleCalendar.clientId.trim(),
      );
      new Notice(
        "Google Calendar connected. Choose a target calendar and run Sync Google Calendar now.",
      );
    } catch (error) {
      this.report(error);
    } finally {
      this.busy = false;
    }
  }

  disconnect() {
    if (this.busy) {
      new Notice("Wait for calendar sync to finish before disconnecting.");
      return;
    }
    this.auth.disconnect();
    new Notice(
      "Google Calendar disconnected on this device. Existing notes and events were kept.",
    );
  }

  setClientSecret(secret: string) {
    if (!secret.trim()) {
      new Notice("Enter a client secret to replace the saved value.");
      return;
    }
    try {
      this.auth.setClientSecret(secret);
      new Notice("Client secret saved.");
    } catch (error) {
      this.report(error);
    }
  }

  async run(automatic = false) {
    if (this.busy || this.stopped) return;
    this.busy = true;
    try {
      const settings = this.getSettings();
      const config = settings.googleCalendar;
      if (!config.calendarId.trim() || !config.clientId.trim()) {
        if (!automatic)
          throw new Error(
            "Set the Google OAuth client ID and target calendar ID in Day Planner settings first.",
          );
        return;
      }
      const api = new GoogleCalendarApi(
        this.auth,
        config.clientId.trim(),
        config.calendarId.trim(),
        this.state.namespace,
      );
      const canonicalId = await api.validateCalendar();
      if (this.state.calendarId && this.state.calendarId !== canonicalId)
        throw new Error(
          "This sync state belongs to another calendar/account. Use the original target calendar.",
        );
      this.state.calendarId = canonicalId;
      await this.save();
      const timeMin = window
        .moment()
        .startOf("day")
        .subtract(config.daysPast, "days")
        .toISOString();
      const timeMax = window
        .moment()
        .startOf("day")
        .add(config.daysAhead + 1, "days")
        .toISOString();
      const notes = new ObsidianCalendarNotes(
        this.app,
        this.daily,
        settings,
        timeMin,
        timeMax,
        this.state,
        () => this.save(),
      );
      await notes.recoverMove();
      const result = await syncCalendar({
        state: this.state,
        api,
        notes,
        save: () => this.save(),
        timeMin,
        timeMax,
      });
      this.lastError = "";
      if (!automatic || result.conflicts.length) {
        new Notice(
          `Google Calendar: ${result.pushed} pushed, ${result.pulled} pulled, ${result.deleted} cancelled/deleted, ${result.conflicts.length} conflicts.`,
          8000,
        );
      }
      if (result.conflicts.length && !automatic) {
        const modal = new Modal(this.app);
        modal.titleEl.setText("Google Calendar sync conflicts");
        for (const conflict of result.conflicts)
          modal.contentEl.createEl("p", { text: conflict });
        modal.open();
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Calendar sync failed.";
      if (!automatic || message !== this.lastError) this.report(error);
      this.lastError = message;
    } finally {
      this.busy = false;
    }
  }

  private report(error: unknown) {
    new Notice(
      error instanceof Error ? error.message : "Google Calendar sync failed.",
      12_000,
    );
  }
}
