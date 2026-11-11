import { TFile, type App } from "obsidian";

import type { PeriodicNotes } from "../service/periodic-notes";
import { locateSource } from "../service/source-identity";
import type { DayPlannerSettings } from "../settings";

import { resolveIdentities, type IdentityCandidate } from "./identity";
import {
  appendToPlanner,
  parseBlocks,
  renderBlock,
  stripSyncMarkers,
  syncMarker,
} from "./markdown";
import {
  sameSnapshot,
  type CalendarNotes,
  type CalendarSnapshot,
  type CalendarSyncState,
  type LocalBlock,
  type SyncRecord,
  type LocalIdentity,
} from "./types";

export interface CalendarNoteWritePlan {
  block: LocalBlock & { from: number };
  edits: Array<{ path: string; before: string; after: string }>;
}

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
    await this.recoverMove();
    const candidates: IdentityCandidate[] = [];
    const scannedDocuments: Record<string, string> = {};
    const edits: Array<{ path: string; before: string; after: string }> = [];
    for (const file of Object.values(this.daily.getAllDailyNotes())) {
      const day = this.daily.getDateFromFile(file, "day");
      if (!day) continue;
      const date = day.format("YYYY-MM-DD");
      const text = await this.app.vault.read(file);
      // Keep known IDs discoverable after moving a block outside the sync window.
      const inWindow =
        day.valueOf() >= Date.parse(this.timeMin) &&
        day.valueOf() < Date.parse(this.timeMax);
      const cleaned = stripSyncMarkers(text);
      scannedDocuments[file.path] = cleaned;
      const legacy = parseBlocks(text, date, this.settings);
      const parsed = parseBlocks(cleaned, date, this.settings);
      parsed.forEach((block, index) =>
        candidates.push({
          uid: legacy[index]?.uid,
          path: file.path,
          from: block.from,
          raw: block.raw,
          snapshot: block.snapshot,
          eligible: inWindow,
        }),
      );
      if (text !== cleaned)
        edits.push({ path: file.path, before: text, after: cleaned });
    }
    const identities = { ...this.state.identities };
    for (const [uid, record] of Object.entries(this.state.records))
      identities[uid] ??= {
        path: record.path,
        raw: "",
        snapshot: record.base,
        from: -1,
      };
    // Deleted events keep their tombstones, without claiming another note block.
    for (const [uid, record] of Object.entries(this.state.records))
      if (record.deleted) delete identities[uid];
    resolveIdentities(candidates, identities);
    const blocks: LocalBlock[] = [];
    for (const candidate of candidates) {
      const uid =
        candidate.uid ??
        (candidate.eligible
          ? crypto.randomUUID().replace(/-/g, "")
          : undefined);
      if (!uid) continue;
      const { path, raw, snapshot, from } = candidate;
      identities[uid] = { path, raw, snapshot, from };
      blocks.push({ uid, path, raw, snapshot, from });
    }
    const assigned = new Set(blocks.map((block) => block.uid));
    const missingPaths = new Set(
      Object.entries(identities)
        .filter(([uid]) => !assigned.has(uid))
        .map(([, identity]) => identity.path),
    );
    const documents = { ...this.state.documents };
    for (const [path, text] of Object.entries(scannedDocuments))
      if (
        !missingPaths.has(path) &&
        blocks.some((block) => block.path === path)
      )
        documents[path] = text;
    await this.changeNotes(edits, identities, documents);
    return blocks;
  }

  private async changeNotes(
    edits: Array<{ path: string; before: string; after: string }>,
    identities: Record<string, LocalIdentity>,
    documents = {
      ...this.state.documents,
      ...Object.fromEntries(edits.map((edit) => [edit.path, edit.after])),
    },
  ) {
    this.state.version = 2;
    if (!edits.length) {
      this.state.identities = identities;
      this.state.documents = documents;
      await this.save();
      return;
    }
    this.state.pendingNoteChange = { edits, identities, documents };
    await this.save();
    await this.recoverNoteChange();
  }

  private async recoverNoteChange() {
    const pending = this.state.pendingNoteChange;
    if (!pending) return;
    for (const edit of pending.edits) {
      const text = await this.app.vault.read(this.file(edit.path));
      if (text !== edit.before && text !== edit.after)
        throw new Error(
          `Note changed during calendar recovery: ${edit.path}. Restore the note from history before retrying.`,
        );
    }
    for (const edit of pending.edits) {
      await this.app.vault.process(this.file(edit.path), (text) => {
        if (text === edit.after) return text;
        if (text !== edit.before)
          throw new Error("The note changed during sync; retry.");
        return edit.after;
      });
    }
    this.state.identities = pending.identities;
    this.state.documents = pending.documents;
    delete this.state.pendingNoteChange;
    await this.save();
  }

  private locate(text: string, block: LocalBlock) {
    return locateSource(text, block);
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
    return this.locate(text, block) >= 0;
  }

  async canDelete(record: SyncRecord, uid: string) {
    if (!this.settings.googleCalendar.syncDeletions) return false;
    // Moving a block to an unindexed note or changing its heading is not deletion.
    for (const note of this.app.vault.getMarkdownFiles()) {
      const text = await this.app.vault.read(note);
      const identity = this.state.identities?.[uid];
      if (
        text.includes(`<!-- dp-gcal:${uid} -->`) ||
        (identity && text.includes(identity.raw))
      )
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
    const identity = this.state.identities?.[uid];
    const before = this.state.documents?.[record.path];
    if (!identity || before === undefined || !identity.raw) return false;
    const index = this.locate(before, { uid, ...identity });
    if (index < 0) return false;
    const removed =
      before.slice(0, index) + before.slice(index + identity.raw.length);
    const normalize = (value: string) =>
      value
        .replace(/\r\n/g, "\n")
        .replace(/\n[ \t]*\n+/g, "\n\n")
        .trim();
    return normalize(text) === normalize(removed);
  }

  async write(
    uid: string,
    snapshot: CalendarSnapshot,
    previous?: LocalBlock,
  ): Promise<LocalBlock> {
    return this.applyWrite(await this.prepareWrite(uid, snapshot, previous));
  }

  async prepareWrite(
    uid: string,
    snapshot: CalendarSnapshot,
    previous?: LocalBlock,
    ensurePlanner = false,
    templateRaw?: string,
  ): Promise<CalendarNoteWritePlan> {
    const raw = renderBlock(
      uid,
      snapshot,
      this.settings,
      previous?.raw ?? templateRaw,
    );
    const target = await this.daily.createDailyNoteIfNeeded(
      window.moment(snapshot.start).startOf("day"),
    );
    const before = await this.app.vault.read(target);
    const edits: Array<{ path: string; before: string; after: string }> = [];
    let after: string;
    let from: number;
    const alreadyInPlanner =
      previous &&
      parseBlocks(
        before,
        window.moment(snapshot.start).format("YYYY-MM-DD"),
        this.settings,
      ).some(
        (block) => block.from === previous.from && block.raw === previous.raw,
      );
    if (
      previous &&
      previous.path === target.path &&
      (!ensurePlanner || alreadyInPlanner)
    ) {
      from = this.locate(before, previous);
      if (from < 0) throw new Error("The note changed during sync; retry.");
      after =
        before.slice(0, from) + raw + before.slice(from + previous.raw.length);
    } else {
      let destination = before;
      if (previous?.path === target.path) {
        const index = this.locate(before, previous);
        if (index < 0)
          throw new Error("The note changed during scheduling; retry.");
        destination =
          before.slice(0, index) + before.slice(index + previous.raw.length);
      }
      after = appendToPlanner(destination, raw, this.settings);
      const appended = parseBlocks(
        after,
        window.moment(snapshot.start).format("YYYY-MM-DD"),
        this.settings,
      )
        .filter((block) => block.raw === raw)
        .at(-1);
      if (!appended)
        throw new Error("Could not locate the imported calendar block.");
      from = appended.from;
    }
    edits.push({ path: target.path, before, after });
    if (previous && previous.path !== target.path) {
      const sourceText = await this.app.vault.read(this.file(previous.path));
      const index = this.locate(sourceText, previous);
      if (index < 0)
        throw new Error("The source note changed during sync; retry.");
      edits.push({
        path: previous.path,
        before: sourceText,
        after:
          sourceText.slice(0, index) +
          sourceText.slice(index + previous.raw.length),
      });
    }
    const identity = { path: target.path, raw, snapshot, from };
    return { block: { uid, ...identity }, edits };
  }

  async applyWrite(plan: CalendarNoteWritePlan): Promise<LocalBlock> {
    if (this.state.pendingNoteChange || this.state.pendingMove)
      throw new Error(
        "Finish the pending calendar note operation before applying another write.",
      );
    const { uid, ...identity } = plan.block;
    await this.changeNotes(plan.edits, {
      ...this.state.identities,
      [uid]: identity,
    });
    return plan.block;
  }

  async applyEdits(
    edits: Array<{ path: string; before: string; after: string }>,
  ) {
    if (this.state.pendingNoteChange || this.state.pendingMove)
      throw new Error(
        "Finish the pending note operation before applying another write.",
      );
    await this.changeNotes(edits, { ...this.state.identities });
  }

  async recoverMove() {
    await this.recoverNoteChange();
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
      const index = this.locate(text, block);
      if (index < 0) throw new Error("The note changed during sync; retry.");
      const lines = block.raw.split(/\r?\n/);
      const first = lines[0] ?? "";
      // Preserve the full task/subtree as an untimed, visibly cancelled entry.
      const range = first
        .replace(syncMarker, "")
        .replace(/^\s*(?:[-*+]|\d+[.)])\s+(?:\[[^\]]\]\s*)?/, "");
      lines[0] = `- [-] Cancelled in Google Calendar: ${range.trim()}`;
      return (
        text.slice(0, index) +
        lines.join(block.raw.includes("\r\n") ? "\r\n" : "\n") +
        text.slice(index + block.raw.length)
      );
    });
  }
}
