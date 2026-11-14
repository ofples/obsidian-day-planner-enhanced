import type { Plugin } from "obsidian";
import { get } from "svelte/store";

import type { AppStore } from "../redux/store";
import type { TransactionWriter } from "../service/diff-writer";
import { PeriodicNotes } from "../service/periodic-notes";
import type { DayPlannerSettings } from "../settings";

import type { TaskService } from "./service";
import { WeakTaskSync } from "./weak-sync";

export function createWeakTaskSync(
  plugin: Plugin,
  service: TaskService,
  store: AppStore,
  getSettings: () => DayPlannerSettings,
  edits?: Pick<TransactionWriter, "isWriting" | "revision">,
) {
  const { vault } = plugin.app;
  const daily = new PeriodicNotes();
  let ready = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let seeded = false;
  const sync = new WeakTaskSync({
    enabled: () => {
      const settings = getSettings();
      return (
        settings.weakTodoistSync !== false &&
        !settings.experimentalTodoistSync &&
        !edits?.isWriting &&
        ready &&
        get(service.state).connected &&
        Boolean(get(service.state).snapshot)
      );
    },
    candidates: () =>
      Object.values(store.getState().tracker.captureEntries)
        .flat()
        .filter((candidate) => {
          const cutoff = getSettings().googleCalendar.syncStartDate;
          if (!cutoff) return true;
          const file = vault.getFileByPath(candidate.path);
          if (!file) return false;
          const day = daily.getDateFromFile(file, "day");
          return !day || (day.isValid() && day.format("YYYY-MM-DD") >= cutoff);
        }),
    tasks: () => {
      const state = get(service.state);
      return [...(state.snapshot?.tasks ?? []), ...state.completed];
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
    getTask: (id) => service.getWeak(id),
    change: (task, change) => service.changeWeak(task, change),
  });
  const scan = () => {
    if (!stopped) void sync.scan();
  };
  const schedule = () => {
    if (stopped) return;
    ready ||= vault
      .getMarkdownFiles()
      .every((file) =>
        Object.hasOwn(store.getState().tracker.captureEntries, file.path),
      );
    const state = get(service.state);
    if (!ready || !state.connected || !state.snapshot) return;
    if (timer) clearTimeout(timer);
    if (
      !seeded &&
      !edits?.isWriting &&
      getSettings().weakTodoistSync !== false &&
      !getSettings().experimentalTodoistSync
    ) {
      seeded = true;
      scan();
    } else timer = setTimeout(scan, 5000);
  };
  let entries = store.getState().tracker.captureEntries;
  let config = JSON.stringify([
    getSettings().weakTodoistSync,
    getSettings().experimentalTodoistSync,
    getSettings().googleCalendar.syncStartDate,
  ]);
  const unsubscribeStore = store.subscribe(() => {
    const next = store.getState().tracker.captureEntries;
    const nextConfig = JSON.stringify([
      getSettings().weakTodoistSync,
      getSettings().experimentalTodoistSync,
      getSettings().googleCalendar.syncStartDate,
    ]);
    if (entries === next && config === nextConfig) return;
    entries = next;
    config = nextConfig;
    schedule();
  });
  let snapshot = get(service.state).snapshot;
  let connected = get(service.state).connected;
  const unsubscribeService = service.state.subscribe((state) => {
    if (snapshot === state.snapshot && connected === state.connected) return;
    snapshot = state.snapshot;
    connected = state.connected;
    schedule();
  });
  const stop = () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    unsubscribeStore();
    unsubscribeService();
    sync.stop();
  };
  plugin.register(stop);
  schedule();
  return { scan, stop };
}
