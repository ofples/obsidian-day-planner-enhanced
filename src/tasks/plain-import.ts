import { get, writable } from "svelte/store";
import { z } from "zod";

import type { GoogleCalendarSync } from "../google-calendar/service";
import { getTimeRangeMatch } from "../parser/parser";
import { locateSource } from "../service/source-identity";
import { hasTaskLock } from "../util/task-lock";

import { parseCaptureCandidates } from "./capture-parser";
import {
  indentTaskSubtree,
  scheduleNoteTitle,
  subtaskInsertTarget,
} from "./schedule-markdown";
import type { ScheduleInterval } from "./schedule-types";
import { taskSourceSchema, type TaskSource } from "./source";

const importSourceSchema = taskSourceSchema.extend({
  uid: z.string().optional(),
  taskIds: z.array(z.string()).optional(),
});
export type ImportedTaskSource = z.infer<typeof importSourceSchema>;
const pendingSchema = z.object({
  id: z.uuid(),
  signature: z.string(),
  taskIds: z.array(z.string()).optional(),
  prepared: z
    .object({
      edits: z.array(
        z.object({ path: z.string(), before: z.string(), after: z.string() }),
      ),
      source: importSourceSchema,
    })
    .optional(),
});
const sidecarSchema = z.object({
  version: z.literal(2),
  imports: z.record(z.string(), importSourceSchema),
  pending: z.record(z.string(), pendingSchema),
  receipts: z
    .record(
      z.string(),
      z.object({
        key: z.string(),
        signature: z.string(),
        source: importSourceSchema,
      }),
    )
    .default({}),
});
type PendingImport = z.infer<typeof pendingSchema>;

export class PlainTaskImporter {
  private readonly deliveries = new Map<string, Promise<ImportedTaskSource>>();
  readonly imports = writable<Record<string, ImportedTaskSource>>({});
  private initialization?: Promise<void>;
  private pending: Record<string, PendingImport> = {};
  private receipts: z.infer<typeof sidecarSchema>["receipts"] = {};
  private metadataTail: Promise<void> = Promise.resolve();
  private readonly active = new Map<
    string,
    { signature: string; promise: Promise<ImportedTaskSource> }
  >();

  constructor(
    private readonly calendar: Pick<GoogleCalendarSync, "editNotes">,
    private readonly host: {
      read(path: string): Promise<string | null>;
      flush(paths: string[]): Promise<void>;
      readImports?(): Promise<string | null>;
      writeImports?(value: string): Promise<void>;
    },
  ) {}

  initialize() {
    return (this.initialization ??= this.load());
  }

  /** All verified placements remain available when the same task is copied to another day. */
  sources(): ReadonlyArray<readonly [string, ImportedTaskSource]> {
    return [
      ...Object.entries(get(this.imports)),
      ...Object.values(this.receipts).map(
        (receipt) => [receipt.key, receipt.source] as const,
      ),
    ];
  }

  private async load() {
    const text = await this.host.readImports?.();
    if (text) {
      const parsed: unknown = JSON.parse(text);
      const current = sidecarSchema.safeParse(parsed);
      if (current.success) {
        this.imports.set(current.data.imports);
        this.pending = current.data.pending;
        this.receipts = current.data.receipts;
      } else {
        this.imports.set(z.record(z.string(), taskSourceSchema).parse(parsed));
      }
    }
  }

  private updateMetadata(
    update: (state: z.infer<typeof sidecarSchema>) => void,
  ) {
    const operation = this.metadataTail.then(async () => {
      await this.initialize();
      const state = {
        version: 2 as const,
        imports: { ...get(this.imports) },
        pending: { ...this.pending },
        receipts: { ...this.receipts },
      };
      update(state);
      const checked = sidecarSchema.parse(state);
      await this.host.writeImports?.(JSON.stringify(checked));
      this.pending = checked.pending;
      this.receipts = checked.receipts;
      this.imports.set(checked.imports);
    });
    this.metadataTail = operation.then(
      () => {},
      () => {},
    );
    return operation;
  }

