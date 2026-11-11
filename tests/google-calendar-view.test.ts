import { describe, expect, test } from "vitest";

import { plannerEventColor } from "../src/google-calendar/colors";
import {
  googleEventsToBlocks,
  visibleGoogleCalendars,
} from "../src/google-calendar/view";
import { defaultSettings, mergeStoredSettings } from "../src/settings";
import type {
  CalendarSyncState,
  GoogleEvent,
} from "../src/google-calendar/types";
import {
  googleTimeBlocksUpdated,
  remoteTimeBlocksUpdated,
  selectRemoteTimeBlocks,
} from "../src/redux/ical/ical-slice";
import { makeStore } from "../src/redux/store";

const snapshot = {
  title: "Work #work",
  start: "2026-11-11T04:30:00Z",
  end: "2026-11-11T05:30:00Z",
};
const calendar = {
  id: "primary",
  summary: "Main calendar",
  selected: true,
  backgroundColor: "#4285f4",
};
const event: GoogleEvent = {
  id: "remote",
  etag: "v1",
  summary: snapshot.title,
  start: { dateTime: snapshot.start },
  end: { dateTime: snapshot.end },
};
const state: CalendarSyncState = {
  version: 1,
  namespace: "abc",
  calendarId: "target",
  records: {},
};
const palette = {
  "1": { background: "#a4bdfc" },
  "3": { background: "#dbadff" },
  "8": { background: "#e1e1e1" },
};

describe("Google calendar display and color settings", () => {
  test("old settings gain display-only defaults", () => {
    const settings = mergeStoredSettings({
      googleCalendar: { clientId: "existing" },
    });
    expect(settings.googleCalendar).toMatchObject({
      clientId: "existing",
      showCalendarEvents: true,
      importEventsToNotes: false,
      visibleCalendarIds: null,
      colorMappings: {},
    });
  });
  test("follows Google selection or an explicit configurable selection", () => {
    const calendars = [
      calendar,
      { ...calendar, id: "hidden", hidden: true },
      { ...calendar, id: "off", selected: false },
    ];
    expect(
      visibleGoogleCalendars(calendars, defaultSettings.googleCalendar),
    ).toEqual([calendar]);
    expect(
      visibleGoogleCalendars(calendars, {
        ...defaultSettings.googleCalendar,
        visibleCalendarIds: ["off"],
      }),
    ).toEqual([calendars[2]]);
    expect(
      visibleGoogleCalendars(calendars, {
        ...defaultSettings.googleCalendar,
        visibleCalendarIds: [],
      }),
    ).toEqual([]);
  });
  test("displays timed and all-day events and excludes cancelled and linked copies", () => {
    const blocks = googleEventsToBlocks(
      [
        event,
        {
          ...event,
          id: "all-day",
          start: { date: "2026-11-11" },
          end: { date: "2026-11-13" },
        },
        { ...event, id: "cancelled", status: "cancelled" },
      ],
      calendar,
      palette,
      state,
    );
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject({
      source: "ical",
      summary: snapshot.title,
      durationMinutes: 60,
      isAllDayEvent: false,
    });
    expect(blocks[1]).toMatchObject({
      isAllDayEvent: true,
      durationMinutes: 2880,
    });
    expect(
      googleEventsToBlocks([event], { ...calendar, id: "target" }, palette, {
        ...state,
        records: {
          uid: { eventId: event.id, path: "daily.md", base: snapshot },
        },
      }),
    ).toEqual([]);
  });
  test("color matching follows the first override and supports explicit mappings", () => {
    const settings = {
      ...defaultSettings,
      colorOverrides: [
        { text: "#work", color: "#e1e1e1", darkModeColor: "#636363" },
        { text: "Work", color: "#dbadff", darkModeColor: "#66376d" },
      ],
    };
    expect(plannerEventColor(snapshot, settings, palette)).toBe("8");
    expect(
      plannerEventColor(
        snapshot,
        {
          ...settings,
          googleCalendar: {
            ...settings.googleCalendar,
            colorMappings: { "#work": "3" },
          },
        },
        palette,
      ),
    ).toBe("3");
    expect(
      plannerEventColor(
        snapshot,
        {
          ...settings,
          googleCalendar: {
            ...settings.googleCalendar,
            colorMappings: { "#work": "default" },
          },
        },
        palette,
      ),
    ).toBeNull();
  });
  test("Google and ICS updates retain each other's displayed events", () => {
    const store = makeStore({});
    const [block] = googleEventsToBlocks([event], calendar, palette, state);
    store.dispatch(googleTimeBlocksUpdated([block!]));
    store.dispatch(remoteTimeBlocksUpdated([{ ...block!, id: "ics-event" }]));
    expect(selectRemoteTimeBlocks(store.getState())).toHaveLength(2);
    store.dispatch(googleTimeBlocksUpdated([]));
    expect(
      selectRemoteTimeBlocks(store.getState()).map((item) => item.id),
    ).toEqual(["ics-event"]);
  });
});
