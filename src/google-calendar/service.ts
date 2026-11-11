import { Modal, Notice, Platform, type App, type Plugin } from "obsidian";
import { z } from "zod";

import { selectSortedDedupedVisibleDays } from "../redux/date-ranges-slice";
import { googleTimeBlocksUpdated } from "../redux/ical/ical-slice";
import type { AppStore } from "../redux/store";
import type { PeriodicNotes } from "../service/periodic-notes";
import type { DayPlannerSettings } from "../settings";

import { GoogleCalendarApi } from "./api";
import { GoogleCalendarAuth } from "./auth";
import { recoverCalendarProjection, syncCalendar } from "./engine";
import { ObsidianCalendarNotes } from "./notes";
import type { CalendarSyncState } from "./types";
import type { LocalBlock } from "./types";
import { sameSnapshot, snapshotOf, type CalendarSnapshot } from "./types";
import { googleEventsToBlocks, visibleGoogleCalendars } from "./view";

export interface GoogleCalendarSettings {
  clientId: string;
  calendarId: string;
  autoSync: boolean;
  daysPast: number;
  daysAhead: number;
  syncDeletions: boolean;
  colorMappings: Record<string, string>;
  fallbackColorId: string;
  showCalendarEvents: boolean;
  visibleCalendarIds: string[] | null;
  importEventsToNotes: boolean;
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
  from: z.number().int().optional(),
});
const identitySchema = z.object({
  path: z.string(),
  raw: z.string(),
  snapshot: snapshotSchema,
  from: z.number().int(),
});
const stateSchema = z.object({
  version: z.union([z.literal(1), z.literal(2)]),
  namespace: z.string().regex(/^[a-f0-9]{32}$/),
  calendarId: z.string(),
  records: z.record(
    z.string(),
    z.object({
      eventId: z.string(),
      path: z.string(),
      base: snapshotSchema,
      deleted: z.boolean().optional(),
      pendingDelete: z.boolean().optional(),
    }),
  ),
  identities: z.record(z.string(), identitySchema).optional(),
  documents: z.record(z.string(), z.string()).optional(),
  pendingNoteChange: z
    .object({
      edits: z.array(
        z.object({ path: z.string(), before: z.string(), after: z.string() }),
      ),
      identities: z.record(z.string(), identitySchema),
      documents: z.record(z.string(), z.string()),
    })
    .optional(),
  pendingImport: z
    .object({ uid: z.string(), eventId: z.string(), snapshot: snapshotSchema })
    .optional(),
  pendingCreate: z
    .object({ uid: z.string(), path: z.string(), snapshot: snapshotSchema })
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
  private viewGeneration = 0;

  constructor(
    private readonly plugin: Plugin,
    private readonly daily: PeriodicNotes,
    private readonly getSettings: () => DayPlannerSettings,
    private readonly store: AppStore,
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
        version: 2,
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
    if (
      this.state.pendingNoteChange ||
      this.state.pendingMove ||
      (!this.state.identities && this.getSettings().googleCalendar.clientId)
    ) {
      await this.noteContext().notes.scan();
    }
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
        else void this.refreshView();
      }, 60_000),
    );
    this.plugin.register(() => {
      this.stopped = true;
      this.viewGeneration++;
      this.store.dispatch(googleTimeBlocksUpdated([]));
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

  private noteContext(settings = this.getSettings()) {
    const config = settings.googleCalendar;
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
    return { notes, timeMin, timeMax };
  }

  /** Serializes task projections with the existing calendar note journal. */
  async editNotes<T>(
    operation: (
      notes: ObsidianCalendarNotes,
      blocks: LocalBlock[],
    ) => Promise<T>,
  ): Promise<T> {
    if (this.busy || this.stopped)
      throw new Error(
        "Wait for the current calendar operation to finish, then retry scheduling.",
      );
    this.busy = true;
    try {
      const { notes } = this.noteContext();
      const blocks = await notes.scan();
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- Unload can stop the service while scanning notes.
      if (this.stopped)
        throw new Error("Reopen Day Planner before scheduling this task.");
      return await operation(notes, blocks);
    } finally {
      this.busy = false;
    }
  }

  async syncProjection(uid: string, snapshot: CalendarSnapshot) {
    if (this.busy || this.stopped)
      throw new Error(
        "Calendar sync is busy. The scheduled task is saved for retry.",
      );
    await this.run(true);
    if (this.lastError) throw new Error(this.lastError);
    const record = this.state.records[uid];
    if (!record || record.deleted || !sameSnapshot(record.base, snapshot))
      throw new Error(
        "The schedule is saved. Connect Google Calendar or resolve its sync conflict to finish exporting it.",
      );
    return record.eventId;
  }

  async recoverProjection(
    uid: string,
    snapshot: CalendarSnapshot,
    path: string,
    base?: CalendarSnapshot,
  ) {
    if (this.busy || this.stopped)
      throw new Error(
        "Calendar sync is busy. Recovering this export is saved for retry.",
      );
    this.busy = true;
    try {
      const api = this.api();
      const calendarId = await api.validateCalendar();
      if (this.state.calendarId && this.state.calendarId !== calendarId)
        throw new Error(
          "Choose the original managed calendar before recovering this export.",
        );
      await recoverCalendarProjection({
        state: this.state,
        api,
        save: async () => {
          this.state.calendarId = calendarId;
          await this.save();
        },
        uid,
        snapshot,
        path,
        base,
      });
    } finally {
      this.busy = false;
    }
  }

  async removeProjection(
    uid: string,
    snapshot: CalendarSnapshot,
    path: string,
  ) {
    if (this.busy || this.stopped)
      throw new Error(
        "Calendar sync is busy. Removing this schedule is saved for retry.",
      );
    this.busy = true;
    try {
      const record = this.state.records[uid];
      if (record?.deleted) return;
      const api = this.api();
      const calendarId = await api.validateCalendar();
      if (this.state.calendarId && this.state.calendarId !== calendarId)
        throw new Error(
          "Choose the original managed calendar before removing this schedule.",
        );
      const eventId = record?.eventId ?? `dp${this.state.namespace}${uid}`;
      const event = await api.get(eventId);
      if (event && event.status !== "cancelled") {
        if (
          !record &&
          event.extendedProperties?.private?.["dayPlannerVault"] !==
            this.state.namespace
        )
          throw new Error(
            "Review this event's calendar ownership before removing the schedule.",
          );
        const current = snapshotOf(event);
        if (!current || !sameSnapshot(current, record?.base ?? snapshot))
          throw new Error(
            "This event changed in Google Calendar. Review the changes before removing its schedule.",
          );
        await api.remove(event);
      }
      this.state.calendarId = calendarId;
      this.state.records[uid] = {
        eventId,
        path,
        base: record?.base ?? snapshot,
        deleted: true,
      };
      await this.save();
    } finally {
      this.busy = false;
      await this.refreshView();
    }
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
      void this.refreshView();
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
    this.viewGeneration++;
    this.store.dispatch(googleTimeBlocksUpdated([]));
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

  private async validateManagedCalendar(api: GoogleCalendarApi) {
    const canonicalId = await api.validateCalendar();
    if (this.state.calendarId && this.state.calendarId !== canonicalId)
      throw new Error(
        "This sync state belongs to another calendar/account. Use the original target calendar.",
      );
    if (
      Object.values(this.getSettings().taskCapture.accounts).some((account) =>
        account.calendarDisplay?.googleCalendarIds.includes(canonicalId),
      )
    )
      throw new Error(
        "The managed calendar is also selected as a task feed. Choose a separate export calendar or correct the task-feed selection before retrying.",
      );
    await api.assertTaskExportAllowed();
    return canonicalId;
  }

  async assertTaskExportAllowed() {
    const config = this.getSettings().googleCalendar;
    if (!config.clientId.trim() || !config.calendarId.trim()) return;
    await this.validateManagedCalendar(this.api());
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
      const canonicalId = await this.validateManagedCalendar(api);
      await api.usePlannerColors(settings);
      this.state.calendarId = canonicalId;
      await this.save();
      const { notes, timeMin, timeMax } = this.noteContext(settings);
      await notes.recoverMove();
      const result = await syncCalendar({
        state: this.state,
        api,
        notes,
        save: () => this.save(),
        timeMin,
        timeMax,
        importEvents: config.importEventsToNotes,
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
      await this.refreshView();
    }
  }

  private api(calendarId = this.getSettings().googleCalendar.calendarId) {
    return new GoogleCalendarApi(
      this.auth,
      this.getSettings().googleCalendar.clientId.trim(),
      calendarId.trim(),
      this.state.namespace,
    );
  }

  async calendars() {
    return this.api().calendars();
  }

  async refreshView() {
    const generation = ++this.viewGeneration;
    const config = this.getSettings().googleCalendar;
    if (this.stopped) return;
    if (
      !Platform.isDesktopApp ||
      !config.showCalendarEvents ||
      !config.clientId ||
      !this.auth.isConnected()
    ) {
      this.store.dispatch(googleTimeBlocksUpdated([]));
      return;
    }
    const days = selectSortedDedupedVisibleDays(this.store.getState());
    const first = days.at(0)?.clone().startOf("day");
    const last = days.at(-1)?.clone().startOf("day").add(1, "day");
    if (!first || !last) return;
    try {
      const api = this.api();
      const [calendars, palette] = await Promise.all([
        api.calendars(),
        api.eventColors(),
      ]);
      const excluded =
        this.store.getState().ical.taskCalendarDisplay.googleCalendarIds;
      const selected = visibleGoogleCalendars(calendars, config).filter(
        (calendar) => !excluded.includes(calendar.id),
      );
      const blocks = (
        await Promise.all(
          selected.map(async (calendar) =>
            googleEventsToBlocks(
              await this.api(calendar.id).list(
                first.toISOString(),
                last.toISOString(),
              ),
              calendar,
              palette,
              this.state,
            ),
          ),
        )
      ).flat();
      if (generation === this.viewGeneration)
        this.store.dispatch(googleTimeBlocksUpdated(blocks));
    } catch (error) {
      if (generation === this.viewGeneration) this.report(error);
    }
  }

  private report(error: unknown) {
    new Notice(
      error instanceof Error ? error.message : "Google Calendar sync failed.",
      12_000,
    );
  }
}
