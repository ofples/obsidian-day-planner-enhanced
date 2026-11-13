import { TFile, type App } from "obsidian";

import { getTimeRangeMatch } from "../parser/parser";
import { checkboxRegExp, listTokenWithSpacesRegExp } from "../regexp";
import type { TransactionWriter } from "../service/diff-writer";
import type { PeriodicNotes } from "../service/periodic-notes";
import { locateSource } from "../service/source-identity";
import type { DayPlannerSettings } from "../settings";

import { resolveIdentities, type IdentityCandidate } from "./identity";
import {
  appendToPlanner,
  hasPlannerSection,
  parseBlocks,
  renderBlock,
  stripSyncMarkers,
  syncMarker,
  type ParsedBlock,
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

function withoutBlocks(text: string, blocks: ParsedBlock[]) {
  let end = 0;
  const chunks = blocks.map((block) => {
    const chunk = text.slice(end, block.from);
    const newline = text.slice(block.to, block.to + 2).match(/^\r?\n/);
    end = block.to + (newline?.[0].length ?? 0);
    return chunk;
  });
  return chunks.join("") + text.slice(end);
}

function normalizeDocument(value: string) {
  return value
    .replace(/\r\n/g, "\n")
    .replace(/\n[ \t]*\n+/g, "\n\n")
    .trim();
}

function struckCancellation(value: string) {
  const match = value.trim().match(/^(.*?)(\s+\^[\w-]+)?$/);
  return `~~${match?.[1] ?? value.trim()}~~${match?.[2] ?? ""}`;
}

function untrackedTasks(text: string) {
  return text
    .split(/\r?\n/)
    .filter((line) => {
      const unquoted = line.replace(/^\s*(?:>\s*)+/, "");
      const prefix = unquoted.match(listTokenWithSpacesRegExp)?.[0];
      return (
        prefix &&
        (unquoted.slice(prefix.length).match(checkboxRegExp)?.index === 0 ||
          getTimeRangeMatch(unquoted))
      );
    })
    .map((line) => line.trimEnd())
    .join("\n");
}

export class ObsidianCalendarNotes implements CalendarNotes {
  private readonly missingPaths = new Set<string>();
  private scannedDocuments: Record<string, string> = {};
  private scanRevision?: number;

  constructor(
    private readonly app: App,
    private readonly daily: PeriodicNotes,
    private readonly settings: DayPlannerSettings,
    private readonly timeMin: string,
    private readonly timeMax: string,
    private readonly state: CalendarSyncState,
    private readonly save: () => Promise<void>,
    private readonly edits?: Pick<TransactionWriter, "isWriting" | "revision">,
  ) {}

  private notesCurrent() {
    return !this.edits?.isWriting && this.edits?.revision === this.scanRevision;
  }

  async scan(): Promise<LocalBlock[]> {
    this.scanRevision = this.edits?.revision;
    if (!this.notesCurrent())
      throw new Error(
        "Wait for the current note edit to finish, then sync again.",
      );
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
      const cleaned = stripSyncMarkers(text).replace(
        /^([ \t]*[-*+][ \t]+\[-\][ \t]*)Cancelled in Google Calendar:[ \t]*([^\r\n]+)$/gm,
        (_line, prefix: string, value: string) =>
          `${prefix}${struckCancellation(value)}`,
      );
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
    if (!this.notesCurrent())
      throw new Error(
        "The notes changed during calendar scanning. Sync again after the edit finishes.",
      );
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
    this.missingPaths.clear();
    for (const [uid, identity] of Object.entries(identities)) {
      if (assigned.has(uid)) continue;
      if (this.state.records[uid] || this.state.pendingCreate?.uid === uid)
        this.missingPaths.add(identity.path);
      else delete identities[uid];
    }
    const documents = { ...this.state.documents };
    for (const [path, text] of Object.entries(scannedDocuments))
      if (
        !this.missingPaths.has(path) &&
        blocks.some((block) => block.path === path)
      )
        documents[path] = text;
    await this.changeNotes(edits, identities, documents);
    this.scannedDocuments = scannedDocuments;
    return blocks;
  }

  private async changeNotes(
    edits: Array<{ path: string; before: string; after: string }>,
    identities: Record<string, LocalIdentity>,
    documents = {
      ...this.state.documents,
      ...Object.fromEntries(
        edits
          .filter((edit) => !this.missingPaths.has(edit.path))
          .map((edit) => [edit.path, edit.after]),
      ),
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
    for (const edit of edits)
      if (this.scannedDocuments[edit.path] === edit.before)
        this.scannedDocuments[edit.path] = edit.after;
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
    if (!this.notesCurrent()) return false;
    const file = this.app.vault.getAbstractFileByPath(block.path);
    if (!(file instanceof TFile)) return false;
    const text = await this.app.vault.read(file);
    return this.notesCurrent() && this.locate(text, block) >= 0;
  }

  async canDelete(record: SyncRecord, uid: string, owned = false) {
    if (!this.notesCurrent()) return false;
    if (!this.settings.googleCalendar.syncDeletions) return false;
    const identity = this.state.identities?.[uid];
    const before = this.state.documents?.[record.path];
    if (!identity?.raw || before === undefined) return false;
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
    // Match whole lines so a time-only block does not match a titled task.
    const blockPattern = identity.raw
      .split(/\r?\n/)
      .map((line) => line.trimEnd().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join("[ \\t]*\\r?\\n");
    const exactBlock = new RegExp(`^[ \\t]*${blockPattern}[ \\t]*$`, "m");
    const stillPresent = (text: string) =>
      text.includes(`<!-- dp-gcal:${uid} -->`) || exactBlock.test(text);
    const text = await this.app.vault.read(file);
    const date = day.format("YYYY-MM-DD");
    const parsed = parseBlocks(text, date, this.settings);
    if (owned) {
      if (
        text !== this.scannedDocuments[record.path] ||
        !hasPlannerSection(text, this.settings)
      )
        return false;
      // Require an identity scanned in this note. The saved document can
      // predate that block when a different removal is still unresolved.
      // Untracked task changes can indicate a move or conversion.
      const oldBlocks = parseBlocks(before, date, this.settings);
      const outside = withoutBlocks(text, parsed);
      if (
        identity.path !== record.path ||
        identity.from < 0 ||
        stillPresent(outside) ||
        untrackedTasks(outside) !==
          untrackedTasks(withoutBlocks(before, oldBlocks))
      )
        return false;
    } else {
      const index = this.locate(before, { uid, ...identity });
      if (index < 0) return false;
      const removed =
        before.slice(0, index) + before.slice(index + identity.raw.length);
      if (
        stillPresent(text) ||
        text.includes(record.base.title) ||
        parsed.some((block) => sameSnapshot(block.snapshot, record.base)) ||
        normalizeDocument(text) !== normalizeDocument(removed)
      )
        return false;
    }
    // An exact block moved to an unindexed note still belongs to the planner.
    for (const note of this.app.vault.getMarkdownFiles()) {
      if (
        note.path !== file.path &&
        stillPresent(await this.app.vault.read(note))
      )
        return false;
    }
    return (await this.app.vault.read(file)) === text && this.notesCurrent();
  }

  async write(
    uid: string,
    snapshot: CalendarSnapshot,
    previous?: LocalBlock,
    templateRaw?: string,
  ): Promise<LocalBlock> {
    return this.applyWrite(
      await this.prepareWrite(uid, snapshot, previous, false, templateRaw),
    );
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
      templateRaw ?? previous?.raw,
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
      lines[0] = `- [-] ${struckCancellation(range)}`;
      return (
        text.slice(0, index) +
        lines.join(block.raw.includes("\r\n") ? "\r\n" : "\n") +
        text.slice(index + block.raw.length)
      );
    });
  }
}