  /** Persist ownership before touching a note; a failed receipt remains retryable. */
  async runPane(
    key: string,
    id: string,
    signature: string,
    apply: (
      id: string,
      prepare: (plan: NonNullable<PendingImport["prepared"]>) => Promise<void>,
      pending: PendingImport,
    ) => Promise<ImportedTaskSource>,
    taskIds?: string[],
  ): Promise<ImportedTaskSource> {
    await this.initialize();
    const receipt = this.receipts[id];
    if (receipt) {
      if (receipt.key !== key || receipt.signature !== signature)
        throw new Error(
          "This saved import belongs to a different task or destination.",
        );
      return receipt.source;
    }
    const active = this.active.get(key);
    if (active) {
      if (active.signature !== signature)
        throw new Error(
          "Finish the previous task import before choosing a different destination.",
        );
      const source = await active.promise;
      await this.updateMetadata((state) => {
        const other = Object.entries(state.pending).find(
          ([otherKey, value]) => otherKey !== key && value.id === id,
        );
        const existing = state.receipts[id];
        if (
          other ||
          (existing &&
            (existing.key !== key || existing.signature !== signature))
        )
          throw new Error(
            "This saved import belongs to a different task or destination.",
          );
        state.receipts[id] = { key, signature, source };
      });
      return source;
    }
    const run = (async () => {
      await this.updateMetadata((state) => {
        const other = Object.entries(state.pending).find(
          ([otherKey, value]) => otherKey !== key && value.id === id,
        );
        if (other || (state.receipts[id] && state.receipts[id]!.key !== key))
          throw new Error(
            "This saved import belongs to a different task or destination.",
          );
        const existing = state.pending[key];
        if (existing && existing.signature !== signature)
          throw new Error(
            "Finish the previous task import before choosing a different destination.",
          );
        state.pending[key] ??= { id, signature, taskIds };
      });
      const saved = this.pending[key]!;
      let source: ImportedTaskSource;
      try {
        source = await apply(
          saved.id,
          async (prepared) => {
            await this.updateMetadata((state) => {
              if (state.pending[key]?.id !== saved.id)
                throw new Error(
                  "The pending task import changed. Review it before retrying.",
                );
              state.pending[key] = { ...state.pending[key]!, prepared };
            });
          },
          saved,
        );
        source = { ...source, taskIds: saved.taskIds ?? taskIds };
      } catch (error) {
        await this.updateMetadata((state) => {
          const current = state.pending[key];
          if (current?.id === saved.id && !current.prepared)
            delete state.pending[key];
        });
        throw error;
      }
      await this.updateMetadata((state) => {
        if (state.pending[key]?.id !== saved.id)
          throw new Error(
            "The pending task import changed. Review it before retrying.",
          );
        state.imports[key] = source;
        state.receipts[saved.id] = { key, signature, source };
        state.receipts[id] = { key, signature, source };
        delete state.pending[key];
      });
      return source;
    })();
    this.active.set(key, { signature, promise: run });
    try {
      return await run;
    } finally {
      if (this.active.get(key)?.promise === run) this.active.delete(key);
    }
  }

  private once(id: string, apply: () => Promise<ImportedTaskSource>) {
    const pending = this.deliveries.get(id);
    if (pending) return pending;
    const result = this.initialize().then(apply);
    this.deliveries.set(id, result);
    void result.catch(() => this.deliveries.delete(id));
    return result;
  }

  private async assertUnlocked(source: TaskSource) {
    const text = await this.host.read(source.path);
    const from = text === null ? -1 : locateSource(text, source);
    if (text === null || from < 0)
      throw new Error("The source task changed. Refresh before moving it.");
    if (
      parseCaptureCandidates(source.path, text).some(
        (candidate) =>
          candidate.from >= from &&
          candidate.to <= from + source.raw.length &&
          candidate.tags.some((tag) => tag.name.toLowerCase() === "locked"),
      )
    )
      throw new Error(
        "Unlock this task and its locked subtasks before moving them.",
      );
  }

  schedule(
    raw: string,
    interval: ScheduleInterval,
    id: string,
    previous?: TaskSource,
    prepare?: (plan: NonNullable<PendingImport["prepared"]>) => Promise<void>,
    saved?: PendingImport["prepared"],
  ) {
    return this.once(id, async () => {
      if (previous && hasTaskLock(previous.raw))
        throw new Error("Unlock this task before moving it.");
      await this.host.flush(previous ? [previous.path] : []);
      if (previous) await this.assertUnlocked(previous);
      return this.calendar.editNotes(async (notes, blocks) => {
        const uid =
          blocks.find(
            (block) =>
              block.path === previous?.path && block.raw === previous.raw,
          )?.uid ?? id.replace(/-/g, "");
        const known = blocks.find((block) => block.uid === uid);
        if (!previous && known) {
          const text = await this.host.read(known.path);
          const from = text === null ? -1 : locateSource(text, known);
          if (from < 0)
            throw new Error(
              "The imported task changed. Review its note before retrying.",
            );
          return {
            path: known.path,
            raw: known.raw,
            from,
            title: known.snapshot.title,
            uid,
          };
        }
        if (saved) {
          const current = await Promise.all(
            saved.edits.map((edit) => this.host.read(edit.path)),
          );
          if (
            current.every((text, index) => text === saved.edits[index]!.after)
          )
            return saved.source;
          if (
            !current.every((text, index) => text === saved.edits[index]!.before)
          )
            throw new Error(
              "The note changed during a pending task import. Review its saved state before retrying.",
            );
        }
        const snapshot = { ...interval, title: scheduleNoteTitle(raw) };
        const source = previous ? { ...previous, uid, snapshot } : known;
        const plan = await notes.prepareWrite(uid, snapshot, source, true, raw);
        if (saved && JSON.stringify(plan.edits) !== JSON.stringify(saved.edits))
          throw new Error(
            "The note changed during a pending task import. Review its saved state before retrying.",
          );
        await prepare?.({
          edits: plan.edits,
          source: {
            path: plan.block.path,
            raw: plan.block.raw,
            from: plan.block.from,
            title: plan.block.snapshot.title,
            uid,
          },
        });
        const block = await notes.applyWrite(plan);
        return {
          path: block.path,
          raw: block.raw,
          from: plan.block.from,
          title: block.snapshot.title,
          uid: block.uid,
        };
      });
    });
  }

