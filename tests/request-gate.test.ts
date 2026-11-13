import { requestUrl } from "obsidian";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { GoogleCalendarApi } from "../src/google-calendar/api";
import {
  googleTokenRequest,
  GoogleTokenError,
} from "../src/google-calendar/auth";
import {
  RequestCooldownError,
  RequestGate,
  googleRequestGate,
  todoistRequestGate,
  retryAfterAt,
} from "../src/service/request-gate";
import { TodoistProvider } from "../src/tasks/todoist";

vi.mock("obsidian", async () => ({
  requestUrl: vi.fn(),
  moment: (await import("moment")).default,
}));
const response = (
  status: number,
  headers: Record<string, string> = {},
  json: unknown = {},
) =>
  ({
    status,
    headers,
    json,
    text: "",
    arrayBuffer: new ArrayBuffer(0),
  }) as Awaited<ReturnType<typeof requestUrl>>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  vi.mocked(requestUrl).mockReset();
});
afterEach(() => vi.useRealTimers());

describe("provider request gate", () => {
  test("serializes concurrent calls and spaces their starts", async () => {
    const gate = new RequestGate(1000),
      starts: number[] = [];
    const send = vi.fn(async () => {
      starts.push(Date.now());
      return response(200);
    });
    const all = Promise.all([gate.run(send), gate.run(send), gate.run(send)]);
    await vi.advanceTimersByTimeAsync(0);
    expect(send).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(send).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1001);
    await all;
    expect(starts.map((n) => n - starts[0]!)).toEqual([0, 1000, 2000]);
  });

  test("a stalled transport cannot create an unbounded request queue", async () => {
    const gate = new RequestGate(0);
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const send = vi.fn(async () => {
      await pending;
      return response(200);
    });
    const admitted = Array.from({ length: 64 }, () => gate.run(send));
    await expect(gate.run(send)).rejects.toBeInstanceOf(RequestCooldownError);
    expect(send).toHaveBeenCalledTimes(1);
    release();
    await Promise.all(admitted);
    expect(send).toHaveBeenCalledTimes(64);
  });

  test("429 honors the entire server deadline and blocks already queued work", async () => {
    const gate = new RequestGate(0),
      send = vi
        .fn()
        .mockResolvedValueOnce(response(429, { "Retry-After": "120" }))
        .mockResolvedValue(response(200));
    const first = gate.run(send),
      second = gate.run(send).catch((e: unknown) => e);
    expect((await first).retryAt).toBe(Date.now() + 120_000);
    expect(await second).toBeInstanceOf(RequestCooldownError);
    expect(send).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(119_999);
    await expect(gate.run(send)).rejects.toBeInstanceOf(RequestCooldownError);
    await vi.advanceTimersByTimeAsync(1);
    await gate.run(send);
    expect(send).toHaveBeenCalledTimes(2);
  });

  test("parses numeric and HTTP-date deadlines and rejects invalid headers", () => {
    const now = Date.now();
    expect(retryAfterAt("120", now)).toBe(now + 120_000);
    expect(retryAfterAt("Thu, 01 Jan 2026 00:03:00 GMT", now)).toBe(
      now + 180_000,
    );
    expect(retryAfterAt("nonsense", now)).toBeUndefined();
    expect(retryAfterAt("-1", now)).toBeUndefined();
    expect(retryAfterAt("9".repeat(309), now)).toBeUndefined();
  });

  test("network, server and malformed rate failures back off exponentially and open a manual circuit", async () => {
    const gate = new RequestGate(0);
    for (let i = 0; i < 5; i++) {
      const result = await gate.run(async () =>
        response(i === 1 ? 503 : 429, { "retry-after": "invalid" }),
      );
      expect(result.retryAt).toBe(Date.now() + 1000 * 2 ** i);
      expect(gate.resetForUserRetry()).toBe(false);
      await vi.advanceTimersByTimeAsync(1000 * 2 ** i);
    }
    await expect(gate.run(async () => response(200))).rejects.toMatchObject({
      circuitOpen: true,
    });
    expect(gate.resetForUserRetry()).toBe(true);
    await gate.run(async () => response(200));
    await expect(
      gate.run(async () => {
        throw Error("network");
      }),
    ).rejects.toMatchObject({ retryAt: Date.now() + 1000 });
    await expect(gate.run(async () => response(200))).rejects.toBeInstanceOf(
      RequestCooldownError,
    );
  });

  test("healthy endpoints do not reset another endpoint's failure circuit", async () => {
    const gate = new RequestGate(0);
    const user = vi.fn(async () => response(200));
    const projects = vi.fn(async () => response(503));
    for (let i = 0; i < 5; i++) {
      await gate.run(user, undefined, undefined, "GET user");
      const failure = await gate.run(
        projects,
        undefined,
        undefined,
        "GET projects",
      );
      expect(failure.retryAt).toBe(Date.now() + 1000 * 2 ** i);
      await vi.advanceTimersByTimeAsync(1000 * 2 ** i);
    }
    await expect(
      gate.run(user, undefined, undefined, "GET user"),
    ).rejects.toMatchObject({ circuitOpen: true });
    expect(user).toHaveBeenCalledTimes(5);
    expect(projects).toHaveBeenCalledTimes(5);
    expect(gate.resetForUserRetry()).toBe(true);
    await gate.run(user, undefined, undefined, "GET user");
  });

  test("Todoist instances share the same 429 cooldown across endpoints", async () => {
    vi.mocked(requestUrl).mockResolvedValueOnce(
      response(429, { "retry-after": "60" }),
    );
    const first = new TodoistProvider("same-test-credential"),
      second = new TodoistProvider("same-test-credential");
    await expect(first.get("a")).rejects.toMatchObject({
      status: 429,
      retryAt: Date.now() + 60_000,
    });
    await expect(second.get("b")).rejects.toMatchObject({
      retryAt: Date.now() + 60_000,
    });
    expect(requestUrl).toHaveBeenCalledTimes(1);
  });

  test("Todoist authentication failures stop automatic requests until manual reconnect", async () => {
    const token = "permanent-auth-test";
    vi.mocked(requestUrl).mockResolvedValueOnce(response(401));
    await expect(new TodoistProvider(token).get("a")).rejects.toMatchObject({
      status: 401,
      needsReconnect: true,
    });
    await expect(new TodoistProvider(token).get("b")).rejects.toMatchObject({
      needsReconnect: true,
    });
    expect(requestUrl).toHaveBeenCalledTimes(1);
    expect(todoistRequestGate(token).resetForUserRetry()).toBe(true);
  });

  test("Todoist healthy user read cannot mask a repeatedly failing projects endpoint", async () => {
    const token = "endpoint-streak-test";
    vi.mocked(requestUrl).mockImplementation((async (
      input: Parameters<typeof requestUrl>[0],
    ) => {
      const url = typeof input === "string" ? input : input.url;
      if (url.endsWith("/user"))
        return response(
          200,
          {},
          { id: "u", full_name: "User", tz_info: { timezone: "UTC" } },
        );
      if (url.includes("/projects?")) return response(503);
      throw Error("Unexpected endpoint");
    }) as unknown as typeof requestUrl);
    const provider = new TodoistProvider(token);
    for (let i = 0; i < 5; i++) {
      const read = provider.read().catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(1000);
      expect(await read).toMatchObject({ status: 503 });
      await vi.advanceTimersByTimeAsync(1000 * 2 ** i);
    }
    expect(requestUrl).toHaveBeenCalledTimes(10);
    await expect(provider.read()).rejects.toMatchObject({
      message: expect.stringContaining("paused"),
    });
    expect(requestUrl).toHaveBeenCalledTimes(10);
    expect(todoistRequestGate(token).resetForUserRetry()).toBe(true);
  });

  test("Google shares quota cooldown across calendars and does not replay writes", async () => {
    const auth = { token: vi.fn(async () => "token") };
    const one = new GoogleCalendarApi(auth as never, "client", "one", "vault");
    const two = new GoogleCalendarApi(auth as never, "client", "two", "vault");
    vi.mocked(requestUrl).mockResolvedValueOnce(
      response(
        403,
        { "retry-after": "120" },
        { error: { errors: [{ reason: "userRateLimitExceeded" }] } },
      ),
    );
    await expect(
      one.update({ id: "event", etag: "v" } as never, {
        title: "x",
        start: "2026-01-01T00:00:00Z",
        end: "2026-01-01T01:00:00Z",
      }),
    ).rejects.toMatchObject({ status: 403, retryAt: Date.now() + 120_000 });
    await expect(two.calendars()).rejects.toMatchObject({
      retryAt: Date.now() + 120_000,
    });
    expect(requestUrl).toHaveBeenCalledTimes(1);
  });

  test("Google server failures are not replayed and suppress other requests", async () => {
    const auth = { token: vi.fn(async () => "token") };
    const api = new GoogleCalendarApi(
      auth as never,
      "client",
      "calendar",
      "vault",
    );
    vi.mocked(requestUrl).mockResolvedValue(response(503));
    await expect(api.calendars()).rejects.toMatchObject({
      status: 503,
      retryAt: Date.now() + 1000,
    });
    await expect(api.calendars()).rejects.toMatchObject({
      retryAt: Date.now() + 1000,
    });
    expect(requestUrl).toHaveBeenCalledTimes(1);
  });

  test("ordinary Google permission errors pause until an explicit retry", async () => {
    const auth = { token: vi.fn(async () => "token") };
    const api = new GoogleCalendarApi(
      auth as never,
      "client",
      "calendar",
      "vault",
    );
    vi.mocked(requestUrl)
      .mockResolvedValueOnce(
        response(403, {}, { error: { errors: [{ reason: "forbidden" }] } }),
      )
      .mockResolvedValueOnce(response(200, {}, { items: [] }));
    await expect(api.calendars()).rejects.toMatchObject({
      status: 403,
      retryAt: undefined,
    });
    await expect(api.calendars()).rejects.toMatchObject({
      status: 403,
      circuitOpen: true,
    });
    expect(requestUrl).toHaveBeenCalledTimes(1);
    expect(googleRequestGate(auth).resetForUserRetry()).toBe(true);
    const next = api.calendars();
    await vi.advanceTimersByTimeAsync(1000);
    await expect(next).resolves.toEqual([]);
    expect(requestUrl).toHaveBeenCalledTimes(2);
  });

  test("queued work cannot send after its own provider is unloaded", async () => {
    const gate = new RequestGate(1000);
    const send = vi.fn(async () => response(200));
    await gate.run(send);
    let alive = true;
    const next = gate
      .run(send, undefined, () => alive)
      .catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    alive = false;
    await vi.advanceTimersByTimeAsync(1000);
    expect(await next).toMatchObject({
      message: expect.stringContaining("unloaded"),
    });
    expect(send).toHaveBeenCalledTimes(1);
    await gate.run(send);
    expect(send).toHaveBeenCalledTimes(2);
  });

  test("OAuth response retains the server Retry-After header", async () => {
    vi.mocked(requestUrl).mockResolvedValueOnce(
      response(429, { "Retry-After": "120" }),
    );
    await expect(
      googleTokenRequest({ grant_type: "refresh_token" }),
    ).rejects.toMatchObject({ status: 429, retryAfter: "120" });
  });

  test("OAuth quota 403 is transient and retains its deadline", async () => {
    vi.mocked(requestUrl).mockResolvedValueOnce(
      response(
        403,
        { "retry-after": "120" },
        { error: { status: "RESOURCE_EXHAUSTED" } },
      ),
    );
    await expect(
      googleTokenRequest({ grant_type: "refresh_token" }),
    ).rejects.toMatchObject({ status: 403, retryAfter: "120", quota: true });
    const auth = {
      token: vi.fn(async () => {
        throw new GoogleTokenError(403, "120", true);
      }),
    };
    const api = new GoogleCalendarApi(
      auth as never,
      "client",
      "calendar",
      "vault",
    );
    await expect(api.calendars()).rejects.toMatchObject({
      status: 403,
      retryAt: Date.now() + 120_000,
    });
    await expect(api.calendars()).rejects.toMatchObject({
      retryAt: Date.now() + 120_000,
    });
    expect(auth.token).toHaveBeenCalledTimes(1);
  });

  test("OAuth rate limits share the full deadline across Google calendars", async () => {
    const auth = {
      token: vi.fn(async () => {
        throw new GoogleTokenError(429, "120");
      }),
    };
    const one = new GoogleCalendarApi(auth as never, "client", "one", "vault");
    const two = new GoogleCalendarApi(auth as never, "client", "two", "vault");
    await expect(one.calendars()).rejects.toMatchObject({
      status: 429,
      retryAt: Date.now() + 120_000,
    });
    await expect(two.calendars()).rejects.toMatchObject({
      retryAt: Date.now() + 120_000,
    });
    expect(auth.token).toHaveBeenCalledTimes(1);
    expect(requestUrl).not.toHaveBeenCalled();
  });

  test("revoked OAuth credentials retain their reconnect error", async () => {
    const auth = {
      token: vi.fn(async () => {
        throw new GoogleTokenError(401);
      }),
    };
    const api = new GoogleCalendarApi(
      auth as never,
      "client",
      "calendar",
      "vault",
    );
    await expect(api.calendars()).rejects.toThrow(
      "Reconnect in Day Planner settings",
    );
    await expect(api.calendars()).rejects.toMatchObject({ circuitOpen: true });
    expect(auth.token).toHaveBeenCalledTimes(1);
    expect(requestUrl).not.toHaveBeenCalled();
  });

  test("Google authorization recovery is bounded to one retry", async () => {
    const auth = { token: vi.fn(async () => "token") };
    const api = new GoogleCalendarApi(
      auth as never,
      "client",
      "calendar",
      "vault",
    );
    vi.mocked(requestUrl).mockResolvedValue(response(401));
    const result = api.calendars().catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await result).toMatchObject({ status: 401 });
    expect(requestUrl).toHaveBeenCalledTimes(2);
    expect(auth.token.mock.calls).toEqual([
      ["client", false],
      ["client", true],
    ]);
  });
});
