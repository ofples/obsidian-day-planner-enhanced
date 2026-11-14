import { requestUrl } from "obsidian";
import { z } from "zod";

import {
  googleRequestGate,
  RequestCooldownError,
  RequestPermanentError,
  RequestCancelledError,
  RequestTransientError,
} from "../service/request-gate";
import type { DayPlannerSettings } from "../settings";
import { stripTaskLink, taskLinkUrl } from "../tasks/weak-links";

import {
  googleQuotaError,
  GoogleTokenError,
  type GoogleCalendarAuth,
} from "./auth";
import { plannerEventColor, type EventColors } from "./colors";
import { isTodoistCalendarExport } from "./exporter";
import {
  renderSubtasks,
  withSubtasks,
  plainCalendarDescription,
  structuredStart,
} from "./subtasks";
import { canonicalSnapshotOf } from "./types";
import type {
  CalendarApi,
  CalendarSnapshot,
  GoogleEvent,
  GoogleCalendarInfo,
  LocalBlock,
} from "./types";

export class CalendarHttpError extends Error {
  constructor(
    readonly status: number,
    readonly retryAt?: number,
    readonly circuitOpen = false,
  ) {
    super(
      circuitOpen
        ? "Google Calendar sync is paused. Retry sync or reconnect when ready."
        : retryAt && (status === 429 || status === 403)
          ? "Google Calendar is rate limited. Wait for the retry deadline, then retry sync."
          : status === 412
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
    private readonly canStart: () => boolean = () => true,
    private readonly canonical = false,
  ) {}

  private async request<T>(
    path: string,
    method = "GET",
    body?: unknown,
    etag?: string,
  ): Promise<T> {
    let refresh = false;
    for (let attempt = 0; attempt < 2; attempt++) {
      const forceRefresh = refresh;
      refresh = false;
      let result;
      try {
        result = await googleRequestGate(this.auth).run(
          async () => {
            let token: string;
            try {
              token = await this.auth.token(this.clientId, forceRefresh);
            } catch (error) {
              if (error instanceof GoogleTokenError) {
                if (error.status === 429 || error.status >= 500 || error.quota)
                  throw new RequestTransientError(
                    error.status,
                    error.retryAfter,
                  );
                throw new RequestPermanentError(error, error.status);
              }
              if (
                error instanceof Error &&
                /Connect Google Calendar|SecretStorage/.test(error.message)
              )
                throw new RequestPermanentError(error);
              throw error;
            }
            if (!this.canStart()) throw new RequestCancelledError();
            return requestUrl({
              url: `https://www.googleapis.com/calendar/v3/${path}`,
              method,
              headers: {
                Authorization: `Bearer ${token}`,
                ...(etag ? { "If-Match": etag } : {}),
              },
              ...(body
                ? {
                    contentType: "application/json",
                    body: JSON.stringify(body),
                  }
                : {}),
              throw: false,
            });
          },
          (response) => {
            if (response.status !== 403) return false;
            try {
              return googleQuotaError(response.json);
            } catch {
              return false;
            }
          },
          this.canStart,
          `${method} ${path.split("?")[0]}`,
          (response) =>
            response.status === 403 || (response.status === 401 && attempt > 0),
        );
      } catch (error) {
        if (error instanceof RequestCooldownError)
          throw new CalendarHttpError(
            error.status ?? 503,
            error.retryAt,
            error.circuitOpen,
          );
        throw error;
      }
      const { response, retryAt } = result;
      if (response.status >= 200 && response.status < 300)
        return (response.status === 204 ? undefined : response.json) as T;
      if (response.status === 401 && attempt === 0) {
        refresh = true;
        continue;
      }
      throw new CalendarHttpError(response.status, retryAt);
    }
    throw new Error("Google Calendar retry limit reached.");
  }

  async validateCalendar() {
    const result = z
      .object({ accessRole: z.string(), id: z.string().min(1) })
      .safeParse(
        await this.request<unknown>(
          `users/me/calendarList/${encodeURIComponent(this.calendarId)}`,
        ),
      );
    if (!result.success)
      throw new Error(
        "Google Calendar returned an invalid calendar identity. Refresh before exporting tasks.",
      );
    const calendar = result.data;
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
      plannerEventColor(
        this.canonical && snapshot.tags?.length
          ? {
              ...snapshot,
              title: `${snapshot.title} ${snapshot.tags.map((tag) => `#${tag}`).join(" ")}`,
            }
          : snapshot,
        settings,
        colors,
      );
  }

  async calendars() {
    const calendars: GoogleCalendarInfo[] = [];
    const pages = new Set<string>();
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
      if (page && (pages.has(page) || pages.size >= 1000))
        throw new Error("Google repeated or exceeded calendar-list pages.");
      if (page) pages.add(page);
    } while (page);
    return calendars;
  }

  async eventColors() {
    return (await this.request<{ event: EventColors }>("colors")).event;
  }

  private eventsPath() {
    return `calendars/${encodeURIComponent(this.calendarId)}/events`;
  }

