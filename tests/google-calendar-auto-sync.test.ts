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

test("automatic sync coalesces edits and waits for composition and active writes", async () => {
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
        on: (name: string, callback: () => void) => {
          handlers.set(name, callback);
          return {};
        },
      },
    },
    addCommand: vi.fn(),
    registerEvent: vi.fn(),
    registerInterval: vi.fn(),
    register: (callback: () => void) => cleanup.push(callback),
  } as unknown as Plugin;
  const edits = { isWriting: false, revision: 0 };
  const service = new GoogleCalendarSync(
    plugin,
    {} as PeriodicNotes,
    () => ({
      ...defaultSettingsForTests,
      googleCalendar: {
        ...defaultSettingsForTests.googleCalendar,
        autoSync: true,
      },
    }),
    { dispatch: vi.fn() } as unknown as AppStore,
    edits,
  );
  await service.initialize();
  const run = vi.spyOn(service, "run").mockResolvedValue();
  const popout = document.implementation.createHTMLDocument("popout");
  handlers.get("window-open")!(null, { document: popout });
  handlers.get("editor-change")!();
  await vi.advanceTimersByTimeAsync(4_000);
  handlers.get("editor-change")!();
  await vi.advanceTimersByTimeAsync(4_999);
  expect(run).not.toHaveBeenCalled();
  popout.dispatchEvent(new Event("compositionstart", { bubbles: true }));
  await vi.advanceTimersByTimeAsync(5_000);
  expect(run).not.toHaveBeenCalled();
  popout.dispatchEvent(new Event("blur", { bubbles: true }));
  edits.isWriting = true;
  await vi.advanceTimersByTimeAsync(5_000);
  expect(run).not.toHaveBeenCalled();
  edits.isWriting = false;
  await vi.advanceTimersByTimeAsync(5_000);
  expect(run).toHaveBeenCalledExactlyOnceWith(true);
  handlers.get("editor-change")!();
  cleanup.forEach((callback) => callback());
  await vi.advanceTimersByTimeAsync(6_000);
  expect(run).toHaveBeenCalledOnce();
});
