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
  private automaticTimer?: number;
  private readonly composing = new Set<Document>();
  private conflicts: string[] = [];
  private reviewable: CalendarConflict[] = [];
  private missingLocal: MissingLocalConflict[] = [];
  private deletedRemote: DeletedRemoteConflict[] = [];

  private queueAutomaticSync() {
    if (this.stopped || !this.getSettings().googleCalendar.autoSync) return;
    window.clearTimeout(this.automaticTimer);
    this.automaticTimer = window.setTimeout(() => {
      if (this.stopped) return;
      if (this.composing.size || this.edits?.isWriting || this.busy) {
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

  private noteContext(settings = this.getSettings(), localWrites = false) {
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
  ): Promise<T> {
    if (this.busy || this.stopped || this.edits?.isWriting)
      throw new Error(
        "Wait for the current calendar operation to finish, then retry scheduling.",
      );
    this.busy = true;
    try {
      const { notes } = this.noteContext(this.getSettings(), true);
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
      config.clientId.trim() &&
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
      return auth?.isConnected() ?? false;
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
      await this.auth.connect(
        this.getSettings().googleCalendar.clientId.trim(),
      );
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
    if (!config.clientId.trim() || !config.calendarId.trim()) return;
    await this.validateManagedCalendar(this.api());
  }

  resetForUserRetry() {
    return googleRequestGate(this.auth).resetForUserRetry();
  }

  async run(automatic = false) {
    if (this.busy || this.stopped) return;
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
        () => !this.stopped,
        Boolean(config.syncStartDate),
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
        canonical: Boolean(config.syncStartDate),
      });
      this.conflicts = result.conflicts;
      this.reviewable = result.reviewable;
      this.missingLocal = result.missingLocal;
      this.deletedRemote = result.deletedRemote;
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

  reviewConflicts() {
    const modal = new Modal(this.app);
    modal.titleEl.setText("Google Calendar sync conflicts");
    if (!this.conflicts.length)
      modal.contentEl.createEl("p", {
        text: "No conflicts found. Run Sync to check again.",
      });
    for (const conflict of this.conflicts)
      modal.contentEl.createEl("p", { text: conflict });
    if (this.conflicts.length)
      modal.contentEl.createEl("p", {
        text: "For conflicts without a choice below, review the listed note and Google event, then run Sync again.",
      });
    for (const conflict of this.missingLocal) {
      const section = modal.contentEl.createDiv();
      section.createEl("h3", { text: conflict.path });
      section.createEl("p", {
        text: `The note task is missing. Google: ${conflict.remoteSnapshot.title} — ${conflict.remoteSnapshot.start} to ${conflict.remoteSnapshot.end}`,
      });
      const restore = section.createEl("button", { text: "Restore to note" });
      const remove = section.createEl("button", {
        text: "Remove Google event",
      });
      const choose = async (choice: "restore" | "remove") => {
        if (this.busy || this.stopped) {
          new Notice("Wait for calendar sync to finish, then retry.");
          return;
        }
        restore.disabled = true;
        remove.disabled = true;
        this.busy = true;
        this.syncing.set(true);
        try {
          const api = this.api();
          await this.validateManagedCalendar(api);
          await resolveMissingLocalConflict(
            conflict,
            choice,
            this.state,
            api,
            this.noteContext().notes,
            () => this.save(),
          );
          this.missingLocal = this.missingLocal.filter(
            (item) => item.uid !== conflict.uid,
          );
          modal.close();
          new Notice(
            "Calendar conflict resolved. Sync again to review remaining conflicts.",
          );
        } catch (error) {
          this.report(error);
          restore.disabled = false;
          remove.disabled = false;
        } finally {
          this.busy = false;
          this.syncing.set(false);
        }
      };
      restore.addEventListener("click", () => void choose("restore"));
      remove.addEventListener("click", () => void choose("remove"));
    }
    for (const conflict of this.deletedRemote) {
      const section = modal.contentEl.createDiv();
      section.createEl("h3", { text: conflict.mine.title || "Untitled event" });
      section.createEl("p", {
        text: `Google deleted this event. Your Obsidian draft is saved in ${conflict.path}.`,
      });
      section.createEl("pre", { text: conflict.raw });
      const restore = section.createEl("button", {
        text: "Restore Obsidian draft to Google",
      });
      const accept = section.createEl("button", {
        text: "Accept Google deletion",
      });
      const choose = async (choice: "restore" | "accept") => {
        if (this.busy || this.stopped) return;
        restore.disabled = true;
        accept.disabled = true;
        this.busy = true;
        this.syncing.set(true);
        try {
          const api = this.api();
          await this.validateManagedCalendar(api);
          await resolveDeletedRemoteConflict(
            conflict,
            choice,
            this.state,
            api,
            this.noteContext().notes,
            () => this.save(),
          );
          this.deletedRemote = this.deletedRemote.filter(
            (item) => item.uid !== conflict.uid,
          );
          modal.close();
          new Notice(
            "Calendar deletion resolved. Sync to review remaining changes.",
          );
        } catch (error) {
          this.report(error);
          restore.disabled = false;
          accept.disabled = false;
        } finally {
          this.busy = false;
          this.syncing.set(false);
        }
      };
      restore.addEventListener("click", () => void choose("restore"));
      accept.addEventListener("click", () => void choose("accept"));
    }
    for (const conflict of this.reviewable) {
      const section = modal.contentEl.createDiv();
      section.createEl("h3", { text: conflict.local.path });
      const describe = (snapshot: CalendarSnapshot) =>
        `${snapshot.title} — ${window.moment(snapshot.start).format("ddd D MMM, HH:mm")} to ${window.moment(snapshot.end).format("ddd D MMM, HH:mm")}`;
      const mine = conflict.mine ?? conflict.local.snapshot;
      section.createEl("p", { text: `Obsidian: ${describe(mine)}` });
      section.createEl("p", {
        text: `Google: ${describe(conflict.remoteSnapshot)}`,
      });
      const fields: Array<[string, keyof CalendarSnapshot]> = [
        ["Title", "title"],
        ["Start", "start"],
        ["End", "end"],
        ["Tags", "tags"],
        ["Subtasks", "subtasks"],
        ["Color", "colorId"],
        ["Description", "description"],
      ];
      for (const [label, field] of fields) {
        const mineValue = mine[field],
          theirs = conflict.remoteSnapshot[field];
        if (
          JSON.stringify(mineValue) !== JSON.stringify(theirs) &&
          field !== "title" &&
          field !== "start" &&
          field !== "end"
        )
          section.createEl("p", {
            text: `${label}: Obsidian ${Array.isArray(mineValue) ? mineValue.join(", ") : String(mineValue ?? "—")} | Google ${Array.isArray(theirs) ? theirs.join(", ") : String(theirs ?? "—")}`,
          });
      }
      if (conflict.remote.updated)
        section.createEl("p", {
          text: `Google updated ${window.moment(conflict.remote.updated).format("D MMM, HH:mm:ss")}`,
        });
      const noteButton = section.createEl("button", { text: "Use Obsidian" });
      const googleButton = section.createEl("button", { text: "Use Google" });
      const choose = async (choice: "note" | "google") => {
        if (this.busy || this.stopped) {
          new Notice("Wait for calendar sync to finish, then retry.");
          return;
        }
        noteButton.disabled = true;
        googleButton.disabled = true;
        this.busy = true;
        this.syncing.set(true);
        try {
          const api = this.api();
          await this.validateManagedCalendar(api);
          await resolveCalendarConflict(
            conflict,
            choice,
            this.state,
            api,
            this.noteContext().notes,
            () => this.save(),
          );
          modal.close();
          new Notice(
            "Calendar conflict resolved. Sync again to review remaining conflicts.",
          );
          this.reviewable = this.reviewable.filter(
            (item) => item.uid !== conflict.uid,
          );
        } catch (error) {
          this.report(error);
          noteButton.disabled = false;
          googleButton.disabled = false;
        } finally {
          this.busy = false;
          this.syncing.set(false);
        }
      };
      noteButton.addEventListener("click", () => void choose("note"));
      googleButton.addEventListener("click", () => void choose("google"));
    }
    modal.open();
  }

  private api(calendarId = this.getSettings().googleCalendar.calendarId) {
    return new GoogleCalendarApi(
      this.auth,
      this.getSettings().googleCalendar.clientId.trim(),
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
