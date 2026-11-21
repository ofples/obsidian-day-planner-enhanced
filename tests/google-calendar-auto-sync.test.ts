import type { Plugin } from "obsidian";
import { afterEach, expect, test, vi } from "vitest";

import { GoogleCalendarSync } from "../src/google-calendar/service";
import type { AppStore } from "../src/redux/store";
import type { PeriodicNotes } from "../src/service/periodic-notes";
import { defaultSettingsForTests } from "../src/settings";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function harness(delaySeconds = 20) {
  vi.useFakeTimers();
  vi.stubGlobal("activeDocument", document);
  const handlers = new Map<string, (...args: unknown[]) => void>();
  const cleanup: Array<() => void> = [];
  const state = JSON.stringify({
    version: 2,
    namespace: "a".repeat(32),
    calendarId: "",
    records: {},
    identities: {},
  });
  const plugin = {
    manifest: { id: "planner", dir: "plugin" },
    app: {
      workspace: {
        iterateAllLeaves: () => {},
        on: (name: string, callback: (...args: unknown[]) => void) => {
          handlers.set(name, callback);
          return {};
        },
      },
      vault: {
        adapter: { exists: async () => true, read: async () => state },
        read: async () => "Calendar-owned text",
        on: (name: string, callback: () => void) => {
          handlers.set(name, callback);
          return {};
        },
      },
    },
    addCommand: vi.fn(),
    registerEvent: vi.fn(),
    registerInterval: (id: number) =>
      cleanup.push(() => window.clearInterval(id)),
    register: (callback: () => void) => cleanup.push(callback),
  } as unknown as Plugin;
  const edits = { isWriting: false, revision: 0 };
  const service = new GoogleCalendarSync(
    plugin,
    {
      getDateFromFile: (file: { path: string }) =>
        file.path.startsWith("Daily/")
          ? window.moment().startOf("day")
          : undefined,
    } as unknown as PeriodicNotes,
    () => ({
      ...defaultSettingsForTests,
      googleCalendar: {
        ...defaultSettingsForTests.googleCalendar,
        autoSync: true,
        autoSyncDelaySeconds: delaySeconds,
      },
    }),
    { dispatch: vi.fn() } as unknown as AppStore,
    edits,
  );
  await service.initialize();
  const run = vi.spyOn(service, "run").mockResolvedValue();
  return { handlers, cleanup, service, edits, run };
}

test("automatic sync coalesces edits and waits for composition and active writes", async () => {
  const { handlers, cleanup, edits, run } = await harness();
  const popout = document.implementation.createHTMLDocument("popout");
  handlers.get("window-open")!(null, { document: popout });
  handlers.get("editor-change")!();
  await vi.advanceTimersByTimeAsync(19_000);
  handlers.get("editor-change")!();
  await vi.advanceTimersByTimeAsync(19_999);
  expect(run).not.toHaveBeenCalled();
  popout.dispatchEvent(new Event("compositionstart", { bubbles: true }));
  await vi.advanceTimersByTimeAsync(20_000);
  expect(run).not.toHaveBeenCalled();
  popout.dispatchEvent(new Event("blur", { bubbles: true }));
  edits.isWriting = true;
  await vi.advanceTimersByTimeAsync(20_000);
  expect(run).not.toHaveBeenCalled();
  edits.isWriting = false;
  await vi.advanceTimersByTimeAsync(1_000);
  expect(run).toHaveBeenCalledExactlyOnceWith(true);
  handlers.get("editor-change")!();
  cleanup.forEach((callback) => callback());
  await vi.advanceTimersByTimeAsync(6_000);
  expect(run).toHaveBeenCalledOnce();
});

test("the configured quiet period restarts on every relevant edit and ignores unrelated writes", async () => {
  const { handlers, cleanup, run } = await harness(30);
  try {
    const file = { path: "Daily/today.md" };
    handlers.get("modify")!(file);
    await vi.advanceTimersByTimeAsync(29_000);
    handlers.get("editor-change")!({ getValue: () => "New text" }, { file });
    await vi.advanceTimersByTimeAsync(29_000);
    handlers.get("modify")!({ path: ".obsidian/plugins/planner/state.json" });
    handlers.get("modify")!({ path: "Other/note.md" });
    await vi.advanceTimersByTimeAsync(999);
    expect(run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledExactlyOnceWith(true);
  } finally {
    cleanup.forEach((fn) => fn());
  }
});

test("the plugin's confirmed calendar writes do not start an echo sync", async () => {
  const { handlers, cleanup, service, run } = await harness();
  try {
    const file = { path: "Daily/today.md" };
    const internal = service as unknown as {
      managedWrites: Map<string, string>;
    };
    internal.managedWrites.set(file.path, "Calendar-owned text");
    handlers.get("modify")!(file);
    handlers.get("editor-change")!(
      { getValue: () => "Calendar-owned text" },
      { file },
    );
    await vi.advanceTimersByTimeAsync(25_000);
    expect(run).not.toHaveBeenCalled();
    handlers.get("editor-change")!(
      { getValue: () => "User edit after Calendar pull" },
      { file },
    );
    await vi.advanceTimersByTimeAsync(19_999);
    expect(run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledExactlyOnceWith(true);
  } finally {
    cleanup.forEach((fn) => fn());
  }
});
