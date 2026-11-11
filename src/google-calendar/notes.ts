import { TFile, type App } from "obsidian";

import type { PeriodicNotes } from "../service/periodic-notes";
import type { DayPlannerSettings } from "../settings";

import {
  addMarker,
  appendToPlanner,
  parseBlocks,
  renderBlock,
  syncMarker,
} from "./markdown";
import {
  sameSnapshot,
  type CalendarNotes,
  type CalendarSnapshot,
  type CalendarSyncState,
  type LocalBlock,
  type SyncRecord,
} from "./types";

export class ObsidianCalendarNotes implements CalendarNotes {
  constructor(
    private readonly app: App,
    private readonly daily: PeriodicNotes,
    private readonly settings: DayPlannerSettings,
    private readonly timeMin: string,
    private readonly timeMax: string,
    private readonly state: CalendarSyncState,
    private readonly save: () => Promise<void>,
  ) {}

  async scan(): Promise<LocalBlock[]> {
    const blocks: LocalBlock[] = [];
    for (const file of Object.values(this.daily.getAllDailyNotes())) {
      const day = this.daily.getDateFromFile(file, "day");
      if (!day) continue;
      const date = day.format("YYYY-MM-DD");
      let text = await this.app.vault.read(file);
      // Keep known IDs discoverable after moving a block outside the sync window.
      const inWindow =
        day.valueOf() >= Date.parse(this.timeMin) &&
        day.valueOf() < Date.parse(this.timeMax);
      let parsed = parseBlocks(text, date, this.settings);
      if (inWindow && parsed.some((block) => !block.uid)) {
        await this.app.vault.process(file, (current) => {
          const candidates = parseBlocks(current, date, this.settings)
            .filter((block) => !block.uid)
            .reverse();
          let next = current;
          for (const candidate of candidates) {
            const firstEnd = candidate.raw.search(/\r?\n/);
            const length = firstEnd < 0 ? candidate.raw.length : firstEnd;
            const line = candidate.raw.slice(0, length);
            const uid = crypto.randomUUID().replace(/-/g, "");
            next =
              next.slice(0, candidate.from) +
              addMarker(line, uid) +
              next.slice(candidate.from + length);
          }
          return next;
        });
        text = await this.app.vault.read(file);
        parsed = parseBlocks(text, date, this.settings);
      }
      for (const block of parsed) {
        if (block.uid)
          blocks.push({
            uid: block.uid,
            path: file.path,
            raw: block.raw,
            snapshot: block.snapshot,
          });
      }
    }
    return blocks;
  }

  private file(path: string) {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile))
      throw new Error(`Daily note is missing: ${path}`);
    return file;
  }

  async isUnchanged(block: LocalBlock) {
    const file = this.app.vault.getAbstractFileByPath(block.path);
    if (!(file instanceof TFile)) return false;
    const text = await this.app.vault.read(file);
    return text.includes(block.raw);
  }

  async canDelete(record: SyncRecord, uid: string) {
    if (!this.settings.googleCalendar.syncDeletions) return false;
    // Moving a block to an unindexed note or changing its heading is not deletion.
    for (const note of this.app.vault.getMarkdownFiles()) {
      if ((await this.app.vault.read(note)).includes(`<!-- dp-gcal:${uid} -->`))
        return false;
    }
    const file = this.app.vault.getAbstractFileByPath(record.path);
    if (!(file instanceof TFile)) return false;
    const day = this.daily.getDateFromFile(file, "day");
    if (
      !day ||
      !Object.values(this.daily.getAllDailyNotes()).some(
        (note) => note.path === file.path,
      )
    )
      return false;
    const text = await this.app.vault.read(file);
    const parsed = parseBlocks(text, day.format("YYYY-MM-DD"), this.settings);
    // A removed/changed marker or heading is ambiguous, so do not delete Google data.
    if (parsed.some((block) => sameSnapshot(block.snapshot, record.base)))
      return false;
    if (text.includes(record.base.title)) return false;
    return true;
  }

  async write(
    uid: string,
    snapshot: CalendarSnapshot,
    previous?: LocalBlock,
  ): Promise<LocalBlock> {
    const raw = renderBlock(uid, snapshot, this.settings, previous?.raw);
    const target = await this.daily.createDailyNoteIfNeeded(
      window.moment(snapshot.start).startOf("day"),
    );
    if (previous && previous.path !== target.path) {
      this.state.pendingMove = {
        source: previous,
        targetPath: target.path,
        raw,
        snapshot,
      };
      await this.save();
      await this.recoverMove();
      return { uid, path: target.path, raw, snapshot };
    }
    await this.app.vault.process(target, (text) => {
      if (previous) {
        const index = text.indexOf(previous.raw);
        if (index < 0) throw new Error("The note changed during sync; retry.");
        return (
          text.slice(0, index) + raw + text.slice(index + previous.raw.length)
        );
      }
      if (text.includes(`<!-- dp-gcal:${uid} -->`))
        throw new Error("Sync ID already exists in destination note.");
      return appendToPlanner(text, raw, this.settings);
    });
    return { uid, path: target.path, raw, snapshot };
  }

  async recoverMove() {
    const pending = this.state.pendingMove;
    if (!pending) return;
    const { source, targetPath, raw } = pending;
    const sourceFile = this.file(source.path);
    const targetFile = this.file(targetPath);
    const marker = `<!-- dp-gcal:${source.uid} -->`;
    const sourceText = await this.app.vault.read(sourceFile);
    const targetText = await this.app.vault.read(targetFile);
    if (sourceText.includes(marker) && !sourceText.includes(source.raw)) {
      throw new Error(
        "A note changed during a pending calendar move. Keep the block with its sync ID in one daily note and retry.",
      );
    }
    if (!sourceText.includes(marker) && !targetText.includes(marker)) {
      throw new Error(
        "A pending calendar move is missing both copies. Restore the block from note history before syncing.",
      );
    }
    if (
      targetText.includes(marker) &&
      !targetText.includes(raw) &&
      sourceText.includes(marker)
    ) {
      throw new Error(
        "Both copies of a pending calendar move were edited. Resolve the duplicate sync ID before retrying.",
      );
    }
    await this.app.vault.process(targetFile, (text) => {
      if (text.includes(marker)) return text;
      return appendToPlanner(text, raw, this.settings);
    });
    await this.app.vault.process(sourceFile, (text) => {
      if (!text.includes(marker)) return text;
      const index = text.indexOf(source.raw);
      if (index < 0)
        throw new Error(
          "Source note changed during the calendar move; both copies were preserved.",
        );
      return text.slice(0, index) + text.slice(index + source.raw.length);
    });
    delete this.state.pendingMove;
    await this.save();
  }

  async cancel(block: LocalBlock) {
    await this.app.vault.process(this.file(block.path), (text) => {
      const index = text.indexOf(block.raw);
      if (index < 0) throw new Error("The note changed during sync; retry.");
      const lines = block.raw.split(/\r?\n/);
      const first = lines[0] ?? "";
      // Preserve the full task/subtree as an untimed, visibly cancelled entry.
      const range = first
        .replace(syncMarker, "")
        .replace(/^\s*(?:[-*+]|\d+[.)])\s+(?:\[[^\]]\]\s*)?/, "");
      lines[0] = `- [-] Cancelled in Google Calendar: ${range.trim()} <!-- dp-gcal-cancelled:${block.uid} -->`;
      return (
        text.slice(0, index) +
        lines.join(block.raw.includes("\r\n") ? "\r\n" : "\n") +
        text.slice(index + block.raw.length)
      );
    });
  }
}
