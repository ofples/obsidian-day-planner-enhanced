import { Notice, requestUrl, type Plugin } from "obsidian";
import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("obsidian", async () => ({
  requestUrl: vi.fn(),
  request: vi.fn(),
  Notice: vi.fn(),
  Modal: class {},
  TFile: class {},
  Platform: { isDesktopApp: true },
  moment: (await import("moment")).default,
}));

import { GoogleCalendarAuth } from "../src/google-calendar/auth";
import type {
  CalendarSyncState,
  GoogleEvent,
} from "../src/google-calendar/types";
import { GoogleCalendarSync } from "../src/google-calendar/service";
import { makeStore } from "../src/redux/store";
import type { PeriodicNotes } from "../src/service/periodic-notes";
import { defaultSettings } from "../src/settings";
import { taskAccountSettingsSchema } from "../src/tasks/capture-settings";

const disposers: (() => void)[] = [];
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});
const response = (json: unknown, status = 200) => ({
  status,
  json,
  headers: {},
  text: "",
  arrayBuffer: new ArrayBuffer(0),
});

async function setup(
  calendarId = "",
  records: CalendarSyncState["records"] = {},
) {
  let disk = JSON.stringify({
    version: 2,
    namespace: "a".repeat(32),
    calendarId,
    records,
    identities: {},
    documents: {},
  });
  const original = disk;
  const settings = structuredClone(defaultSettings);
  Object.assign(settings.googleCalendar, {
    clientId: "client",
    calendarId: "managed",
    autoSync: false,
    showCalendarEvents: false,
  });
  const write = vi.fn(async (_path: string, text: string) => {
    disk = text;
  });
  const readNotes = vi.fn(() => {
    throw new Error("Unexpected note access before exporter validation");
  });
  const plugin = {
    app: {
      vault: {
        adapter: { exists: async () => true, read: async () => disk, write },
        getMarkdownFiles: readNotes,
      },
    },
    manifest: {
      id: "day-planner-enhanced",
      dir: ".obsidian/plugins/day-planner-enhanced",
    },
    addCommand: vi.fn(),
    register: (dispose: () => void) => disposers.push(dispose),
    registerInterval: (id: number) =>
      disposers.push(() => window.clearInterval(id)),
  } as unknown as Plugin;
  vi.spyOn(GoogleCalendarAuth.prototype, "token").mockResolvedValue(
    "credential",
  );
  const service = new GoogleCalendarSync(
    plugin,
    {} as PeriodicNotes,
    () => settings,
    makeStore({}),
  );
  await service.initialize();
  return { service, write, readNotes, original, disk: () => disk, settings };
}