  /** Recurring masters and all pages keep the check independent of the visible date range. */
  async assertTaskExportAllowed() {
    const pageSchema = z.object({
      items: z
        .array(
          z.object({
            id: z.string().min(1),
            status: z.string().optional(),
            source: z
              .object({
                url: z.string().optional(),
                title: z.string().optional(),
              })
              .optional(),
          }),
        )
        .default([]),
      nextPageToken: z.string().min(1).optional(),
    });
    const pages = new Set<string>();
    let page: string | undefined;
    do {
      const query = new URLSearchParams({
        maxResults: "2500",
        singleEvents: "false",
        showDeleted: "false",
        fields: "items(id,status,source),nextPageToken",
      });
      if (page) query.set("pageToken", page);
      const parsed = pageSchema.safeParse(
        await this.request<unknown>(`${this.eventsPath()}?${query.toString()}`),
      );
      if (!parsed.success)
        throw new Error(
          "Google Calendar returned an incomplete exporter check. Retry before exporting tasks.",
        );
      if (parsed.data.items.some(isTodoistCalendarExport))
        throw new Error(
          "Todoist is already exporting into this managed calendar. Select a separate Day Planner calendar in Google Calendar settings, then retry this saved schedule.",
        );
      page = parsed.data.nextPageToken;
      if (page && pages.has(page))
        throw new Error(
          "Google Calendar repeated an exporter-check page. Retry before exporting tasks.",
        );
      if (page) pages.add(page);
    } while (page);
  }

