import { describe, expect, test } from "vitest";

import {
  defaultSettings,
  mergeStoredSettings,
  timelineZoomLevelMax,
  timelineZoomLevelMin,
  timelineZoomLevelOptions,
} from "../src/settings";

describe("settings migration", () => {
  test("calendar quiet period defaults to 20 seconds and validates saved values", () => {
    expect(mergeStoredSettings(null).googleCalendar.autoSyncDelaySeconds).toBe(
      20,
    );
    for (const [value, expected] of [
      [30, 30],
      [2, 5],
      [999, 300],
    ] as const) {
      expect(
        mergeStoredSettings({ googleCalendar: { autoSyncDelaySeconds: value } })
          .googleCalendar.autoSyncDelaySeconds,
      ).toBe(expected);
    }
  });
  test("exports default to the existing vault folder and preserve a custom path", () => {
    expect(mergeStoredSettings(null).scheduleExportFolder).toBe(
      "Schedule Exports",
    );
    expect(
      mergeStoredSettings({ scheduleExportFolder: "Shares/Schedules" })
        .scheduleExportFolder,
    ).toBe("Shares/Schedules");
  });
  test("retains legacy custom Google apps and respects an explicit built-in choice", () => {
    const googleCalendar = { clientId: "custom.apps.googleusercontent.com" };
    expect(
      mergeStoredSettings({ googleCalendar }).googleCalendar.useCustomClient,
    ).toBe(true);
    expect(
      mergeStoredSettings({
        googleCalendar: { ...googleCalendar, useCustomClient: false },
      }).googleCalendar.useCustomClient,
    ).toBe(false);
    expect(mergeStoredSettings(null).googleCalendar.useCustomClient).toBe(
      false,
    );
  });
  test("defaults next-slot entry on and preserves an explicit disable", () => {
    expect(mergeStoredSettings(null).nextTaskSlotOnEnter).toBe(true);
    expect(
      mergeStoredSettings({ nextTaskSlotOnEnter: false }).nextTaskSlotOnEnter,
    ).toBe(false);
  });

  test("defaults calendar cutover to legacy mode and preserves an explicit start date", () => {
    expect(defaultSettings.googleCalendar.syncStartDate).toBe("");
    expect(mergeStoredSettings(null).googleCalendar.syncStartDate).toBe("");
    expect(
      mergeStoredSettings({ googleCalendar: { syncStartDate: "2030-01-15" } })
        .googleCalendar.syncStartDate,
    ).toBe("2030-01-15");
    expect(
      mergeStoredSettings({ googleCalendar: { calendarId: "existing" } })
        .googleCalendar.syncStartDate,
    ).toBe("");
  });
  test("defaults tagged capture and preserves account-scoped routing", () => {
    expect(mergeStoredSettings(null).taskCapture).toEqual({
      enabled: true,
      roots: [],
      accounts: {},
    });
    expect(
      mergeStoredSettings({
        taskCapture: {
          enabled: false,
          accounts: {
            account: {
              defaultProjectId: "work",
              projectMappings: { work: "work" },
              labelMappings: {},
            },
          },
        },
      }).taskCapture,
    ).toEqual({
      enabled: false,
      roots: [],
      accounts: {
        account: {
          defaultProjectId: "work",
          projectMappings: { work: "work" },
          labelMappings: {},
        },
      },
    });
  });
  test("preserves status filters and defaults existing installations to no hidden statuses", () => {
    expect(mergeStoredSettings(null).hiddenTaskStatuses).toEqual([]);
    expect(
      mergeStoredSettings({ showCompletedTasks: false }).hiddenTaskStatuses,
    ).toEqual([]);
    expect(
      mergeStoredSettings({ hiddenTaskStatuses: ["-", "?"] })
        .hiddenTaskStatuses,
    ).toEqual(["-", "?"]);
  });
  test("removes retired all-day and sidebar visibility settings", () => {
    const settings = mergeStoredSettings({
      showUncheduledTasks: false,
      showUnscheduledNestedTasks: true,
      showTimelineInSidebar: false,
      startHour: 9,
    });

    expect(settings).not.toHaveProperty("showUncheduledTasks");
    expect(settings).not.toHaveProperty("showUnscheduledNestedTasks");
    expect(settings).not.toHaveProperty("showTimelineInSidebar");
    expect(settings.startHour).toBe(9);
    expect(settings.timelineColumns).toEqual(defaultSettings.timelineColumns);
  });

  test("keeps Tasks metadata visible by default", () => {
    expect(defaultSettings.hideTasksMetadata).toBe(false);
    expect(mergeStoredSettings(null).hideTasksMetadata).toBe(false);
    expect(
      mergeStoredSettings({ hideTasksMetadata: true }).hideTasksMetadata,
    ).toBe(true);
  });

  test("keeps time ranges visible in single-line blocks by default", () => {
    expect(defaultSettings.hideTimeRangeInSingleLine).toBe(false);
    expect(mergeStoredSettings(null).hideTimeRangeInSingleLine).toBe(false);
    expect(
      mergeStoredSettings({ hideTimeRangeInSingleLine: true })
        .hideTimeRangeInSingleLine,
    ).toBe(true);
  });

  test("keeps timeline embeds hidden by default", () => {
    expect(defaultSettings.showEmbedsInTaskBlocks).toBe(false);
    expect(mergeStoredSettings(null).showEmbedsInTaskBlocks).toBe(false);
    expect(
      mergeStoredSettings({ showEmbedsInTaskBlocks: true })
        .showEmbedsInTaskBlocks,
    ).toBe(true);
  });
});

describe("timeline zoom settings", () => {
  test("supports the same 1-5 range on every settings surface", () => {
    expect(timelineZoomLevelMin).toBe(1);
    expect(timelineZoomLevelMax).toBe(5);
    expect(Object.keys(timelineZoomLevelOptions)).toEqual([
      "1",
      "2",
      "3",
      "4",
      "5",
    ]);
  });
});
