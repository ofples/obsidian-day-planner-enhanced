import type { SerializedRemoteTimeBlock } from "../redux/ical/ical-slice";

import type { EventColors } from "./colors";
import type { GoogleCalendarSettings } from "./service";
import type {
  CalendarSyncState,
  GoogleCalendarInfo,
  GoogleEvent,
} from "./types";

export function visibleGoogleCalendars(
  calendars: GoogleCalendarInfo[],
  settings: GoogleCalendarSettings,
) {
  return calendars.filter((calendar) =>
    settings.visibleCalendarIds === null
      ? calendar.selected && !calendar.hidden
      : settings.visibleCalendarIds.includes(calendar.id),
  );
}

export function googleEventsToBlocks(
  events: GoogleEvent[],
  calendar: GoogleCalendarInfo,
  palette: EventColors,
  state: CalendarSyncState,
): Array<SerializedRemoteTimeBlock & { durationMinutes: number }> {
  const linked = new Set(
    Object.values(state.records).map((record) => record.eventId),
  );
  return events.flatMap((event) => {
    if (event.status === "cancelled") return [];
    if (
      calendar.id === state.calendarId &&
      (linked.has(event.id) ||
        event.extendedProperties?.private?.["dayPlannerVault"] ===
          state.namespace)
    )
      return [];
    const start = window.moment(event.start?.dateTime ?? event.start?.date);
    const end = window.moment(event.end?.dateTime ?? event.end?.date);
    if (
      !event.start ||
      !event.end ||
      !start.isValid() ||
      !end.isValid() ||
      !end.isAfter(start)
    )
      return [];
    const status = event.attendees?.find(
      (attendee) => attendee.self,
    )?.responseStatus;
    const rsvpStatus =
      status === "accepted"
        ? "ACCEPTED"
        : status === "tentative"
          ? "TENTATIVE"
          : status === "declined"
            ? "DECLINED"
            : "NEEDS-ACTION";
    return [
      {
        id: `google:${calendar.id}:${event.id}`,
        calendarSource: { kind: "google" as const, id: calendar.id },
        source: "ical" as const,
        calendar: {
          name: calendar.summary,
          url: "https://calendar.google.com/calendar/r",
          color:
            (event.colorId && palette[event.colorId]?.background) ||
            calendar.backgroundColor ||
            "#4285f4",
        },
        summary: event.summary || "(Untitled event)",
        description: event.description,
        location: event.location,
        startTime: start.toISOString(),
        durationMinutes: end.diff(start, "minutes", true),
        isAllDayEvent: Boolean(event.start.date),
        rsvpStatus,
      },
    ];
  });
}