describe("managed calendar exporter ownership", () => {
  test("missing projections outside the note scan window report the saved schedule and settings", async () => {
    const h = await setup();
    h.settings.googleCalendar.daysPast = 2;
    h.settings.googleCalendar.daysAhead = 3;
    const run = vi.spyOn(h.service, "run").mockResolvedValue();
    const min = window.moment().startOf("day").subtract(2, "days");
    const max = window.moment().startOf("day").add(4, "days");
    const snapshot = (start: string, end: string) => ({
      title: "Task",
      start,
      end,
    });
    const message =
      /saved locally.*outside the Google Calendar sync window.*Days to sync in the past.*Days to sync ahead.*retry/i;
    await expect(
      h.service.syncProjection(
        "missing",
        snapshot(
          min.clone().subtract(1, "minute").toISOString(),
          min.clone().add(30, "minutes").toISOString(),
        ),
      ),
    ).rejects.toThrow(message);
    await expect(
      h.service.syncProjection(
        "missing",
        snapshot(max.format(), max.clone().add(1, "hour").format()),
      ),
    ).rejects.toThrow(message);
    // Eligibility uses the start instant, not whether an event's duration overlaps the window.
    for (const start of [min, max.clone().subtract(1, "minute")]) {
      await expect(
        h.service.syncProjection(
          "missing",
          snapshot(start.format(), start.clone().add(2, "hours").format()),
        ),
      ).rejects.toThrow(/Connect Google Calendar or resolve its sync conflict/);
    }
    expect(run).toHaveBeenCalledTimes(4);
  });

  test("an existing projection outside the window keeps its normal verification path", async () => {
    const uid = "c".repeat(32);
    const start = window.moment().startOf("day").add(90, "days");
    const snapshot = {
      title: "Task",
      start: start.toISOString(),
      end: start.clone().add(1, "hour").toISOString(),
    };
    const h = await setup("managed", {
      [uid]: { eventId: "event", path: "note", base: snapshot },
    });
    const run = vi.spyOn(h.service, "run").mockResolvedValue();
    await expect(h.service.syncProjection(uid, snapshot)).resolves.toBe(
      "event",
    );
    expect(run).toHaveBeenCalledOnce();
    await expect(
      h.service.syncProjection(uid, { ...snapshot, title: "Changed" }),
    ).rejects.toThrow(/Connect Google Calendar or resolve its sync conflict/);
  });

  test.each([false, true])(
    "projection removal verifies an owned time-only event with saved mapping %s",
    async (linked) => {
      const uid = "c".repeat(32),
        namespace = "a".repeat(32),
        snapshot = {
          title: "",
          start: "2026-11-12T08:00:00.000Z",
          end: "2026-11-12T08:30:00.000Z",
        },
        eventId = `dp${namespace}${uid}`,
        path = "Daily/2026-11-12.md";
      const h = await setup(
        "managed",
        linked ? { [uid]: { eventId, path, base: snapshot } } : {},
      );
      const event: GoogleEvent = {
        id: eventId,
        etag: '"fixture-version"',
        start: { dateTime: snapshot.start },
        end: { dateTime: snapshot.end },
        extendedProperties: {
          private: { dayPlannerVault: namespace, dayPlannerBlock: uid },
        },
      };
      vi.mocked(requestUrl).mockImplementation((arg) => {
        const request = typeof arg === "string" ? { url: arg } : arg;
        const result =
          request.method === "DELETE"
            ? response({}, 204)
            : response(
                request.url.includes("/calendarList/")
                  ? { id: "managed", accessRole: "owner" }
                  : event,
              );
        return Promise.resolve(result) as ReturnType<typeof requestUrl>;
      });
      await h.service.removeProjection(uid, snapshot, path);
      expect(
        vi
          .mocked(requestUrl)
          .mock.calls.filter(
            ([arg]) => typeof arg !== "string" && arg.method === "DELETE",
          ),
      ).toHaveLength(1);
      expect(JSON.parse(h.disk()).records[uid]).toEqual({
        eventId,
        path,
        base: snapshot,
        deleted: true,
      });
      expect(h.readNotes).not.toHaveBeenCalled();
    },
  );

  test.each(["block", "vault", "id"])(
    "orphan projection removal rejects a changed %s owner",
    async (field) => {
      const uid = "c".repeat(32),
        namespace = "a".repeat(32),
        snapshot = {
          title: "Owned task",
          start: "2026-11-12T08:00:00.000Z",
          end: "2026-11-12T08:30:00.000Z",
        };
      const h = await setup("managed");
      const event: GoogleEvent = {
        id: field === "id" ? "foreign" : `dp${namespace}${uid}`,
        etag: '"fixture-version"',
        summary: snapshot.title,
        start: { dateTime: snapshot.start },
        end: { dateTime: snapshot.end },
        extendedProperties: {
          private: {
            dayPlannerVault: field === "vault" ? "foreign" : namespace,
            dayPlannerBlock: field === "block" ? "foreign" : uid,
          },
        },
      };
      vi.mocked(requestUrl).mockImplementation(
        (arg) =>
          Promise.resolve(
            response(
              (typeof arg === "string" ? arg : arg.url).includes(
                "/calendarList/",
              )
                ? { id: "managed", accessRole: "owner" }
                : event,
            ),
          ) as ReturnType<typeof requestUrl>,
      );
      await expect(
        h.service.removeProjection(uid, snapshot, "Daily/2026-11-12.md"),
      ).rejects.toThrow("calendar ownership");
      expect(
        vi
          .mocked(requestUrl)
          .mock.calls.some(
            ([arg]) => typeof arg !== "string" && arg.method === "DELETE",
          ),
      ).toBe(false);
      expect(h.write).not.toHaveBeenCalled();
    },
  );

  test("normal sync rejects an existing native exporter before binding state or reading notes", async () => {
    const h = await setup();
    vi.mocked(requestUrl).mockImplementation(
      (arg) =>
        Promise.resolve(
          response(
            (typeof arg === "string" ? arg : arg.url).includes("/calendarList/")
              ? { id: "managed", accessRole: "owner" }
              : {
                  items: [
                    {
                      id: "native",
                      source: {
                        url: "https://app.todoist.com/app/task/remote",
                      },
                    },
                  ],
                },
          ),
        ) as ReturnType<typeof requestUrl>,
    );
    await h.service.run();
    expect(Notice).toHaveBeenCalledWith(
      expect.stringContaining("already exporting"),
      12000,
    );
    expect(h.disk()).toBe(h.original);
    expect(h.write).not.toHaveBeenCalled();
    expect(h.readNotes).not.toHaveBeenCalled();
    expect(vi.mocked(requestUrl).mock.calls).toHaveLength(2);
    expect(
      vi
        .mocked(requestUrl)
        .mock.calls.every(
          ([arg]) =>
            typeof arg === "string" || !arg.method || arg.method === "GET",
        ),
    ).toBe(true);
  });

  test("task-date preflight validates the original managed account before checking sources", async () => {
    const h = await setup("original");
    vi.mocked(requestUrl).mockResolvedValue(
      response({ id: "managed", accessRole: "owner" }),
    );
    await expect(h.service.assertTaskExportAllowed()).rejects.toThrow(
      "original target calendar",
    );
    expect(requestUrl).toHaveBeenCalledOnce();
    expect(h.write).not.toHaveBeenCalled();
  });

  test("an incomplete Google setup preserves ordinary task-date editing", async () => {
    const h = await setup();
    h.settings.googleCalendar.clientId = "";
    await h.service.assertTaskExportAllowed();
    expect(requestUrl).not.toHaveBeenCalled();
    expect(h.write).not.toHaveBeenCalled();
  });

  test("an explicitly selected task-feed calendar cannot become an exporter while empty or visible", async () => {
    const h = await setup();
    h.settings.taskCapture.accounts['["todoist","account"]'] =
      taskAccountSettingsSchema.parse({
        calendarDisplay: {
          enabled: false,
          googleCalendarIds: ["managed"],
          icalUrls: [],
        },
      });
    vi.mocked(requestUrl).mockResolvedValue(
      response({ id: "managed", accessRole: "owner" }),
    );
    await expect(h.service.assertTaskExportAllowed()).rejects.toThrow(
      "also selected as a task feed",
    );
    expect(requestUrl).toHaveBeenCalledOnce();
    expect(h.write).not.toHaveBeenCalled();
  });

  test("clearing the detected source permits a fresh preflight", async () => {
    const h = await setup("managed");
    vi.mocked(requestUrl)
      .mockResolvedValueOnce(response({ id: "managed", accessRole: "owner" }))
      .mockResolvedValueOnce(
        response({
          items: [
            {
              id: "native",
              source: { url: "https://app.todoist.com/app/task/remote" },
            },
          ],
        }),
      );
    await expect(h.service.assertTaskExportAllowed()).rejects.toThrow(
      "already exporting",
    );
    vi.mocked(requestUrl)
      .mockResolvedValueOnce(response({ id: "managed", accessRole: "owner" }))
      .mockResolvedValueOnce(response({ items: [] }));
    await expect(h.service.assertTaskExportAllowed()).resolves.toBeUndefined();
    expect(h.write).not.toHaveBeenCalled();
  });
});
