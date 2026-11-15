import { MarkdownView, type Plugin } from "obsidian";

import type { DayPlannerSettings } from "../settings";
import { planNextTaskSlot } from "../tasks/next-task-slot";

export function registerNextTaskSlot(
  plugin: Plugin,
  settings: () => DayPlannerSettings,
) {
  const watched = new Set<Document>();
  function keydown(event: KeyboardEvent) {
    if (
      event.key !== "Enter" ||
      event.defaultPrevented ||
      event.shiftKey ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.isComposing ||
      event.repeat
    )
      return;
    const target = event.target as HTMLElement | null;
    if (!target?.closest(".cm-content")) return;
    let view: MarkdownView | undefined;
    plugin.app.workspace.iterateAllLeaves((leaf) => {
      if (
        leaf.view instanceof MarkdownView &&
        leaf.view.containerEl.contains(target)
      )
        view = leaf.view;
    });
    if (
      !view ||
      view.getMode() !== "source" ||
      view.editor.getSelection() ||
      view.editor.listSelections().length !== 1
    )
      return;
    const editor = view.editor;
    const plan = planNextTaskSlot(
      editor.getValue(),
      editor.getCursor().line,
      settings(),
    );
    if (!plan) return;
    event.preventDefault();
    event.stopPropagation();
    editor.replaceRange(plan.insertion, editor.offsetToPos(plan.at));
    const from = editor.offsetToPos(plan.from),
      to = editor.offsetToPos(plan.to);
    editor.setSelection(from, to);
    editor.scrollIntoView({ from, to });
  }
  function watch(doc: Document) {
    if (watched.has(doc)) return;
    watched.add(doc);
    plugin.registerDomEvent(doc, "keydown", keydown, true);
  }
  watch(activeDocument);
  plugin.app.workspace.iterateAllLeaves((leaf) =>
    watch(leaf.view.containerEl.ownerDocument),
  );
  plugin.registerEvent(
    plugin.app.workspace.on("window-open", (_workspace, win) =>
      watch(win.document),
    ),
  );
}
