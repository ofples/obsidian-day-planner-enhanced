import type { Moment } from "moment";
import { Modal, Notice, Platform, type App, type Plugin } from "obsidian";
import { writable } from "svelte/store";
import { z } from "zod";

import { selectSortedDedupedVisibleDays } from "../redux/date-ranges-slice";
import { googleTimeBlocksUpdated } from "../redux/ical/ical-slice";
import type { AppStore } from "../redux/store";
import type { PeriodicNotes } from "../service/periodic-notes";
import { googleRequestGate } from "../service/request-gate";
import type { DayPlannerSettings } from "../settings";

import { GoogleCalendarApi } from "./api";
import { GoogleCalendarAuth } from "./auth";
import { bundledGoogleApp, googleClientId } from "./client";
import {
  isOwned,
  isCanonicalOwned,
  recoverCalendarProjection,
  resolveCalendarConflict,
  resolveDeletedRemoteConflict,
  resolveMissingLocalConflict,
  syncCalendar,
  type CalendarConflict,
  type DeletedRemoteConflict,
  type MissingLocalConflict,
} from "./engine";
import { ObsidianCalendarNotes } from "./notes";
import { isCalendarDateInScope } from "./scope";
import type { CalendarSyncState } from "./types";
import type { LocalBlock } from "./types";
import {
  canonicalSnapshotOf,
  sameCanonicalSnapshot,
  sameSnapshot,
  snapshotOf,
  type CalendarSnapshot,
} from "./types";
import { googleEventsToBlocks, visibleGoogleCalendars } from "./view";

