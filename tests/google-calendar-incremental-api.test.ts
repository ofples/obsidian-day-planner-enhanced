import { requestUrl } from "obsidian";
import { beforeEach, describe, expect, test, vi } from "vitest";
vi.mock("obsidian", () => ({ requestUrl: vi.fn(), moment: window.moment }));
vi.mock("../src/service/request-gate", async (original) => ({
  ...(await original<typeof import("../src/service/request-gate")>()),
  googleRequestGate: () => ({
    run: async (send: () => Promise<unknown>) => ({ response: await send() }),
  }),
}));
import { GoogleCalendarApi } from "../src/google-calendar/api";
import type { GoogleCalendarAuth } from "../src/google-calendar/auth";

const response = (status: number, json: unknown) => ({
  status,
  json,
  headers: {},
  text: "",
  arrayBuffer: new ArrayBuffer(0),
});
const min = "2026-11-14T00:00:00.000Z",
  max = "2026-12-01T00:00:00.000Z";
function setup() {
  return new GoogleCalendarApi(
    { token: async () => "secret" } as unknown as GoogleCalendarAuth,
    "client",
    "calendar",
    "namespace",
  );
}
function query(index: number) {
  return new URL(
    (vi.mocked(requestUrl).mock.calls[index]![0] as { url: string }).url,
  ).searchParams;
}
beforeEach(() => vi.clearAllMocks());

describe("incremental Google event reads", () => {
  test.each(["events", "calendars"])(
    "stops repeated %s pages in display refresh",
    async (kind) => {
      vi.mocked(requestUrl)
        .mockResolvedValueOnce(response(200, { nextPageToken: "same" }))
        .mockResolvedValueOnce(response(200, { nextPageToken: "same" }));
      const api = setup();
      await expect(
        kind === "events" ? api.list(min, max) : api.calendars(),
      ).rejects.toThrow("repeated");
      expect(requestUrl).toHaveBeenCalledTimes(2);
    },
  );
  test("collects every full page before exposing its final token", async () => {
    vi.mocked(requestUrl)
      .mockResolvedValueOnce(
        response(200, {
          items: [{ id: "one", etag: "1" }],
          nextPageToken: "page2",
        }),
      )
      .mockResolvedValueOnce(
        response(200, {
          items: [{ id: "two", etag: "2" }],
          nextSyncToken: "sync1",
        }),
      );
    expect(await setup().changes(min, max)).toEqual({
      events: [
        { id: "one", etag: "1" },
        { id: "two", etag: "2" },
      ],
      syncToken: "sync1",
    });
    expect(query(0).get("timeMin")).toBe(min);
    expect(query(0).get("timeMax")).toBe(max);
    expect(query(1).get("pageToken")).toBe("page2");
    expect(query(1).get("singleEvents")).toBe("true");
  });
  test("returns paginated changes and cancelled tombstones without date parameters", async () => {
    vi.mocked(requestUrl)
      .mockResolvedValueOnce(
        response(200, {
          items: [{ id: "gone", status: "cancelled" }],
          nextPageToken: "next",
        }),
      )
      .mockResolvedValueOnce(
        response(200, {
          items: [{ id: "updated", etag: "2" }],
          nextSyncToken: "sync2",
        }),
      );
    const result = await setup().changes(min, max, "sync1");
    expect(result.events).toEqual([
      { id: "gone", status: "cancelled" },
      { id: "updated", etag: "2" },
    ]);
    expect(result.syncToken).toBe("sync2");
    for (const index of [0, 1]) {
      expect(query(index).get("syncToken")).toBe("sync1");
      expect(query(index).has("timeMin")).toBe(false);
      expect(query(index).has("timeMax")).toBe(false);
      expect(query(index).get("showDeleted")).toBe("true");
    }
  });
  test("expired token restarts one bounded full read", async () => {
    vi.mocked(requestUrl)
      .mockResolvedValueOnce(response(410, {}))
      .mockResolvedValueOnce(
        response(200, { items: [{ id: "fresh" }], nextSyncToken: "new" }),
      );
    expect(await setup().changes(min, max, "expired")).toEqual({
      events: [{ id: "fresh" }],
      syncToken: "new",
      reset: true,
    });
    expect(query(0).get("syncToken")).toBe("expired");
    expect(query(1).get("timeMin")).toBe(min);
  });
  test("rejects repeated page tokens and incomplete final tokens", async () => {
    vi.mocked(requestUrl)
      .mockResolvedValueOnce(response(200, { nextPageToken: "same" }))
      .mockResolvedValueOnce(response(200, { nextPageToken: "same" }));
    await expect(setup().changes(min, max)).rejects.toThrow("repeated");
    vi.mocked(requestUrl).mockResolvedValueOnce(response(200, { items: [] }));
    await expect(setup().changes(min, max)).rejects.toThrow("sync token");
  });
});
