import type { MarkdownView, Plugin } from "obsidian";
import { get, type Writable } from "svelte/store";

import type { AppStore } from "../redux/store";
import type { DayPlannerSettings } from "../settings";

import { TaskCapture } from "./capture";
import { taskAccountKey, taskAccountSettings } from "./capture-settings";
import type { TaskService } from "./service";

export function createTaskCapture(
  plugin: Plugin,
  service: TaskService,
  store: AppStore,
  settings: Writable<DayPlannerSettings>,
) {
  const { workspace, vault } = plugin.app;
  const composing = new Set<Document>();
  const watched = new Set<Document>();
  const watchDocument = (document: Document) => {
    if (watched.has(document)) return;
    watched.add(document);
    plugin.registerDomEvent(document, "compositionstart", () =>
      composing.add(document),
    );
    plugin.registerDomEvent(document, "compositionend", () => {
      composing.delete(document);
      void capture.scan();
    });
    plugin.registerDomEvent(
      document,
      "blur",
      () => {
        composing.delete(document);
      },
      true,
    );
  };
  watchDocument(activeDocument);
  workspace.iterateAllLeaves((leaf) =>
    watchDocument(leaf.view.containerEl.ownerDocument),
  );
  plugin.registerEvent(
    workspace.on("window-open", (_, window) => watchDocument(window.document)),
  );
  let initiallyIndexed = false;
  const capture = new TaskCapture(service, {
    candidates: () =>
      Object.values(store.getState().tracker.captureEntries).flat(),
    ready: () => {
      initiallyIndexed ||= vault
        .getMarkdownFiles()
        .every((file) =>
          Object.hasOwn(store.getState().tracker.captureEntries, file.path),
        );
      return initiallyIndexed;
    },
    read: async (path) => {
      const file = vault.getFileByPath(path);
      return file ? vault.read(file) : null;
    },
    paths: () => vault.getMarkdownFiles().map((file) => file.path),
    stableMissing: () =>
      composing.size === 0 &&
      !workspace
        .getLeavesOfType("markdown")
        .some(
          (leaf) =>
            !leaf.isDeferred && (leaf.view as MarkdownView).editor.hasFocus(),
        ),
    settings: () => get(settings).taskCapture,
    stable: (candidate) =>
      !workspace.getLeavesOfType("markdown").some((leaf) => {
        if (leaf.isDeferred) return false;
        const view = leaf.view as MarkdownView;
        if (view.file?.path !== candidate.path) return false;
        const line = view.editor.hasFocus() ? view.editor.getCursor().line : -1;
        return (
          composing.has(view.containerEl.ownerDocument) ||
          (line >= candidate.line &&
            line < candidate.line + candidate.raw.split(/\r?\n/).length)
        );
      }),
  });
  plugin.register(() => capture.stop());
  let lastSnapshot = get(service.state).snapshot;
  plugin.register(
    service.state.subscribe((state) => {
      if (!state.writable || !state.snapshot) return;
      const snapshot = state.snapshot;
      const config = get(settings).taskCapture;
      if (!config.accounts[taskAccountKey(snapshot)])
        settings.update((value) => ({
          ...value,
          taskCapture: {
            ...value.taskCapture,
            accounts: {
              ...value.taskCapture.accounts,
              [taskAccountKey(snapshot)]: taskAccountSettings(
                value.taskCapture,
                snapshot,
              ),
            },
          },
        }));
      if (snapshot !== lastSnapshot && !state.loading) {
        lastSnapshot = snapshot;
        void capture.scan();
      }
    }),
  );
  let previousCursor = "";
  plugin.registerInterval(
    window.setInterval(() => {
      const editor = workspace.activeEditor;
      const cursor = JSON.stringify([
        editor?.file?.path,
        editor?.editor?.getCursor().line,
        editor?.editor?.hasFocus(),
        composing.size,
      ]);
      if (cursor !== previousCursor) {
        previousCursor = cursor;
        void capture.scan();
      }
    }, 500),
  );
  return capture;
}
