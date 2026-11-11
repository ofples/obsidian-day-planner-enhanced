import { describe, expect, test } from "vitest";

import { googleEventsToBlocks } from "../src/google-calendar/view";
import { makeStore } from "../src/redux/store";
import {
  googleTimeBlocksUpdated,
  remoteTimeBlocksUpdated,
  selectRemoteTimeBlocks,
  taskCalendarDisplayUpdated,
} from "../src/redux/ical/ical-slice";
import { taskCalendarDisplayPolicy } from "../src/tasks/calendar-display";
import {
  taskAccountKey,
  taskAccountSettings,
  taskCaptureSettingsSchema,
} from "../src/tasks/capture-settings";
import type { TaskSnapshot } from "../src/tasks/types";

const taskSnapshot: TaskSnapshot = {
  provider: "todoist",
  account: { id: "one", name: "Test", timezone: "UTC" },
  projects: [],
  tasks: [],
  fetchedAt: "2026-11-11T00:00:00Z",
};
const event = {
  id: "event",
  etag: "one",
  start: { dateTime: "2026-11-11T09:00:00Z" },
  end: { dateTime: "2026-11-11T10:00:00Z" },
  summary: "Task",
};
const calendarState = {
  version: 2 as const,
  namespace: "test",
  calendarId: "managed",
  records: {},
};
const googleBlock = (id: string) =>
  googleEventsToBlocks(
    [event],
    { id, summary: "Todoist", selected: true },
    {},
    calendarState,
  )[0]!;

describe("task calendar display ownership", () => {
  test("excludes exact selected Google IDs and ICS URLs through refreshes", () => {
    const store = makeStore({});
    const google = [
      googleBlock("todoist"),
      googleBlock("todoist:shared"),
      googleBlock("other"),
    ];
    const ical = [
      "https://example.test/tasks.ics",
      "https://example.test/tasks.ics?other=1",
    ].map((url, index) => ({
      ...google[0]!,
      id: `ics-${index}`,
      calendarSource: undefined,
      calendar: { name: "Todoist", url, color: "#123456" },
    }));
    store.dispatch(googleTimeBlocksUpdated(google));
    store.dispatch(remoteTimeBlocksUpdated(ical));
    expect(selectRemoteTimeBlocks(store.getState())).toHaveLength(5);
    store.dispatch(
      taskCalendarDisplayUpdated({
        googleCalendarIds: ["todoist"],
        icalUrls: ["https://example.test/tasks.ics"],
      }),
    );
    const expected = [
      "ics-1",
      "google:todoist:shared:event",
      "google:other:event",
    ];
    expect(
      selectRemoteTimeBlocks(store.getState()).map((block) => block.id),
    ).toEqual(expected);
    store.dispatch(googleTimeBlocksUpdated(google));
    store.dispatch(remoteTimeBlocksUpdated(ical));
    expect(
      selectRemoteTimeBlocks(store.getState()).map((block) => block.id),
    ).toEqual(expected);
    store.dispatch(
      taskCalendarDisplayUpdated({ googleCalendarIds: [], icalUrls: [] }),
    );
    expect(selectRemoteTimeBlocks(store.getState())).toHaveLength(5);
  });

  test("disconnect restores display and account replacement has its own policy", () => {
    const settings = taskCaptureSettingsSchema.parse({});
    const account = taskAccountSettings(settings, taskSnapshot);
    account.calendarDisplay = {
      enabled: true,
      googleCalendarIds: ["selected"],
      icalUrls: ["https://example.test/tasks.ics"],
    };
    settings.accounts[taskAccountKey(taskSnapshot)] = account;
    const before = structuredClone(settings);
    expect(
      taskCalendarDisplayPolicy(
        { connected: true, snapshot: taskSnapshot },
        settings,
      ),
    ).toEqual({
      googleCalendarIds: ["selected"],
      icalUrls: ["https://example.test/tasks.ics"],
    });
    expect(
      taskCalendarDisplayPolicy(
        { connected: false, snapshot: taskSnapshot },
        settings,
      ),
    ).toEqual({ googleCalendarIds: [], icalUrls: [] });
    expect(
      taskCalendarDisplayPolicy(
        {
          connected: true,
          snapshot: {
            ...taskSnapshot,
            account: { ...taskSnapshot.account, id: "two" },
          },
        },
        settings,
      ),
    ).toEqual({ googleCalendarIds: [], icalUrls: [] });
    expect(
      taskCalendarDisplayPolicy(
        { connected: true, snapshot: taskSnapshot },
        taskCaptureSettingsSchema.parse(JSON.parse(JSON.stringify(settings))),
      ),
    ).toEqual({
      googleCalendarIds: ["selected"],
      icalUrls: ["https://example.test/tasks.ics"],
    });
    expect(settings).toEqual(before);
  });

  test("old account settings and disabled policies display every feed", () => {
    const settings = taskCaptureSettingsSchema.parse({});
    const account = taskAccountSettings(settings, taskSnapshot);
    settings.accounts[taskAccountKey(taskSnapshot)] = account;
    expect(
      taskCalendarDisplayPolicy(
        { connected: true, snapshot: taskSnapshot },
        settings,
      ),
    ).toEqual({ googleCalendarIds: [], icalUrls: [] });
    account.calendarDisplay = {
      enabled: false,
      googleCalendarIds: ["saved"],
      icalUrls: [],
    };
    expect(
      taskCalendarDisplayPolicy(
        { connected: true, snapshot: taskSnapshot },
        settings,
      ),
    ).toEqual({ googleCalendarIds: [], icalUrls: [] });
  });
});
