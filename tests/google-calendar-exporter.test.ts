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

async function setup(calendarId = "") {
  let disk = JSON.stringify({
    version: 2,
    namespace: "a".repeat(32),
    calendarId,
    records: {},
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