  async list(timeMin: string, timeMax: string) {
    const events: GoogleEvent[] = [];
    const pages = new Set<string>();
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
      if (page && (pages.has(page) || pages.size >= 1000))
        throw new Error("Google repeated or exceeded calendar event pages.");
      if (page) pages.add(page);
    } while (page);
    return events;
  }

  /** Read all pages before returning a replacement sync token. */
  async changes(
    timeMin: string,
    timeMax: string,
    token?: string,
  ): Promise<{ events: GoogleEvent[]; syncToken: string; reset?: boolean }> {
    const read = async (syncToken?: string) => {
      const events: GoogleEvent[] = [];
      const pages = new Set<string>();
      let page: string | undefined;
      do {
        const params = new URLSearchParams({
          singleEvents: "true",
          showDeleted: "true",
          maxResults: "2500",
        });
        if (syncToken) params.set("syncToken", syncToken);
        else {
          params.set("timeMin", timeMin);
          params.set("timeMax", timeMax);
        }
        if (page) params.set("pageToken", page);
        const raw = await this.request<unknown>(
          `${this.eventsPath()}?${params.toString()}`,
        );
        const result = z
          .object({
            items: z
              .array(z.object({ id: z.string().min(1) }).passthrough())
              .default([]),
            nextPageToken: z.string().min(1).optional(),
            nextSyncToken: z.string().min(1).optional(),
          })
          .safeParse(raw);
        if (!result.success)
          throw new Error("Google returned an invalid calendar sync page.");
        events.push(...(result.data.items as unknown as GoogleEvent[]));
        page = result.data.nextPageToken;
        if (page && (pages.has(page) || pages.size >= 1000))
          throw new Error("Google repeated or exceeded calendar sync pages.");
        if (page) pages.add(page);
        else {
          if (!result.data.nextSyncToken)
            throw new Error("Google did not provide a calendar sync token.");
          return { events, syncToken: result.data.nextSyncToken };
        }
      } while (page);
      throw new Error("Google did not finish calendar synchronization.");
    };
    try {
      return await read(token);
    } catch (error) {
      if (token && error instanceof CalendarHttpError && error.status === 410)
        return { ...(await read()), reset: true };
      throw error;
    }
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
      summary: stripTaskLink(snapshot.title),
      start: { dateTime: snapshot.start },
      end: { dateTime: snapshot.end },
      ...(this.colorForSnapshot
        ? { colorId: this.colorForSnapshot(snapshot) }
        : {}),
    };
  }

  private structuredTags(snapshot: CalendarSnapshot) {
    const tags = snapshot.tags ?? [];
    if (tags.some((tag) => !/^[\p{L}\p{M}\p{N}_/-]+$/u.test(tag)))
      throw new Error("A Day Planner tag is invalid.");
    const encoded = JSON.stringify(tags);
    if (new TextEncoder().encode(encoded).length > 1024)
      throw new Error(
        "Day Planner tags exceed the Google Calendar metadata limit.",
      );
    return encoded;
  }

  async create(
    id: string,
    uid: string,
    snapshot: CalendarSnapshot,
    block?: LocalBlock,
  ) {
    const subtasks = block ? renderSubtasks(block.raw) : "";
    if (this.canonical) {
      const tags = this.structuredTags(snapshot);
      try {
        return await this.request<GoogleEvent>(this.eventsPath(), "POST", {
          id,
          ...this.body(snapshot),
          ...(snapshot.colorId !== undefined
            ? { colorId: snapshot.colorId }
            : {}),
          description: plainCalendarDescription(
            snapshot.description ?? "",
            snapshot.subtasks ?? "",
            snapshot.taskUrl,
          ),
          extendedProperties: {
            private: {
              dayPlannerVault: this.namespace,
              dayPlannerBlock: uid,
              dayPlannerSchemaVersion: "4",
              dayPlannerTags: tags,
            },
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
    try {
      return await this.request<GoogleEvent>(this.eventsPath(), "POST", {
        id,
        ...this.body(snapshot),
        ...(subtasks ? { description: withSubtasks("", subtasks) } : {}),
        extendedProperties: {
          private: {
            dayPlannerVault: this.namespace,
            dayPlannerBlock: uid,
            ...(subtasks ? { dayPlannerSubtasks: "1" } : {}),
          },
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
    if (this.canonical) {
      const current = canonicalSnapshotOf(event);
      if (!current)
        throw new Error(
          "Google event cannot be represented as a timed planner block.",
        );
      const body: Record<string, unknown> = {};
      if (snapshot.title !== current.title || taskLinkUrl(event.summary ?? ""))
        body.summary = stripTaskLink(snapshot.title);
      if (Date.parse(snapshot.start) !== Date.parse(current.start))
        body.start = { dateTime: snapshot.start };
      if (Date.parse(snapshot.end) !== Date.parse(current.end))
        body.end = { dateTime: snapshot.end };
      if (
        snapshot.colorId !== undefined &&
        snapshot.colorId !== current.colorId
      )
        body.colorId = snapshot.colorId;
      const tags = snapshot.tags ?? current.tags ?? [];
      const subtasks = snapshot.subtasks ?? current.subtasks ?? "";
      const description = snapshot.description ?? current.description ?? "";
      const taskUrl =
        snapshot.taskUrl === undefined ? current.taskUrl : snapshot.taskUrl;
      const desiredDescription = plainCalendarDescription(
        description,
        subtasks,
        taskUrl,
      );
      if (
        subtasks !== current.subtasks ||
        description !== current.description ||
        taskUrl !== current.taskUrl ||
        Boolean(taskUrl && !(event.description ?? "").includes(taskUrl)) ||
        (event.description ?? "").includes(structuredStart)
      )
        body.description = desiredDescription;
      const encoded = this.structuredTags({ ...snapshot, tags });
      if (
        event.extendedProperties?.private?.["dayPlannerTags"] !== encoded ||
        event.extendedProperties.private["dayPlannerSchemaVersion"] !== "4"
      )
        body.extendedProperties = {
          private: {
            ...event.extendedProperties?.private,
            dayPlannerTags: encoded,
            dayPlannerSchemaVersion: "4",
          },
        };
      if (!Object.keys(body).length) return event;
      return this.request<GoogleEvent>(
        `${this.eventsPath()}/${encodeURIComponent(event.id)}?sendUpdates=none`,
        "PATCH",
        body,
        event.etag,
      );
    }
    // PATCH just the mirrored fields; preserve guests, Meet links, location, reminders, description, recurrence, and private properties.
    return this.request<GoogleEvent>(
      `${this.eventsPath()}/${encodeURIComponent(event.id)}?sendUpdates=none`,
      "PATCH",
      this.body(snapshot),
      event.etag,
    );
  }

  async link(event: GoogleEvent, uid: string, snapshot: CalendarSnapshot) {
    const owner = event.extendedProperties?.private?.["dayPlannerVault"];
    const existingUid = event.extendedProperties?.private?.["dayPlannerBlock"];
    if (
      (owner && owner !== this.namespace) ||
      (existingUid && existingUid !== uid)
    )
      throw new Error(
        "This Google event is already linked to another planner block.",
      );
    if (!event.etag)
      throw new Error("Google event has no version; refusing to link it.");
    return this.request<GoogleEvent>(
      `${this.eventsPath()}/${encodeURIComponent(event.id)}?sendUpdates=none`,
      "PATCH",
      {
        extendedProperties: {
          private: {
            ...event.extendedProperties?.private,
            dayPlannerVault: this.namespace,
            dayPlannerBlock: uid,
            dayPlannerSchemaVersion: "4",
            dayPlannerTags: this.structuredTags(snapshot),
          },
        },
      },
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

  async syncSubtasks(event: GoogleEvent, block: LocalBlock) {
    const subtasks = renderSubtasks(block.raw);
    const description = withSubtasks(
      event.description ?? "",
      subtasks,
      event.extendedProperties?.private?.["dayPlannerSubtasks"] === "1",
    );
    if (description === (event.description ?? "")) return event;
    if (!event.etag)
      throw new Error(
        "Google event has no version; refusing to update its subtasks.",
      );
    return this.request<GoogleEvent>(
      `${this.eventsPath()}/${encodeURIComponent(event.id)}?sendUpdates=none`,
      "PATCH",
      {
        description,
        extendedProperties: {
          private: {
            ...event.extendedProperties?.private,
            dayPlannerSubtasks: subtasks ? "1" : null,
          },
        },
      },
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