export interface GoogleCalendarSettings {
  useCustomClient: boolean;
  clientId: string;
  calendarId: string;
  autoSync: boolean;
  syncStartDate: string;
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
  tags: z.array(z.string()).optional(),
  colorId: z.string().nullable().optional(),
  subtasks: z.string().optional(),
  description: z.string().optional(),
  taskUrl: z.string().nullable().optional(),
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
      pendingConflict: z
        .object({
          mine: snapshotSchema,
          raw: z.string(),
          currentRaw: z.string().optional(),
          fields: z.array(z.string()),
          detectedAt: z.string(),
        })
        .optional(),
      remoteEtag: z.string().optional(),
      remoteUpdated: z.string().optional(),
    }),
  ),
  identities: z.record(z.string(), identitySchema).optional(),
  documents: z.record(z.string(), z.string()).optional(),
  eventCache: z
    .object({
      timeMin: z.string(),
      timeMax: z.string(),
      syncToken: z.string().min(1),
      events: z.array(
        z.custom<import("./types").GoogleEvent>((value) =>
          Boolean(
            value &&
              typeof value === "object" &&
              "id" in value &&
              typeof value.id === "string",
          ),
        ),
      ),
    })
    .optional(),
  pendingNoteChange: z
    .object({
      localWrites: z.boolean().optional(),
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
    .object({
      uid: z.string(),
      path: z.string(),
      snapshot: snapshotSchema,
      eventId: z.string().optional(),
      currentRaw: z.string().optional(),
      preserveNote: z.boolean().optional(),
    })
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
  private noteEdits: Promise<unknown> = Promise.resolve();
  private stopped = false;
  private lastSaved = "";
  private lastError = "";
  private viewGeneration = 0;

  /** Last verified note identity for a managed calendar block. */
  importedSource(uid: string) {
    if (this.state.records[uid]?.deleted) return undefined;
    const identity = this.state.identities?.[uid];
    if (!identity || identity.from < 0) return undefined;
    return {
      uid,
      path: identity.path,
      from: identity.from,
      raw: identity.raw,
      title: identity.snapshot.title,
    };
  }
  readonly syncing = writable(false);
  readonly conflictCount = writable(0);
  private automaticTimer?: number;
  private readonly composing = new Set<Document>();
  private conflicts: string[] = [];
  private reviewable: CalendarConflict[] = [];
  private missingLocal: MissingLocalConflict[] = [];
  private deletedRemote: DeletedRemoteConflict[] = [];
  private reviewing = false;

  private queueAutomaticSync() {
    if (this.stopped || !this.getSettings().googleCalendar.autoSync) return;
    window.clearTimeout(this.automaticTimer);
    this.automaticTimer = window.setTimeout(() => {
      if (this.stopped) return;
      if (
        this.composing.size ||
        this.edits?.isWriting ||
        this.busy ||
        this.reviewing
      ) {
        this.queueAutomaticSync();
        return;
      }
      void this.run(true);
    }, 5_000);
  }

  constructor(
    private readonly plugin: Plugin,
    private readonly daily: PeriodicNotes,
    private readonly getSettings: () => DayPlannerSettings,
    private readonly store: AppStore,
    private readonly edits?: { isWriting: boolean; revision: number },
  ) {}

  private get app(): App {
    return this.plugin.app;
  }
  private clientId() {
    return googleClientId(this.getSettings().googleCalendar);
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
    this.updateConflictCount();
    this.auth = new GoogleCalendarAuth(
      this.app,
      `day-planner-google-${this.state.namespace}`,
      (clientId) =>
        !this.getSettings().googleCalendar.useCustomClient &&
        bundledGoogleApp?.clientId === clientId
          ? bundledGoogleApp.clientSecret
          : undefined,
    );
    if (this.isConnected())
      this.auth.bindLegacyClient(
        this.getSettings().googleCalendar.clientId.trim(),
      );
    if (
      this.state.pendingNoteChange ||
      this.state.pendingMove ||
      (!this.state.identities && this.clientId())
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
    this.plugin.registerEvent(
      this.app.workspace.on("editor-change", () => this.queueAutomaticSync()),
    );
    this.plugin.registerEvent(
      this.app.vault.on("modify", () => {
        if (!this.busy) this.queueAutomaticSync();
      }),
    );
    const watched = new Set<Document>();
    const unwatch: Array<() => void> = [];
    const watch = (doc: Document) => {
      if (watched.has(doc)) return;
      watched.add(doc);
      const start = () => this.composing.add(doc);
      const end = () => {
        if (this.composing.delete(doc)) this.queueAutomaticSync();
      };
      doc.addEventListener("compositionstart", start, true);
      doc.addEventListener("compositionend", end, true);
      doc.addEventListener("blur", end, true);
      unwatch.push(() => {
        doc.removeEventListener("compositionstart", start, true);
        doc.removeEventListener("compositionend", end, true);
        doc.removeEventListener("blur", end, true);
      });
    };
    watch(activeDocument);
    this.app.workspace.iterateAllLeaves((leaf) =>
      watch(leaf.view.containerEl.ownerDocument),
    );
    this.plugin.registerEvent(
      this.app.workspace.on("window-open", (_, popout) =>
        watch(popout.document),
      ),
    );
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
    this.plugin.addCommand({
      id: "google-calendar-force-note",
      name: "Force sync current note to Google Calendar",
      callback: () => this.confirmForceNote(),
    });
    this.plugin.registerInterval(
      window.setInterval(() => {
        if (
          Platform.isDesktopApp &&
          this.getSettings().googleCalendar.autoSync &&
          !this.stopped
        )
          this.queueAutomaticSync();
        else void this.refreshView();
      }, 60_000),
    );
    this.plugin.register(() => {
      this.stopped = true;
      window.clearTimeout(this.automaticTimer);
      unwatch.forEach((remove) => remove());
      this.composing.clear();
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

  private noteContext(
    settings = this.getSettings(),
    localWrites = false,
    day = window.moment(),
  ) {
    const config = settings.googleCalendar;
    const timeMin = day
      .clone()
      .startOf("day")
      .subtract(config.daysPast, "days")
      .toISOString();
    const timeMax = day
      .clone()
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
      this.edits,
      localWrites,
    );
    return { notes, timeMin, timeMax };
  }

  /** Serializes task projections with the existing calendar note journal. */
  async editNotes<T>(
    operation: (
      notes: ObsidianCalendarNotes,
      blocks: LocalBlock[],
    ) => Promise<T>,
    prepare?: () => Promise<void>,
  ): Promise<T> {
    const queued = this.noteEdits.then(async () => {
      while (!this.stopped && (this.busy || this.edits?.isWriting))
        await new Promise<void>((resolve) => window.setTimeout(resolve, 100));
      if (this.stopped)
        throw new Error("Reopen Day Planner before scheduling this task.");
      this.busy = true;
      try {
        await prepare?.();
        const { notes } = this.noteContext(this.getSettings(), true);
        const blocks = await notes.scan();
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- Unload can stop the service while scanning notes.
        if (this.stopped)
          throw new Error("Reopen Day Planner before scheduling this task.");
        return await operation(notes, blocks);
      } finally {
        this.busy = false;
        this.queueAutomaticSync();
      }
    });
    this.noteEdits = queued.catch(() => {});
    return queued;
  }

  async syncProjection(uid: string, snapshot: CalendarSnapshot) {
    if (
      !isCalendarDateInScope(
        snapshot,
        this.getSettings().googleCalendar.syncStartDate,
      )
    )
      throw new Error(
        "This schedule is before the Google Calendar sync start date.",
      );
    if (this.busy || this.stopped)
      throw new Error(
        "Calendar sync is busy. The scheduled task is saved for retry.",
      );
    await this.run(true);
    if (this.lastError) throw new Error(this.lastError);
    const record = this.state.records[uid];
    const config = this.getSettings().googleCalendar;
    if (
      !record &&
      this.clientId() &&
      config.calendarId.trim() &&
      !this.edits?.isWriting
    ) {
      const { timeMin, timeMax } = this.noteContext();
      const start = Date.parse(snapshot.start);
      if (start < Date.parse(timeMin) || start >= Date.parse(timeMax))
        throw new Error(
          "The schedule is saved locally. Its date is outside the Google Calendar sync window. Adjust Days to sync in the past or Days to sync ahead in Google Calendar settings, then retry.",
        );
    }
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
    if (
      !isCalendarDateInScope(
        base ?? snapshot,
        this.getSettings().googleCalendar.syncStartDate,
      ) ||
      !(await this.noteContext().notes.canSync(path, snapshot))
    )
      throw new Error("This schedule is outside Google Calendar sync scope.");
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
    const baseline = this.state.records[uid]?.base ?? snapshot;
    if (
      !isCalendarDateInScope(
        baseline,
        this.getSettings().googleCalendar.syncStartDate,
      ) ||
      !(await this.noteContext().notes.canSync(path, snapshot))
    )
      throw new Error("This schedule is outside Google Calendar sync scope.");
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
        const canonical = record?.base.tags !== undefined;
        if (canonical && !isCanonicalOwned(event, this.state.namespace, uid))
          throw new Error(
            "Review this event's calendar ownership before removing the schedule.",
          );
        if (!record && !isOwned(event, this.state.namespace, uid))
          throw new Error(
            "Review this event's calendar ownership before removing the schedule.",
          );
        const current = canonical
          ? canonicalSnapshotOf(event, record!.base)
          : snapshotOf(
              event,
              isOwned(event, this.state.namespace, uid) ? "" : undefined,
            );
        if (
          !current ||
          !(canonical
            ? sameCanonicalSnapshot(current, record!.base)
            : sameSnapshot(current, record?.base ?? snapshot))
        )
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

  isConnected() {
    try {
      const auth = Reflect.get(this, "auth") as GoogleCalendarAuth | undefined;
      return auth?.isConnected(this.clientId()) ?? false;
    } catch {
      return false;
    }
  }

  async connect(raiseErrors = false) {
    window.clearTimeout(this.automaticTimer);
    if (!this.resetForUserRetry()) {
      if (raiseErrors)
        throw new Error("Google Calendar is waiting for its retry deadline.");
      new Notice("Google Calendar is waiting for its retry deadline.");
      return;
    }
    const deadline = Date.now() + 30_000;
    while (this.busy && !this.stopped && Date.now() < deadline)
      await new Promise<void>((resolve) => window.setTimeout(resolve, 100));
    if (this.stopped || this.busy) {
      if (raiseErrors)
        throw new Error("A calendar operation is already running.");
      new Notice("A calendar operation is already running.");
      return;
    }
    this.busy = true;
    try {
      await this.auth.connect(this.clientId());
      void this.refreshView();
      new Notice(
        "Google Calendar connected. Choose a target calendar and run Sync Google Calendar now.",
      );
    } catch (error) {
      if (raiseErrors) throw error;
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
    if (!this.clientId() || !config.calendarId.trim()) return;
    await this.validateManagedCalendar(this.api());
  }

  resetForUserRetry() {
    return googleRequestGate(this.auth).resetForUserRetry();
  }

  async run(automatic = false, noteAuthority?: string) {
    if (noteAuthority) {
      window.clearTimeout(this.automaticTimer);
      while (!this.stopped && (this.busy || this.edits?.isWriting))
        await new Promise<void>((resolve) => window.setTimeout(resolve, 100));
    }
    if (this.busy || this.stopped || (automatic && this.reviewing)) return;
    if (!automatic && !this.resetForUserRetry()) {
      new Notice("Google Calendar is waiting for its retry deadline.");
      return;
    }
    if (this.edits?.isWriting) {
      if (!automatic)
        new Notice(
          "Wait for the current note edit to finish, then sync again.",
        );
      return;
    }
    this.busy = true;
    this.syncing.set(true);
    try {
      const settings = this.getSettings();
      const config = settings.googleCalendar;
      if (!config.calendarId.trim() || !this.clientId()) {
        if (!automatic)
          throw new Error(
            "Choose a target calendar in Day Planner settings. If this build has no bundled Google app, enable Use your own Google app.",
          );
        return;
      }
      const api = new GoogleCalendarApi(
        this.auth,
        this.clientId(),
        config.calendarId.trim(),
        this.state.namespace,
        () => !this.stopped,
        Boolean(config.syncStartDate || noteAuthority),
      );
      const canonicalId = await this.validateManagedCalendar(api);
      await api.usePlannerColors(settings);
      this.state.calendarId = canonicalId;
      await this.save();
      const selected = noteAuthority
        ? Object.values(this.daily.getAllDailyNotes()).find(
            (file) => file.path === noteAuthority,
          )
        : undefined;
      if (noteAuthority && !selected)
        throw new Error("Choose an existing daily note to force sync.");
      const day = selected
        ? this.daily.getDateFromFile(selected, "day")
        : undefined;
      const { notes, timeMin, timeMax } = this.noteContext(
        settings,
        false,
        day ?? undefined,
      );
      await notes.recoverMove();
      const result = await syncCalendar({
        state: this.state,
        api,
        notes,
        save: () => this.save(),
        timeMin,
        timeMax,
        importEvents: config.importEventsToNotes,
        canonical: Boolean(config.syncStartDate),
        noteAuthority,
      });
      this.conflicts = [
        ...new Set([
          ...(noteAuthority
            ? this.conflicts.filter(
                (message) => !message.startsWith(`${noteAuthority}:`),
              )
            : []),
          ...result.conflicts,
        ]),
      ];
      this.reviewable = [
        ...(noteAuthority
          ? this.reviewable.filter((item) => item.local.path !== noteAuthority)
          : []),
        ...result.reviewable,
      ];
      this.missingLocal = [
        ...(noteAuthority
          ? this.missingLocal.filter((item) => item.path !== noteAuthority)
          : []),
        ...result.missingLocal,
      ];
      this.deletedRemote = [
        ...(noteAuthority
          ? this.deletedRemote.filter((item) => item.path !== noteAuthority)
          : []),
        ...result.deletedRemote,
      ];
      this.updateConflictCount();
      this.lastError = "";
      if (!automatic) {
        new Notice(
          `Google Calendar: ${result.pushed} pushed, ${result.pulled} pulled, ${result.deleted} cancelled/deleted, ${result.conflicts.length} conflicts.`,
          8000,
        );
      }
      if (result.conflicts.length && !automatic) {
        this.reviewConflicts();
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Calendar sync failed.";
      const readiness =
        /note edit|notes changed during calendar scanning/i.test(message);
      if (!automatic || (!readiness && message !== this.lastError))
        this.report(error);
      if (automatic && readiness) this.queueAutomaticSync();
      this.lastError = message;
    } finally {
      this.busy = false;
      this.syncing.set(false);
      await this.refreshView();
    }
  }

  private conflictMessages() {
    const represented = [
      ...this.reviewable.map(
        (item) => `${item.local.path}: ${item.base.title} — `,
      ),
      ...this.missingLocal.map((item) => `${item.path}: ${item.base.title} — `),
      ...this.deletedRemote.map(
        (item) =>
          `${item.path}: ${this.state.records[item.uid]?.base.title ?? item.mine.title} — `,
      ),
    ];
    return [...new Set(this.conflicts)].filter(
      (message) =>
        !represented.some((prefix) => message.startsWith(prefix)) &&
        !this.missingLocal.some((item) =>
          message.startsWith(`${item.path}: Resolve the missing note blocks`),
        ),
    );
  }

  private updateConflictCount() {
    const persisted = Object.values(this.state.records).filter(
      (record) =>
        !record.deleted &&
        record.pendingConflict &&
        isCalendarDateInScope(
          record.base,
          this.getSettings().googleCalendar.syncStartDate,
        ),
    ).length;
    this.conflictCount.set(
      Math.max(persisted, this.reviewable.length + this.deletedRemote.length) +
        this.missingLocal.length +
        this.conflictMessages().length,
    );
  }

  forceDay(day: Moment) {
    const file = Object.values(this.daily.getAllDailyNotes()).find((note) =>
      this.daily.getDateFromFile(note, "day")?.isSame(day, "day"),
    );
    this.confirmForceNote(file?.path);
  }

  confirmForceNote(path = this.app.workspace.getActiveFile()?.path) {
    if (
      !path ||
      !Object.values(this.daily.getAllDailyNotes()).some(
        (file) => file.path === path,
      )
    ) {
      new Notice("Open or select an existing daily note to force sync.");
      return;
    }
    const modal = new Modal(this.app);
    modal.titleEl.setText("Force sync note to Google");
    modal.contentEl.createEl("h3", { text: path });
    modal.contentEl.createEl("p", {
      text: "Send the current note's timed blocks to the connected schedule calendar. Its titles, times, tags, descriptions and subtasks replace Google's values. Linked Google events whose blocks were removed from this note are deleted. Saved conflict drafts for this note are cleared.",
    });
    const button = modal.contentEl.createEl("button", {
      text: "Force sync this note",
      cls: "mod-cta",
    });
    button.addEventListener("click", () => {
      button.disabled = true;
      modal.close();
      void this.run(false, path);
    });
    modal.contentEl
      .createEl("button", { text: "Cancel" })
      .addEventListener("click", () => modal.close());
    modal.open();
  }

  reviewConflicts() {
    if (this.reviewing) return;
    const modal = new Modal(this.app);
    modal.titleEl.setText("Calendar sync conflicts");
    this.reviewing = true;
    let changed = false;
    let running = false;
    let api: GoogleCalendarApi | undefined;
    modal.onClose = () => {
      this.reviewing = false;
      if (changed && !this.busy) void this.refreshView();
    };
    const forget = (path: string, title: string) => {
      this.conflicts = this.conflicts.filter(
        (message) =>
          !message.startsWith(`${path}: ${title} — `) &&
          !(
            !this.missingLocal.some((item) => item.path === path) &&
            message.startsWith(`${path}: Resolve the missing note blocks`)
          ),
      );
      this.updateConflictCount();
    };
    const choose = async (
      operation: (
        api: GoogleCalendarApi,
        notes: ObsidianCalendarNotes,
      ) => Promise<void>,
    ) => {
      if (running) return;
      running = true;
      let acquired = false;
      modal.contentEl.querySelectorAll("button").forEach((button) => {
        button.disabled = true;
      });
      const status = modal.contentEl.createEl("p", {
        text: "Applying your choice…",
      });
      try {
        while (!this.stopped && (this.busy || this.edits?.isWriting))
          await new Promise<void>((resolve) => window.setTimeout(resolve, 100));
        if (this.stopped) return;
        this.busy = true;
        acquired = true;
        this.syncing.set(true);
        if (!api) {
          const candidate = this.api();
          await this.validateManagedCalendar(candidate);
          api = candidate;
        }
        await operation(api, this.noteContext().notes);
        changed = true;
        render();
      } catch (error) {
        status.setText(
          error instanceof Error
            ? error.message
            : "Calendar choice could not be applied.",
        );
        modal.contentEl.querySelectorAll("button").forEach((button) => {
          button.disabled = false;
        });
      } finally {
        if (acquired) {
          this.busy = false;
          this.syncing.set(false);
        }
        running = false;
        if (changed && !this.reviewing) void this.refreshView();
      }
    };
    const render = () => {
      modal.contentEl.empty();
      const count =
        this.reviewable.length +
        this.missingLocal.length +
        this.deletedRemote.length;
      modal.contentEl.createEl("p", {
        text: count
          ? `${count} ${count === 1 ? "choice" : "choices"} remaining`
          : "No event choices remaining.",
      });
      const messages = this.conflictMessages();
      const paths = new Set([
        ...this.reviewable.map((item) => item.local.path),
        ...this.missingLocal.map((item) => item.path),
        ...this.deletedRemote.map((item) => item.path),
        ...Object.values(this.state.records)
          .filter(
            (record) =>
              record.pendingConflict ||
              this.conflicts.some((message) =>
                message.startsWith(`${record.path}:`),
              ),
          )
          .map((record) => record.path),
      ]);
      if (!paths.size) {
        const current = this.app.workspace.getActiveFile()?.path;
        if (current) paths.add(current);
      }
      for (const path of paths) {
        const group = modal.contentEl.createDiv();
        group.createEl("h3", { text: path });
        const force = group.createEl("button", {
          text: "Force sync this note to Google…",
        });
        force.addEventListener("click", () => {
          modal.close();
          this.confirmForceNote(path);
        });
        for (const item of this.reviewable.filter(
          (item) => item.local.path === path,
        )) {
          const section = group.createDiv();
          const mine = item.mine ?? item.local.snapshot;
          section.createEl("h4", { text: mine.title || "Untitled event" });
          const details = section.createEl("details");
          details.createEl("summary", {
            text: `Compare ${item.fields?.join(", ") || "event changes"}`,
          });
          for (const [label, snapshot] of [
            ["Obsidian draft", mine],
            ["Google", item.remoteSnapshot],
          ] as const) {
            details.createEl("h5", { text: label });
            details.createEl("p", {
              text: `${snapshot.title} · ${window.moment(snapshot.start).format("D MMM, HH:mm")}–${window.moment(snapshot.end).format("HH:mm")}`,
            });
            details.createEl("pre", {
              text: [
                snapshot.tags?.map((tag) => `#${tag}`).join(" "),
                snapshot.description,
                snapshot.subtasks,
                snapshot.taskUrl,
              ]
                .filter(Boolean)
                .join("\n\n"),
            });
          }
          for (const [label, choice] of [
            ["Use Obsidian", "note"],
            ["Use Google", "google"],
          ] as const) {
            const button = section.createEl("button", { text: label });
            button.addEventListener(
              "click",
              () =>
                void choose(async (api, notes) => {
                  await resolveCalendarConflict(
                    item,
                    choice,
                    this.state,
                    api,
                    notes,
                    () => this.save(),
                  );
                  this.reviewable = this.reviewable.filter(
                    (other) => other.uid !== item.uid,
                  );
                  forget(path, item.base.title);
                }),
            );
          }
        }
        for (const item of this.missingLocal.filter(
          (item) => item.path === path,
        )) {
          const section = group.createDiv();
          section.createEl("h4", {
            text: item.remoteSnapshot.title || "Untitled event",
          });
          section.createEl("p", {
            text: "This block was removed from the note.",
          });
          for (const [label, choice] of [
            ["Restore to note", "restore"],
            ["Remove Google event", "remove"],
          ] as const) {
            const button = section.createEl("button", { text: label });
            button.addEventListener(
              "click",
              () =>
                void choose(async (api, notes) => {
                  await resolveMissingLocalConflict(
                    item,
                    choice,
                    this.state,
                    api,
                    notes,
                    () => this.save(),
                  );
                  this.missingLocal = this.missingLocal.filter(
                    (other) => other.uid !== item.uid,
                  );
                  forget(path, item.base.title);
                }),
            );
          }
        }
        for (const item of this.deletedRemote.filter(
          (item) => item.path === path,
        )) {
          const section = group.createDiv();
          section.createEl("h4", { text: item.mine.title || "Untitled event" });
          section.createEl("p", {
            text: "Google deleted this event. Your Obsidian draft is saved.",
          });
          const details = section.createEl("details");
          details.createEl("summary", { text: "View saved draft" });
          details.createEl("pre", { text: item.raw });
          for (const [label, choice] of [
            ["Restore Obsidian draft", "restore"],
            ["Accept Google deletion", "accept"],
          ] as const) {
            const button = section.createEl("button", { text: label });
            button.addEventListener(
              "click",
              () =>
                void choose(async (api, notes) => {
                  const summaryTitle =
                    this.state.records[item.uid]?.base.title ?? item.mine.title;
                  await resolveDeletedRemoteConflict(
                    item,
                    choice,
                    this.state,
                    api,
                    notes,
                    () => this.save(),
                  );
                  this.deletedRemote = this.deletedRemote.filter(
                    (other) => other.uid !== item.uid,
                  );
                  forget(path, summaryTitle);
                }),
            );
          }
        }
      }
      if (messages.length) {
        const details = modal.contentEl.createEl("details");
        details.createEl("summary", {
          text: `${messages.length} additional sync details`,
        });
        for (const message of messages)
          details.createEl("p", { text: message });
      }
      const refresh = modal.contentEl.createEl("button", {
        text: "Refresh conflicts",
      });
      refresh.addEventListener("click", () => {
        modal.close();
        void this.run();
      });
      modal.contentEl
        .createEl("button", { text: "Done" })
        .addEventListener("click", () => modal.close());
    };
    render();
    modal.open();
  }

  private api(calendarId = this.getSettings().googleCalendar.calendarId) {
    return new GoogleCalendarApi(
      this.auth,
      this.clientId(),
      calendarId.trim(),
      this.state.namespace,
      () => !this.stopped,
      Boolean(this.getSettings().googleCalendar.syncStartDate),
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
      !this.clientId() ||
      !this.isConnected()
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
