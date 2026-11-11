import type { Plugin } from "obsidian";
import { writable } from "svelte/store";
import { afterEach, expect, test, vi } from "vitest";

import { makeStore } from "../src/redux/store";
import { defaultSettingsForTests } from "../src/settings";
import type { CaptureCandidate } from "../src/tasks/capture-parser";
import { parseCaptureCandidates } from "../src/tasks/capture-parser";
import { createTaskCapture } from "../src/tasks/capture-obsidian";
import type { TaskService } from "../src/tasks/service";

const captured = vi.hoisted(() => ({
  host: undefined as
    | undefined
    | {
        stableMissing(): boolean;
        stable(candidate: CaptureCandidate): boolean;
      },
}));
vi.mock("../src/tasks/capture", () => ({
  TaskCapture: class {
    constructor(_service: unknown, host: NonNullable<typeof captured.host>) {
      captured.host = host;
    }
    scan = vi.fn();
    stop = vi.fn();
  },
}));
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  captured.host = undefined;
});

test("deferred Markdown tabs do not prevent source stability checks for loaded editors", () => {
  vi.useFakeTimers();
  vi.stubGlobal("activeDocument", document);
  let focused = false;
  let cursorLine = 0;
  const deferred = {
    isDeferred: true,
    view: { containerEl: document.createElement("div") },
  };
  const loaded = {
    isDeferred: false,
    view: {
      containerEl: document.createElement("div"),
      file: { path: "Tasks.md" },
      editor: {
        hasFocus: () => focused,
        getCursor: () => ({ line: cursorLine, ch: 0 }),
      },
    },
  };
  const leaves = [deferred, loaded];
  const dispose: (() => void)[] = [];
  const plugin = {
    app: {
      workspace: {
        getLeavesOfType: () => leaves,
        iterateAllLeaves: (visit: (leaf: unknown) => void) =>
          leaves.forEach(visit),
        on: vi.fn(),
      },
      vault: { getMarkdownFiles: () => [] },
    },
    register: (callback: () => void) => dispose.push(callback),
    registerDomEvent: vi.fn(),
    registerEvent: vi.fn(),
    registerInterval: vi.fn(),
  } as unknown as Plugin;
  const service = {
    state: writable({ snapshot: null, writable: false }),
  } as unknown as TaskService;
  createTaskCapture(
    plugin,
    service,
    makeStore({}),
    writable(defaultSettingsForTests),
  );
  const candidate = parseCaptureCandidates(
    "Tasks.md",
    "- [ ] Task #todoist",
  )[0]!;
  expect(captured.host!.stableMissing()).toBe(true);
  expect(captured.host!.stable(candidate)).toBe(true);
  focused = true;
  expect(captured.host!.stableMissing()).toBe(false);
  expect(captured.host!.stable(candidate)).toBe(false);
  const parent = parseCaptureCandidates(
    "Tasks.md",
    "- [ ] Parent #todoist\n  - [ ] Child #todoist\n\n- [ ] Other",
  )[0]!;
  cursorLine = 1;
  expect(captured.host!.stable(parent)).toBe(false);
  cursorLine = 3;
  expect(captured.host!.stable(parent)).toBe(true);
  for (const cleanup of dispose) cleanup();
});
