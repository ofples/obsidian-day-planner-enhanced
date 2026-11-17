import { afterEach, expect, test, vi } from "vitest";
import type { App } from "obsidian";

vi.mock("obsidian", () => ({
  Modal: class {
    modalEl = document.createElement("div");
    titleEl = document.createElement("h2");
    contentEl = document.createElement("div");
    constructor() {
      this.modalEl.append(this.titleEl, this.contentEl);
    }
    open() {
      document.body.append(this.modalEl);
      (this as unknown as { onOpen(): void }).onOpen();
    }
    close() {
      (this as unknown as { onClose(): void }).onClose();
      this.modalEl.remove();
    }
  },
}));

import {
  GoogleCalendarPicker,
  syncCalendarUnavailableReason,
} from "../src/google-calendar/calendar-picker";
import type { GoogleCalendarSync } from "../src/google-calendar/service";
import type { GoogleCalendarInfo } from "../src/google-calendar/types";
import { defaultSettingsForTests } from "../src/settings";

const calendars: GoogleCalendarInfo[] = [
  {
    id: "primary-id",
    summary: "Personal",
    accessRole: "owner",
    primary: true,
    selected: true,
  },
  {
    id: "schedule-id",
    summary: "Old name",
    summaryOverride: "Day Planner",
    accessRole: "writer",
    selected: true,
  },
  { id: "holidays", summary: "Holidays", accessRole: "reader" },
  {
    id: "deleted",
    summary: "Deleted calendar",
    accessRole: "owner",
    deleted: true,
  },
];

afterEach(() => document.body.replaceChildren());

function setup(mode: "sync" | "display" = "sync", boundCalendarId = "") {
  const settings = structuredClone(defaultSettingsForTests);
  const service = {
    calendars: vi.fn().mockResolvedValue(calendars),
    isConnected: vi.fn(() => true),
    boundCalendarId,
  };
  const update = vi.fn();
  const openConnections = vi.fn();
  const picker = new GoogleCalendarPicker({} as App, {
    mode,
    settings: () => settings,
    service: () => service as unknown as GoogleCalendarSync,
    update,
    openConnections,
  });
  const open = async () => {
    picker.open();
    await vi.waitFor(() =>
      expect(
        picker.contentEl.querySelector(".planner-calendar-list"),
      ).toBeTruthy(),
    );
  };
  const button = (text: string) =>
    Array.from(picker.contentEl.querySelectorAll("button")).find(
      (el) => el.textContent === text,
    )!;
  const input = (id: string) =>
    picker.contentEl.querySelector<HTMLInputElement>(`input[value="${id}"]`)!;
  return {
    settings,
    service,
    update,
    picker,
    open,
    button,
    input,
    openConnections,
  };
}

test("sync picker selects one writable calendar by name, with local search and explicit save", async () => {
  const t = setup();
  await t.open();
  expect(t.picker.contentEl.textContent).toContain("Day Planner");
  expect(t.input("holidays").disabled).toBe(true);
  expect(t.input("deleted")).toBeNull();
  expect(t.button("Use calendar").disabled).toBe(true);
  t.input("schedule-id").click();
  expect(t.update).not.toHaveBeenCalled();
  const search = t.picker.contentEl.querySelector<HTMLInputElement>(
    'input[type="search"]',
  )!;
  search.value = "personal";
  search.dispatchEvent(new Event("input"));
  expect(
    t.picker.contentEl.querySelectorAll(".planner-calendar-row"),
  ).toHaveLength(1);
  expect(t.service.calendars).toHaveBeenCalledTimes(1);
  t.button("Use calendar").click();
  expect(t.update).toHaveBeenCalledExactlyOnceWith({
    calendarId: "schedule-id",
  });
});

test("existing schedule links retain their destination and primary alias resolves", async () => {
  const t = setup("sync", "schedule-id");
  await t.open();
  expect(t.input("schedule-id").checked).toBe(true);
  expect(t.input("primary-id").disabled).toBe(true);
  t.button("Cancel").click();
  expect(t.update).not.toHaveBeenCalled();
  const primary = setup();
  primary.settings.googleCalendar.calendarId = "primary";
  await primary.open();
  expect(primary.input("primary-id").checked).toBe(true);
  primary.button("Use calendar").click();
  expect(primary.update).toHaveBeenCalledWith({ calendarId: "primary-id" });
});

test("display picker allows read-only calendars, drafts changes and follows Google selection", async () => {
  const t = setup("display");
  t.settings.googleCalendar.visibleCalendarIds = ["schedule-id"];
  await t.open();
  expect(t.input("holidays").disabled).toBe(false);
  t.input("holidays").click();
  expect(t.update).not.toHaveBeenCalled();
  t.button("Apply").click();
  expect(t.update).toHaveBeenCalledWith({
    visibleCalendarIds: ["schedule-id", "holidays"],
  });
  const follow = setup("display");
  await follow.open();
  expect(follow.input("schedule-id").disabled).toBe(true);
  follow.button("Apply").click();
  expect(follow.update).toHaveBeenCalledWith({ visibleCalendarIds: null });
});

test("closing during loading discards late results and failures require an explicit retry", async () => {
  const t = setup();
  let resolve!: (value: GoogleCalendarInfo[]) => void;
  t.service.calendars.mockReturnValue(
    new Promise<GoogleCalendarInfo[]>((done) => {
      resolve = done;
    }),
  );
  t.picker.open();
  t.picker.close();
  resolve(calendars);
  await Promise.resolve();
  expect(t.picker.contentEl.children).toHaveLength(0);
  expect(t.update).not.toHaveBeenCalled();
  const failed = setup();
  failed.service.calendars.mockRejectedValueOnce(
    new Error("Temporarily unavailable"),
  );
  failed.picker.open();
  await vi.waitFor(() =>
    expect(failed.picker.contentEl.textContent).toContain(
      "Temporarily unavailable",
    ),
  );
  expect(failed.service.calendars).toHaveBeenCalledTimes(1);
  failed.button("Retry").click();
  await vi.waitFor(() =>
    expect(
      failed.picker.contentEl.querySelector(".planner-calendar-list"),
    ).toBeTruthy(),
  );
  expect(failed.service.calendars).toHaveBeenCalledTimes(2);
});

test("disconnected picker opens the shared Connections screen and rejects stale apply", async () => {
  const t = setup();
  t.service.isConnected.mockReturnValue(false);
  t.picker.open();
  t.button("Open Connections").click();
  expect(t.openConnections).toHaveBeenCalledTimes(1);
  expect(t.service.calendars).not.toHaveBeenCalled();
  const stale = setup();
  await stale.open();
  stale.input("schedule-id").click();
  stale.service.isConnected.mockReturnValue(false);
  stale.button("Use calendar").click();
  expect(stale.update).not.toHaveBeenCalled();
});

test("sync destination eligibility matches writable roles and task-feed restrictions", () => {
  expect(syncCalendarUnavailableReason(calendars[1]!)).toBe("");
  expect(
    syncCalendarUnavailableReason(calendars[1]!, "", ["schedule-id"]),
  ).toContain("task calendar feed");
  expect(syncCalendarUnavailableReason(calendars[1]!, "primary-id")).toContain(
    "another calendar",
  );
  expect(
    syncCalendarUnavailableReason({
      ...calendars[1]!,
      accessRole: "writerWithoutPrivateAccess",
    }),
  ).toBe("Read-only");
});
