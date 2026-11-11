import { requestUrl } from "obsidian";

import type { DayPlannerSettings } from "../settings";

import type { GoogleCalendarAuth } from "./auth";
import { plannerEventColor, type EventColors } from "./colors";
import type {
  CalendarApi,
  CalendarSnapshot,
  GoogleEvent,
  GoogleCalendarInfo,
} from "./types";

export class CalendarHttpError extends Error {
  constructor(readonly status: number) {
    super(
      status === 412
        ? "Google changed during sync; retry to compare both versions."
        : `Google Calendar request failed (${status}). No sync baseline was advanced.`,
    );
  }
}

export class GoogleCalendarApi implements CalendarApi {
  private colorForSnapshot?: (snapshot: CalendarSnapshot) => string | null;

  constructor(
    private readonly auth: GoogleCalendarAuth,
    private readonly clientId: string,
    private readonly calendarId: string,
    private readonly namespace: string,
  ) {}

  private async request<T>(
    path: string,
    method = "GET",
    body?: unknown,
    etag?: string,
  ): Promise<T> {
    let refresh = false;
    for (let attempt = 0; attempt < 4; attempt++) {
      const token = await this.auth.token(this.clientId, refresh);
      refresh = false;
      const response = await requestUrl({
        url: `https://www.googleapis.com/calendar/v3/${path}`,
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(etag ? { "If-Match": etag } : {}),
        },
        ...(body
          ? { contentType: "application/json", body: JSON.stringify(body) }
          : {}),
        throw: false,
      });
      if (response.status >= 200 && response.status < 300)
        return (response.status === 204 ? undefined : response.json) as T;
      if (response.status === 401 && attempt === 0) {
        refresh = true;
        continue;
      }
      if (
        (response.status === 429 || response.status >= 500) &&
        method !== "POST" &&
        attempt < 3
      ) {
        const retry = Number(response.headers["retry-after"]) * 1000;
        await new Promise((resolve) =>
          setTimeout(resolve, Math.min(10_000, retry || 500 * 2 ** attempt)),
        );
        continue;
      }
      throw new CalendarHttpError(response.status);
    }
    throw new Error("Google Calendar retry limit reached.");
  }

  async validateCalendar() {
    const calendar = await this.request<{ accessRole: string; id: string }>(
      `users/me/calendarList/${encodeURIComponent(this.calendarId)}`,
    );
    if (!["writer", "owner"].includes(calendar.accessRole))
      throw new Error("Choose a calendar you can edit.");
    return calendar.id;
  }

  async usePlannerColors(settings: DayPlannerSettings) {
    const palette = await this.request<{ event?: EventColors }>("colors");
    if (!palette.event || !Object.keys(palette.event).length)
      throw new Error("Google returned an empty event color palette.");
    const colors = palette.event;
    this.colorForSnapshot = (snapshot) =>
      plannerEventColor(snapshot, settings, colors);
  }

  async calendars() {
    const calendars: GoogleCalendarInfo[] = [];
    let page: string | undefined;
    do {
      const query = new URLSearchParams({ maxResults: "250" });
      if (page) query.set("pageToken", page);
      const response = await this.request<{
        items?: GoogleCalendarInfo[];
        nextPageToken?: string;
      }>(`users/me/calendarList?${query.toString()}`);
      calendars.push(...(response.items ?? []));
      page = response.nextPageToken;
    } while (page);
    return calendars;
  }

  async eventColors() {
    return (await this.request<{ event: EventColors }>("colors")).event;
  }

  private eventsPath() {
    return `calendars/${encodeURIComponent(this.calendarId)}/events`;
  }

  async list(timeMin: string, timeMax: string) {
    const events: GoogleEvent[] = [];
    let page: string | undefined;
    do {
      const params = new URLSearchParams({
        timeMin,
        timeMax,
        singleEvents: "true",
        showDeleted: "true",
        maxResults: "2500",
      });
      if (page) params.set("pageToken", page);
      const response = await this.request<{
        items?: GoogleEvent[];
        nextPageToken?: string;
      }>(`${this.eventsPath()}?${params.toString()}`);
      events.push(...(response.items ?? []));
      page = response.nextPageToken;
    } while (page);
    return events;
  }

  async get(id: string) {
    try {
      return await this.request<GoogleEvent>(
        `${this.eventsPath()}/${encodeURIComponent(id)}`,
      );
    } catch (error) {
      if (
        error instanceof CalendarHttpError &&
        (error.status === 404 || error.status === 410)
      )
        return null;
      throw error;
    }
  }

  private body(snapshot: CalendarSnapshot) {
    return {
      summary: snapshot.title,
      start: { dateTime: snapshot.start },
      end: { dateTime: snapshot.end },
      ...(this.colorForSnapshot
        ? { colorId: this.colorForSnapshot(snapshot) }
        : {}),
    };
  }

  async create(id: string, uid: string, snapshot: CalendarSnapshot) {
    try {
      return await this.request<GoogleEvent>(this.eventsPath(), "POST", {
        id,
        ...this.body(snapshot),
        extendedProperties: {
          private: { dayPlannerVault: this.namespace, dayPlannerBlock: uid },
        },
      });
    } catch (error) {
      if (error instanceof CalendarHttpError && error.status === 409) {
        const existing = await this.get(id);
        if (existing) return existing;
      }
      throw error;
    }
  }

  async update(event: GoogleEvent, snapshot: CalendarSnapshot) {
    if (!event.etag)
      throw new Error("Google event has no version; refusing to overwrite it.");
    // PATCH just the mirrored fields; preserve guests, Meet links, location, reminders, description, recurrence, and private properties.
    return this.request<GoogleEvent>(
      `${this.eventsPath()}/${encodeURIComponent(event.id)}?sendUpdates=none`,
      "PATCH",
      this.body(snapshot),
      event.etag,
    );
  }

  async syncColor(event: GoogleEvent, snapshot: CalendarSnapshot) {
    if (!this.colorForSnapshot) return event;
    const colorId = this.colorForSnapshot(snapshot);
    if ((event.colorId ?? null) === colorId) return event;
    if (!event.etag)
      throw new Error("Google event has no version; refusing to recolor it.");
    return this.request<GoogleEvent>(
      `${this.eventsPath()}/${encodeURIComponent(event.id)}?sendUpdates=none`,
      "PATCH",
      { colorId },
      event.etag,
    );
  }

  async remove(event: GoogleEvent) {
    if (!event.etag)
      throw new Error("Google event has no version; refusing to delete it.");
    await this.request<void>(
      `${this.eventsPath()}/${encodeURIComponent(event.id)}?sendUpdates=none`,
      "DELETE",
      undefined,
      event.etag,
    );
  }
}
