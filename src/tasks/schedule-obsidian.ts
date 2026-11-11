import { MarkdownView, type Plugin } from "obsidian";
import { get, type Writable } from "svelte/store";

import type { GoogleCalendarSync } from "../google-calendar/service";
import { locateSource } from "../service/source-identity";
import type { WorkspaceFacade } from "../service/workspace-facade";
import type { DayPlannerSettings } from "../settings";

import { TaskScheduler } from "./schedule";
import type { TaskService } from "./service";

export function createTaskScheduler(
  plugin: Plugin,
  service: TaskService,
  calendar: GoogleCalendarSync,
  settings: Writable<DayPlannerSettings>,
  workspaceFacade: WorkspaceFacade,
) {
  const { app } = plugin;
  const scheduler = new TaskScheduler(service, calendar, {
    read: async (path) => {
      const file = app.vault.getFileByPath(path);
      return file ? app.vault.read(file) : null;
    },
    flush: async (paths) => {
      for (const leaf of app.workspace.getLeavesOfType("markdown")) {
        const view = leaf.view as MarkdownView;
        if (view.file && paths.includes(view.file.path)) await view.save();
      }
    },
    settings: () => get(settings).taskCapture,
    reveal: async (source) => {
      const file = app.vault.getFileByPath(source.path);
      const text = file ? await app.vault.read(file) : null;
      const offset = text === null ? -1 : locateSource(text, source);
      if (text === null || offset < 0)
        throw new Error(
          "The linked note task moved. Refresh its source link before opening the schedule.",
        );
      const line = text.slice(0, offset).split("\n").length - 1;
      const point = { line, col: 0, offset };
      await workspaceFacade.revealLocation({
        path: source.path,
        position: { start: point, end: point },
      });
    },
  });
  let ready = false;
  app.workspace.onLayoutReady(() => {
    ready = true;
    void scheduler.resume();
  });
  let previous = get(service.state).snapshot;
  plugin.register(
    service.state.subscribe((state) => {
      scheduler.publish();
      if (ready && !state.loading && state.snapshot !== previous) {
        previous = state.snapshot;
        void scheduler.resume();
      }
    }),
  );
  plugin.registerInterval(
    window.setInterval(() => {
      if (ready) void scheduler.resume();
    }, 30_000),
  );
  const watched = new Set<Document>();
  const watch = (document: Document) => {
    if (watched.has(document)) return;
    watched.add(document);
    plugin.registerDomEvent(document, "keydown", (event) => {
      if (event.key === "Escape") scheduler.drag.cancel();
    });
  };
  watch(activeDocument);
  app.workspace.iterateAllLeaves((leaf) =>
    watch(leaf.view.containerEl.ownerDocument),
  );
  plugin.registerEvent(
    app.workspace.on("window-open", (_, window) => watch(window.document)),
  );
  plugin.register(() => scheduler.stop());
  return scheduler;
}