  insert(
    raw: string,
    target: {
      path: string;
      offset: number;
      before: string;
      parent?: TaskSource;
      timePrefix?: string;
    },
    id: string,
    previous?: TaskSource,
    prepare?: (plan: NonNullable<PendingImport["prepared"]>) => Promise<void>,
    saved?: PendingImport["prepared"],
  ) {
    return this.once(id, async () => {
      if (previous && hasTaskLock(previous.raw))
        throw new Error("Unlock this task before moving it.");
      await this.host.flush([
        target.path,
        ...(previous ? [previous.path] : []),
      ]);
      if (previous) await this.assertUnlocked(previous);
      return this.calendar.editNotes(async (notes) => {
        if (saved) {
          const current = await Promise.all(
            saved.edits.map((edit) => this.host.read(edit.path)),
          );
          if (
            current.every((text, index) => text === saved.edits[index]!.after)
          )
            return saved.source;
          if (
            !current.every((text, index) => text === saved.edits[index]!.before)
          )
            throw new Error(
              "The note changed during a pending task import. Review its saved state before retrying.",
            );
          await notes.applyEdits(saved.edits);
          return saved.source;
        }
        const before = await this.host.read(target.path);
        if (before !== target.before)
          throw new Error("The destination note changed. Drop the task again.");
        let after = before;
        let offset = target.offset;
        const edits: { path: string; before: string; after: string }[] = [];
        let sourceIndent = "";
        if (previous) {
          const text =
            previous.path === target.path
              ? before
              : await this.host.read(previous.path);
          const from = text === null ? -1 : locateSource(text, previous);
          if (text === null || from < 0)
            throw new Error(
              "The source task changed. Refresh and drag it again.",
            );
          if (
            previous.path === target.path &&
            target.parent &&
            target.parent.from >= from &&
            target.parent.from < from + previous.raw.length
          )
            throw new Error("A task cannot contain itself or its subtasks.");
          sourceIndent = text.slice(text.lastIndexOf("\n", from - 1) + 1, from);
          const removed =
            text.slice(0, from) + text.slice(from + previous.raw.length);
          if (previous.path === target.path) {
            after = removed;
            if (offset > from) offset -= previous.raw.length;
          } else
            edits.push({ path: previous.path, before: text, after: removed });
        }
        const lines = raw.split(/\r?\n/);
        const range = getTimeRangeMatch(lines[0] ?? "");
        if (range)
          lines[0] = (
            lines[0]!.slice(0, range.startIndex).trimEnd() +
            " " +
            lines[0]!.slice(range.endIndex).trimStart()
          ).trimEnd();
        if (target.timePrefix)
          lines[0] = lines[0]!.replace(
            /^(\s*(?:[-*+]|\d+[.)])\s+(?:\[[^\]]\]\s*)?)/,
            `$1${target.timePrefix} `,
          );
        const newline = before.includes("\r\n") ? "\r\n" : "\n";
        const parent = target.parent;
        const indent = parent
          ? before.slice(
              before.lastIndexOf("\n", parent.from - 1) + 1,
              parent.from,
            ) +
            parent.raw
              .match(/^(?:[-*+]|\d+[.)])[ \t]+/)![0]
              .replace(/[^\t]/g, " ")
          : "";
        const content = indentTaskSubtree(
          lines.join(newline),
          sourceIndent,
          indent,
          newline,
        );
        const prefix = offset && after[offset - 1] !== "\n" ? newline : "";
        const suffix = /^\r?\n/.test(after.slice(offset)) ? "" : newline;
        after =
          after.slice(0, offset) +
          prefix +
          content +
          suffix +
          after.slice(offset);
        edits.push({ path: target.path, before, after });
        const source = {
          path: target.path,
          from: offset + prefix.length + indent.length,
          raw: content.trimStart(),
          title: lines[0]!,
        };
        await prepare?.({ edits, source });
        await notes.applyEdits(edits);
        return source;
      });
    });
  }

  async nest(
    raw: string,
    parent: { path: string; line: number; text: string },
    id: string,
    previous?: TaskSource,
    prepare?: (plan: NonNullable<PendingImport["prepared"]>) => Promise<void>,
    saved?: PendingImport["prepared"],
  ) {
    await this.host.flush([parent.path]);
    const before = await this.host.read(parent.path);
    if (before === null) throw new Error("The destination note is missing.");
    return this.insert(
      raw,
      subtaskInsertTarget(before, parent),
      id,
      previous,
      prepare,
      saved,
    );
  }
}
