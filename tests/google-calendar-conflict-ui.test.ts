import type { Plugin } from "obsidian";
import { get } from "svelte/store";
import { afterEach, beforeAll, expect, test, vi } from "vitest";

import {
  resolveCalendarConflict,
  type CalendarConflict,
} from "../src/google-calendar/engine";
import { GoogleCalendarSync } from "../src/google-calendar/service";
import type { AppStore } from "../src/redux/store";
import type { PeriodicNotes } from "../src/service/periodic-notes";
import { defaultSettingsForTests } from "../src/settings";

const modals = vi.hoisted(
  () =>
    [] as Array<{
      contentEl: HTMLDivElement;
      close: () => void;
    }>,
);

vi.mock("obsidian", async () => ({
  moment: (await import("moment")).default,
  Modal: class {
    contentEl = document.createElement("div");
    titleEl = document.createElement("h2");
    onClose = () => {};
    constructor() {
      modals.push(this);
    }
    open() {
      document.body.append(this.contentEl);
    }
    close() {
      this.contentEl.remove();
      this.onClose();
    }
  },
  Notice: vi.fn(),
  Platform: { isDesktopApp: true },
  TFile: class {},
}));
vi.mock("../src/google-calendar/engine", async (original) => ({
  ...(await original<typeof import("../src/google-calendar/engine")>()),
  resolveCalendarConflict: vi.fn(async () => {}),
}));

beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, "setText", {
    configurable: true,
    value(this: HTMLElement, text: string) {
      this.textContent = text;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "createEl", {
    configurable: true,
    value(this: HTMLElement, tag: string, options?: { text?: string }) {
      const child = document.createElement(tag);
      child.textContent = options?.text ?? "";
      this.append(child);
      return child;
    },
  });
});
afterEach(() => {
  modals.splice(0).forEach((modal) => modal.close());
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

function setup() {
  const service = new GoogleCalendarSync(
    {
      app: {
        workspace: { getActiveFile: () => ({ path: "Daily/2030-01-01.md" }) },
      },
    } as unknown as Plugin,
    {} as PeriodicNotes,
    () => defaultSettingsForTests,
    {} as AppStore,
  );
  const snapshot = {
    title: "First",
    start: "2030-01-01T09:00:00.000Z",
    end: "2030-01-01T10:00:00.000Z",
  };
  const item: CalendarConflict = {
    uid: "first",
    base: snapshot,
    local: {
      uid: "first",
      path: "Daily/2030-01-01.md",
      raw: "First",
      snapshot,
    },
    remote: { id: "event", etag: "version" },
    remoteSnapshot: snapshot,
  };
  Reflect.set(service, "state", { records: {} });
  Reflect.set(service, "reviewable", [
    item,
    { ...item, uid: "second", base: { ...snapshot, title: "Second" } },
  ]);
  Reflect.set(service, "conflicts", [
    `${item.local.path}: First — Competing edits`,
    `${item.local.path}: Second — Competing edits`,
    "One additional message",
    "One additional message",
  ]);
  const validate = vi.fn(async () => "calendar");
  Reflect.set(service, "validateManagedCalendar", validate);
  Reflect.set(
    service,
    "api",
    vi.fn(() => ({})),
  );
  Reflect.set(
    service,
    "noteContext",
    vi.fn(() => ({ notes: {} })),
  );
  const refresh = vi.spyOn(service, "refreshView").mockResolvedValue();
  const run = vi.spyOn(service, "run").mockResolvedValue();
  return { service, validate, refresh, run };
}

test("resolves successive choices in the same review and deduplicates extra messages", async () => {
  const h = setup();
  h.service.reviewConflicts();
  const modal = modals[0]!;
  expect(modal.contentEl.textContent).toContain("2 choices remaining");
  expect(
    modal.contentEl.textContent?.match(/One additional message/g),
  ).toHaveLength(1);
  const useNote = () =>
    Array.from(modal.contentEl.querySelectorAll("button")).find(
      (button) => button.textContent === "Use Obsidian",
    )!;
  useNote().click();
  await vi.waitFor(() =>
    expect(modal.contentEl.textContent).toContain("1 choice remaining"),
  );
  expect(modal.contentEl.isConnected).toBe(true);
  expect(get(h.service.conflictCount)).toBe(2);
  useNote().click();
  await vi.waitFor(() =>
    expect(modal.contentEl.textContent).toContain("No event choices remaining"),
  );
  expect(vi.mocked(resolveCalendarConflict)).toHaveBeenCalledTimes(2);
  expect(h.validate).toHaveBeenCalledOnce();
  expect(h.run).not.toHaveBeenCalled();
  expect(h.refresh).not.toHaveBeenCalled();
  expect(get(h.service.conflictCount)).toBe(1);
  modal.close();
  expect(h.refresh).toHaveBeenCalledOnce();
});

test("opening the review prevents automatic sync from replacing choices", async () => {
  const h = setup();
  h.run.mockRestore();
  h.service.reviewConflicts();
  const reset = vi.spyOn(h.service, "resetForUserRetry");
  await h.service.run(true);
  expect(reset).not.toHaveBeenCalled();
  expect(Reflect.get(h.service, "busy")).toBe(false);
  expect(modals[0]!.contentEl.textContent).toContain("2 choices remaining");
});
