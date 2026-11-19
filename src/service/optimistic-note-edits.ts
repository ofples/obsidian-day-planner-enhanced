import type { Nodes } from "mdast";
import type { CachedMetadata, Pos } from "obsidian";
import { get, writable } from "svelte/store";

import { fromMarkdown } from "../mdast/mdast";
import { selectPlanTimeBlocksForVisibleDays } from "../redux/index/index-selectors";
import { filesIndexed, indexSlice } from "../redux/index/index-slice";
import type { RootState } from "../redux/store";
import { parseCaptureCandidates } from "../tasks/capture-parser";

import type { IndexService } from "./index/index-service";

function positionOf(node: Nodes): Pos {
  const position = node.position!;
  return {
    start: {
      line: position.start.line - 1,
      col: position.start.column - 1,
      offset: position.start.offset!,
    },
    end: {
      line: position.end.line - 1,
      col: position.end.column - 1,
      offset: position.end.offset!,
    },
  };
}

/** Temporary list metadata for the existing indexers. The saved index stays authoritative. */
function previewMetadata(text: string): CachedMetadata {
  const metadata: CachedMetadata = { listItems: [], headings: [] };
  function visit(node: Nodes, parent = -1) {
    let childParent = parent;
    if (node.type === "listItem") {
      const position = positionOf(node);
      // Obsidian indexes the item's own content separately from its child list.
      const nestedList = node.children.findIndex(
        (child) => child.type === "list",
      );
      if (nestedList >= 0) {
        const ownContent = node.children[nestedList - 1];
        if (ownContent) position.end = positionOf(ownContent).end;
        else {
          const newline = text.indexOf("\n", position.start.offset);
          let end = newline < 0 ? text.length : newline;
          if (text[end - 1] === "\r") end--;
          position.end = {
            line: position.start.line,
            col: position.start.col + end - position.start.offset,
            offset: end,
          };
        }
      }
      const task = text
        .slice(position.start.offset, position.end.offset)
        .match(/^(?:[-*+]|\d+[.)])\s+\[([^\]])\]/)?.[1];
      metadata.listItems!.push({
        position,
        parent,
        ...(task === undefined ? {} : { task }),
      });
      childParent = position.start.line;
    }
    if (node.type === "heading")
      metadata.headings!.push({
        position: positionOf(node),
        heading: text
          .slice(node.position!.start.offset, node.position!.end.offset)
          .replace(/^#+\s*/, "")
          .trim(),
        level: node.depth,
      });
    if ("children" in node)
      node.children.forEach((child) => visit(child, childParent));
  }
  visit(fromMarkdown(text));
  return metadata;
}

interface NotePreview {
  token: object;
  path: string;
  text: string;
  saved: boolean;
  expectedCapture: string;
}

/** Display projection only. A failed write cannot restore over a newer preview. */
export class OptimisticNoteEdits {
  readonly state = writable<NotePreview[]>([]);
  private lastTracker?: RootState["tracker"];
  private lastPreviews?: NotePreview[];
  private projectedTracker?: RootState["tracker"];
  constructor(
    private readonly services: IndexService[],
    private readonly source: () => RootState,
  ) {}

  begin = (path: string, text: string) => {
    const preview: NotePreview = {
      token: {},
      path,
      text,
      saved: false,
      expectedCapture: JSON.stringify(parseCaptureCandidates(path, text)),
    };
    this.state.update((items) => [
      ...items.filter((item) => item.path !== path),
      preview,
    ]);
    return (saved: boolean) => {
      this.state.update((items) =>
        items.flatMap((item) =>
          item.token !== preview.token
            ? [item]
            : saved
              ? [{ ...item, saved: true }]
              : [],
        ),
      );
      this.reconcile();
    };
  };

  reconcile() {
    const indexed = this.source().tracker.captureEntries;
    const settled = get(this.state).filter(
      (item) =>
        item.saved &&
        JSON.stringify(indexed[item.path] ?? []) === item.expectedCapture,
    );
    if (settled.length)
      this.state.update((items) =>
        items.filter((item) => !settled.includes(item)),
      );
  }

  blocks(state: RootState, previews: NotePreview[]) {
    if (!previews.length) return selectPlanTimeBlocksForVisibleDays(state);
    if (
      state.tracker === this.lastTracker &&
      previews === this.lastPreviews &&
      this.projectedTracker
    )
      return selectPlanTimeBlocksForVisibleDays({
        ...state,
        tracker: this.projectedTracker,
      });
    const indexes = previews.map(({ path, text }) => {
      const metadata = previewMetadata(text);
      const contributions = this.services.map((service) =>
        service.index({ path, text, metadata }),
      );
      return {
        path,
        captureEntries: contributions.flatMap(
          (value) => value.captureEntries ?? [],
        ),
        listItemEntries: contributions.flatMap(
          (value) => value.listItemEntries ?? [],
        ),
        planEntries: contributions.flatMap((value) => value.planEntries ?? []),
      };
    });
    this.lastTracker = state.tracker;
    this.lastPreviews = previews;
    this.projectedTracker = indexSlice.reducer(
      state.tracker,
      filesIndexed(indexes),
    );
    return selectPlanTimeBlocksForVisibleDays({
      ...state,
      tracker: this.projectedTracker,
    });
  }

  clear() {
    this.state.set([]);
  }
}
