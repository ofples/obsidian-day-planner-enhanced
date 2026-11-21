import { get, writable } from "svelte/store";

import { fromMarkdown } from "../mdast/mdast";
import { removeTimeRangeFromLine } from "../parser/parser";
import type { ListItemEntryWithChildren } from "../redux/index/index-slice";
import { createListItemEntry } from "../service/index/list-item-utils";
import type { EditableTimeBlock } from "../time-block-types";

import type { NoteTaskReference, ChecklistNoteReference } from "./note-drag";
import type { ScheduleInterval } from "./schedule-types";
import { taskSourceSchema, type TaskSource } from "./source";

export type DropDestination =
  | { interval: ScheduleInterval }
  | { parent: ChecklistNoteReference }
  | { path: string; offset: number; before: string; timePrefix?: string };

export interface PendingDrop {
  source?: { provider: string; accountId: string };
  id: string;
  raw: string;
  destination: DropDestination;
  previous?: NoteTaskReference;
  taskIds: string[];
  saved?: TaskSource;
  targetPath?: string;
}

/** Display-only drop receipts. Persistence and provider calls retain their existing queues. */
export class TaskDropFeedback {
  readonly state = writable<PendingDrop[]>([]);
  private blocks: EditableTimeBlock[] = [];

  async run<T>(drop: PendingDrop, persist: () => Promise<T>): Promise<T> {
    if (get(this.state).some((item) => item.id === drop.id)) return persist();
    this.state.update((items) => [...items, drop]);
    try {
      const result = await persist();
      const saved = taskSourceSchema.safeParse(result);
      if (saved.success) {
        this.state.update((items) =>
          items.map((item) =>
            item.id === drop.id ? { ...item, saved: saved.data } : item,
          ),
        );
        this.reconcile(this.blocks);
      } else this.remove(drop.id);
      return result;
    } catch (error) {
      this.remove(drop.id);
      throw error;
    }
  }

  remove(id: string) {
    this.state.update((items) => items.filter((item) => item.id !== id));
  }

  reconcile(blocks: EditableTimeBlock[]) {
    this.blocks = blocks;
    const settled = get(this.state).filter(
      (drop) => drop.saved && hasSource(blocks, drop.saved),
    );
    if (settled.length) {
      const ids = new Set(settled.map((drop) => drop.id));
      this.state.update((items) => items.filter((item) => !ids.has(item.id)));
    }
  }

  reconcileSources(sources: TaskSource[]) {
    const settled = get(this.state).filter(
      (drop) =>
        drop.saved &&
        sources.some(
          (source) =>
            source.path === drop.saved!.path &&
            source.raw.trimEnd() === drop.saved!.raw.trimEnd(),
        ),
    );
    if (settled.length) {
      const ids = new Set(settled.map((drop) => drop.id));
      this.state.update((items) => items.filter((item) => !ids.has(item.id)));
    }
  }

  clear() {
    this.state.set([]);
  }
}

function firstLine(raw: string) {
  return raw
    .split(/\r?\n/, 1)[0]!
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+(?:\[[^\]]\]\s*)?/, "")
    .trim();
}

function hasSource(blocks: EditableTimeBlock[], source: TaskSource) {
  const pending: Array<EditableTimeBlock | ListItemEntryWithChildren> = [
    ...blocks,
  ];
  while (pending.length) {
    const block = pending.pop()!;
    if (
      "path" in block &&
      block.path === source.path &&
      block.text.split(/\r?\n/, 1)[0]?.trim() === firstLine(source.raw)
    )
      return true;
    pending.push(...(block.children ?? []));
  }
  return false;
}

/** Use the same list-entry representation as indexed Markdown, including descriptions and descendants. */
const entryCache = new WeakMap<PendingDrop, ListItemEntryWithChildren>();
function previewEntry(drop: PendingDrop) {
  const cached = entryCache.get(drop);
  if (cached) return cached;
  const root = fromMarkdown(drop.raw);
  const list = root.children.find((node) => node.type === "list");
  const item = list?.children[0];
  if (!item?.position) return undefined;
  const entry = (
    node: typeof item,
    suffix: string,
  ): ListItemEntryWithChildren => {
    const position = {
      start: {
        line: node.position!.start.line - 1,
        col: node.position!.start.column - 1,
        offset: node.position!.start.offset!,
      },
      end: {
        line: node.position!.end.line - 1,
        col: node.position!.end.column - 1,
        offset: node.position!.end.offset!,
      },
    };
    const result = createListItemEntry({
      path: "",
      contents: drop.raw,
      listItemCache: {
        position,
        parent: -1,
        task: node.checked === null ? undefined : node.checked ? "x" : " ",
      },
    });
    return {
      ...result,
      id: `pending-drop-${drop.id}-${suffix}`,
      children: node.children.flatMap((child) =>
        child.type === "list"
          ? child.children.map((nested, index) =>
              entry(nested, `${suffix}-${index}`),
            )
          : [],
      ),
    };
  };
  const result = entry(item, "root");
  entryCache.set(drop, result);
  return result;
}

export function withPendingDrops(
  blocks: EditableTimeBlock[],
  drops: PendingDrop[],
): EditableTimeBlock[] {
  let result = blocks;
  for (const drop of drops) {
    if (drop.saved && hasSource(blocks, drop.saved)) continue;
    if (
      "interval" in drop.destination &&
      blocks.some((block) => {
        const target = drop.destination as { interval: ScheduleInterval };
        return (
          block.startTime.isSame(target.interval.start) &&
          block.durationMinutes ===
            window
              .moment(target.interval.end)
              .diff(window.moment(target.interval.start), "minutes") &&
          removeTimeRangeFromLine(firstLine(block.text)).trim() ===
            removeTimeRangeFromLine(firstLine(drop.raw)).trim()
        );
      })
    )
      continue;
    const entry = previewEntry(drop);
    if (!entry) continue;
    if (drop.previous && drop.previous.kind !== "note") {
      const previous = drop.previous;
      result = result.filter(
        (block) =>
          block.source === "unwritten" ||
          block.path !== previous.path ||
          block.position.start.line !== previous.line,
      );
    }
    if ("parent" in drop.destination) {
      const parent = drop.destination.parent;
      const candidates = result.filter(
        (block) =>
          block.source !== "unwritten" &&
          block.path === parent.path &&
          firstLine(block.text) === firstLine(parent.text),
      );
      const target =
        candidates.find(
          (block) =>
            block.source !== "unwritten" &&
            block.position.start.line === parent.line,
        ) ?? (candidates.length === 1 ? candidates[0] : undefined);
      result = result.map((block) =>
        block === target
          ? { ...block, children: [...(block.children ?? []), entry] }
          : block,
      );
    } else if ("interval" in drop.destination) {
      const { start, end } = drop.destination.interval;
      result = [
        ...result,
        {
          ...entry,
          source: "unwritten",
          destination: { type: "plannerHeading" },
          startTime: window.moment(start),
          durationMinutes: window
            .moment(end)
            .diff(window.moment(start), "minutes"),
          optimistic: true,
        },
      ];
    }
  }
  return result;
}
