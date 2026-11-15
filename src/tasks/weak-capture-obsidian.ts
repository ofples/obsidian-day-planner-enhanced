import type { MarkdownView, Plugin } from "obsidian";
import { get, type Writable } from "svelte/store";

import type { AppStore } from "../redux/store";
import type { TransactionWriter } from "../service/diff-writer";
import { PeriodicNotes } from "../service/periodic-notes";
import type { DayPlannerSettings } from "../settings";

import type { TaskService } from "./service";
import { WeakTaskCapture } from "./weak-capture";

export function createWeakTaskCapture(
  plugin: Plugin,
  service: TaskService,
  store: AppStore,
  settings: Writable<DayPlannerSettings>,
  edits?: Pick<TransactionWriter, "isWriting" | "revision">,
) {
  const { vault, workspace } = plugin.app;
  const filePath = `${plugin.manifest.dir ?? `${vault.configDir}/plugins/${plugin.manifest.id}`}/task-capture-outbox.json`;
  const daily = new PeriodicNotes();
  let indexed = false;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let reported = "";
  const capture = new WeakTaskCapture(service, {
    enabled: () => {
      const value = get(settings);
      indexed ||= vault
        .getMarkdownFiles()
        .every((file) =>
          Object.hasOwn(store.getState().tracker.captureEntries, file.path),
        );
      return (
        indexed &&
        !edits?.isWriting &&
        value.taskCapture.enabled &&
        !value.experimentalTodoistSync
      );
    },
    candidates: () =>
      Object.values(store.getState().tracker.captureEntries).flat(),
    inScope: (path) => {
      const cutoff = get(settings).googleCalendar.syncStartDate;
      if (!cutoff) return true;
      if (!window.moment(cutoff, "YYYY-MM-DD", true).isValid()) return false;
      const file = vault.getFileByPath(path);
      if (!file) return false;
      const day = daily.getDateFromFile(file, "day");
      return !day || (day.isValid() && day.format("YYYY-MM-DD") >= cutoff);
    },
    stable: (candidate) =>
      !workspace.getLeavesOfType("markdown").some((leaf) => {
        if (leaf.isDeferred) return false;
        const view = leaf.view as MarkdownView;
        if (view.file?.path !== candidate.path || !view.editor.hasFocus())
          return false;
        const line = view.editor.getCursor().line;
        return (
          line >= candidate.line &&
          line < candidate.line + candidate.raw.split(/\r?\n/).length
        );
      }),
    settings: () => get(settings).taskCapture,
    report: (message) => {
      if (message === reported) return;
      const previous = reported;
      reported = message;
      service.state.update((state) => {
        if (!message && state.error !== previous) return state;
        if (message && state.error && state.error !== previous) return state;
        return { ...state, error: message };
      });
    },
    read: async (path) => {
      const file = vault.getFileByPath(path);
      return file ? vault.read(file) : null;
    },
    write: async (path, before, after) => {
      const file = vault.getFileByPath(path);
      if (!file) return false;
      let written = false;
      await vault.process(file, (current) => {
        if (current !== before) return current;
        written = true;
        return after;
      });
      return written;
    },
    load: async () =>
      (await vault.adapter.exists(filePath))
        ? vault.adapter.read(filePath)
        : null,
    save: (content) => vault.adapter.write(filePath, content),
  });
  const scan = (manual = false) => capture.scan(manual);
  const schedule = () => {
    if (stopped) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void scan(), 5000);
  };
  let entries = store.getState().tracker.captureEntries;
  const unsubscribeStore = store.subscribe(() => {
    const next = store.getState().tracker.captureEntries;
    if (next !== entries) {
      entries = next;
      schedule();
    }
  });
  let snapshot = get(service.state).snapshot,
    connected = get(service.state).connected;
  const unsubscribeService = service.state.subscribe((state) => {
    if (state.snapshot !== snapshot || state.connected !== connected) {
      snapshot = state.snapshot;
      connected = state.connected;
      schedule();
    }
  });
  const unsubscribeSettings = settings.subscribe(schedule);
  let cursor = "";
  plugin.registerInterval(
    window.setInterval(() => {
      const editor = workspace.activeEditor;
      const current = JSON.stringify([
        editor?.file?.path,
        editor?.editor?.hasFocus(),
        editor?.editor?.getCursor().line,
      ]);
      if (current !== cursor) {
        cursor = current;
        schedule();
      }
    }, 1000),
  );
  const stop = () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    unsubscribeStore();
    unsubscribeService();
    unsubscribeSettings();
    capture.stop();
  };
  plugin.register(stop);
  schedule();
  return { scan, stop };
}
