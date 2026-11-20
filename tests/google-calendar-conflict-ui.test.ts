import type { Plugin } from "obsidian";
import { get } from "svelte/store";
import { afterEach, beforeAll, expect, test, vi } from "vitest";

import {
  resolveCalendarConflict,
  resolveDeletedRemoteConflict,
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
  resolveDeletedRemoteConflict: vi.fn(async () => {}),
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

test("manual and automatic sync remain held until unresolved choices are handled", async () => {
  const h = setup();
  h.run.mockRestore();
  const reset = vi.spyOn(h.service, "resetForUserRetry");
  h.service.reviewConflicts();
  await h.service.run();
  expect(reset).not.toHaveBeenCalled();
  modals[0]!.close();
  await h.service.run(true);
  expect(reset).not.toHaveBeenCalled();
  await h.service.run();
  expect(modals).toHaveLength(2);
  expect(modals[1]!.contentEl.textContent).toContain("2 choices remaining");
  expect(reset).not.toHaveBeenCalled();
  expect(h.validate).not.toHaveBeenCalled();
});

test("review waits for an in-flight operation before rendering fresh choices", async () => {
  const h = setup();
  Reflect.set(h.service, "busy", true);
  h.service.reviewConflicts();
  const modal = modals[0]!;
  expect(modal.contentEl.textContent).toContain(
    "Finishing the current calendar operation",
  );
  expect(modal.contentEl.querySelector("button")).toBeNull();
  Reflect.set(h.service, "reviewable", []);
  Reflect.set(h.service, "busy", false);
  await vi.waitFor(() =>
    expect(modal.contentEl.textContent).toContain("No event choices remaining"),
  );
  expect(h.validate).not.toHaveBeenCalled();
});

test("closing a review cancels a choice waiting for the note writer", async () => {
  const h = setup();
  h.service.reviewConflicts();
  Reflect.set(h.service, "busy", true);
  Array.from(modals[0]!.contentEl.querySelectorAll("button"))
    .find((button) => button.textContent === "Use Obsidian")!
    .click();
  modals[0]!.close();
  Reflect.set(h.service, "busy", false);
  await vi.waitFor(() =>
    expect(Reflect.get(h.service, "reviewing")).toBe(false),
  );
  expect(resolveCalendarConflict).not.toHaveBeenCalled();
  expect(h.validate).not.toHaveBeenCalled();
});

test("the bulk confirmation keeps the review hold without a sync gap", () => {
  const h = setup();
  Reflect.set(h.service, "daily", {
    getAllDailyNotes: () => ({ day: { path: "Daily/2030-01-01.md" } }),
  });
  h.service.reviewConflicts();
  Array.from(modals[0]!.contentEl.querySelectorAll("button"))
    .find((button) => button.textContent === "Use this note for all changes…")!
    .click();
  expect(modals).toHaveLength(2);
  expect(Reflect.get(h.service, "reviewing")).toBe(true);
  Array.from(modals[1]!.contentEl.querySelectorAll("button"))
    .find((button) => button.textContent === "Force sync this note")!
    .click();
  expect(h.run).toHaveBeenCalledWith(false, "Daily/2030-01-01.md");
  expect(Reflect.get(h.service, "reviewing")).toBe(false);
});

test("closing during an active choice keeps sync held until that choice settles", async () => {
  const h = setup();
  let finish!: () => void;
  vi.mocked(resolveCalendarConflict).mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  h.service.reviewConflicts();
  Array.from(modals[0]!.contentEl.querySelectorAll("button"))
    .find((button) => button.textContent === "Use Obsidian")!
    .click();
  await vi.waitFor(() =>
    expect(resolveCalendarConflict).toHaveBeenCalledOnce(),
  );
  modals[0]!.close();
  expect(Reflect.get(h.service, "reviewing")).toBe(true);
  finish();
  await vi.waitFor(() =>
    expect(Reflect.get(h.service, "reviewing")).toBe(false),
  );
  expect(Reflect.get(h.service, "busy")).toBe(false);
});

test("saved conflicts show a refresh action instead of falsely claiming there are no choices", () => {
  const h = setup();
  const item = (Reflect.get(h.service, "reviewable") as CalendarConflict[])[0]!;
  Reflect.set(h.service, "reviewable", []);
  Reflect.set(h.service, "state", {
    records: {
      first: {
        path: item.local.path,
        base: item.base,
        pendingConflict: {
          mine: item.base,
          raw: "Saved draft",
          fields: ["subtasks"],
        },
      },
    },
  });
  h.service.reviewConflicts();
  expect(modals[0]!.contentEl.textContent).toContain("1 choice remaining");
  expect(modals[0]!.contentEl.textContent).toContain("Refresh conflicts once");
  expect(modals[0]!.contentEl.textContent).not.toContain(
    "No event choices remaining",
  );
});

test.each(["Restore Obsidian draft", "Accept Google deletion"])(
  "clears a renamed deletion's original summary after %s",
  async (label) => {
    const h = setup();
    const path = "Daily/2030-01-01.md";
    const base = {
      title: "Original title",
      start: "2030-01-01T09:00:00.000Z",
      end: "2030-01-01T10:00:00.000Z",
    };
    const record = { base, path, eventId: "deleted-event" };
    Reflect.set(h.service, "state", { records: { deleted: record } });
    Reflect.set(h.service, "reviewable", []);
    Reflect.set(h.service, "deletedRemote", [
      {
        uid: "deleted",
        path,
        eventId: "deleted-event",
        mine: { ...base, title: "Renamed draft" },
        raw: "Saved draft",
        currentRaw: "Saved draft",
        detectedAt: "2030-01-01T00:00:00.000Z",
      },
    ]);
    Reflect.set(h.service, "conflicts", [
      `${path}: Original title — Google deleted this event. The local draft is saved for review.`,
    ]);
    vi.mocked(resolveDeletedRemoteConflict).mockImplementation(async () => {
      if (label === "Restore Obsidian draft")
        record.base = { ...base, title: "Renamed draft" };
    });
    h.service.reviewConflicts();
    const modal = modals[0]!;
    Array.from(modal.contentEl.querySelectorAll("button"))
      .find((button) => button.textContent === label)!
      .click();
    await vi.waitFor(() =>
      expect(modal.contentEl.textContent).toContain(
        "No event choices remaining",
      ),
    );
    expect(get(h.service.conflictCount)).toBe(0);
    expect(modal.contentEl.textContent).not.toContain(
      "additional sync details",
    );
  },
);
