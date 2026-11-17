import { StateEffect, StateField, type Transaction } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  WidgetType,
  type DecorationSet,
} from "@codemirror/view";
import { MarkdownView, type Plugin } from "obsidian";
import { get } from "svelte/store";

import type { PendingDrop, TaskDropFeedback } from "../tasks/drop-feedback";
import { rebaseDropOffset } from "../tasks/editor-drop";

/** Inline previews leave the editor document and its undo history untouched until the queued save. */
export function registerPendingTaskDrops(
  plugin: Plugin,
  feedback: TaskDropFeedback,
) {
  const changed = StateEffect.define<PendingDrop[]>();

  class TaskWidget extends WidgetType {
    constructor(
      private readonly id: string,
      private readonly text: string,
    ) {
      super();
    }
    eq(other: TaskWidget) {
      return this.id === other.id && this.text === other.text;
    }
    toDOM(view: EditorView) {
      const element = view.dom.ownerDocument.createElement("div");
      element.className = "dp-pending-editor-task";
      element.textContent = this.text;
      element.setAttribute("aria-label", "Saving dropped task");
      return element;
    }
    ignoreEvent() {
      return true;
    }
  }

  function decorations(drops: PendingDrop[], text: string) {
    return Decoration.set(
      drops.flatMap((drop) => {
        if (!("offset" in drop.destination)) return [];
        const target = drop.destination;
        if (drop.saved && text.includes(drop.saved.raw.replace(/\r\n/g, "\n")))
          return [];
        const position = Math.min(
          text.length,
          rebaseDropOffset(target.before, text, target.offset),
        );
        const lineStart = text.lastIndexOf("\n", position - 1) + 1;
        const side = position === lineStart ? -1 : 1;
        const raw = target.timePrefix
          ? drop.raw.replace(
              /^(\s*(?:[-*+]|\d+[.)])\s+(?:\[[^\]]\]\s*)?)/,
              `$1${target.timePrefix} `,
            )
          : drop.raw;
        return [
          Decoration.widget({
            widget: new TaskWidget(drop.id, raw),
            block: true,
            side,
          }).range(position),
        ];
      }),
      true,
    );
  }

  const field = StateField.define<{
    drops: PendingDrop[];
    decorations: DecorationSet;
  }>({
    create: () => ({ drops: [], decorations: Decoration.none }),
    update: (value, transaction: Transaction) => {
      const update = transaction.effects.find((effect) => effect.is(changed));
      if (!update && !transaction.docChanged) return value;
      const drops = update ? (update.value as PendingDrop[]) : value.drops;
      return {
        drops,
        decorations: decorations(drops, transaction.newDoc.toString()),
      };
    },
    provide: (field) =>
      EditorView.decorations.from(field, (value) => value.decorations),
  });
  plugin.registerEditorExtension(field);
  const publish = () => {
    const drops = get(feedback.state);
    plugin.app.workspace.iterateAllLeaves((leaf) => {
      if (!(leaf.view instanceof MarkdownView) || !leaf.view.file) return;
      const path = leaf.view.file.path;
      const editor = Reflect.get(leaf.view.editor, "cm") as
        | EditorView
        | undefined;
      if (!editor?.state.field(field, false)) return;
      editor.dispatch({
        effects: changed.of(
          drops.filter(
            (drop) =>
              "path" in drop.destination && drop.destination.path === path,
          ),
        ),
      });
    });
  };
  plugin.register(feedback.state.subscribe(publish));
  plugin.registerEvent(
    plugin.app.workspace.on("file-open", () => queueMicrotask(publish)),
  );
  plugin.registerEvent(
    plugin.app.workspace.on("active-leaf-change", () =>
      queueMicrotask(publish),
    ),
  );
}
