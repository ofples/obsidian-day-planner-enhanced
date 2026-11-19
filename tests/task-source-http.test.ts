import type { RequestUrlResponse } from "obsidian";
import { describe, expect, test, vi } from "vitest";

import { RequestGate } from "../src/service/request-gate";
import { githubRateLimit } from "../src/tasks/github-rate-limit";
import { TaskSourceHttp } from "../src/tasks/source-http";

const response = (
  status: number,
  json: unknown = {},
  headers: Record<string, string> = {},
): RequestUrlResponse => ({
  status,
  json,
  headers,
  text: "",
  arrayBuffer: new ArrayBuffer(0),
});

describe("source HTTP requests", () => {
  test("a provider deadline fails fast without replaying the request", async () => {
    const send = vi.fn(async () => response(429, {}, { "retry-after": "60" }));
    const http = new TaskSourceHttp(
      "https://tasks.googleapis.com",
      "Google Tasks",
      async () => "credential",
      new RequestGate(0),
      () => true,
      undefined,
      send,
    );
    await expect(
      http.request("/tasks/v1/users/@me/lists"),
    ).rejects.toMatchObject({ status: 429 });
    await expect(
      http.request("/tasks/v1/users/@me/lists"),
    ).rejects.toMatchObject({ status: 429 });
    expect(send).toHaveBeenCalledTimes(1);
    expect(http.gate.resetForUserRetry()).toBe(false);
  });

  test("GraphQL rate errors in HTTP 200 establish a cooldown", async () => {
    const send = vi.fn(async () =>
      response(200, {
        errors: [{ type: "RATE_LIMITED", message: "Rate limited" }],
      }),
    );
    const http = new TaskSourceHttp(
      "https://api.github.com",
      "GitHub",
      async () => "credential",
      new RequestGate(0),
      () => true,
      githubRateLimit,
      send,
    );
    await expect(
      http.request("/graphql", {
        method: "POST",
        body: { query: "query { viewer { id } }" },
      }),
    ).rejects.toMatchObject({ status: 429 });
    await expect(http.request("/user")).rejects.toMatchObject({ status: 429 });
    expect(send).toHaveBeenCalledTimes(1);
  });

  test("permission failures stay scoped while rejected credentials pause the connection", async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce(response(403))
      .mockResolvedValueOnce(response(200, { id: "account" }))
      .mockResolvedValueOnce(response(401));
    const http = new TaskSourceHttp(
      "https://api.github.com",
      "GitHub",
      async () => "credential",
      new RequestGate(0),
      () => true,
      githubRateLimit,
      send,
    );
    await expect(
      http.request("/repos/org/private/issues"),
    ).rejects.toMatchObject({ needsReconnect: false, status: 403 });
    expect(await http.request("/user")).toEqual({ id: "account" });
    await expect(http.request("/user")).rejects.toMatchObject({
      needsReconnect: true,
      status: 401,
    });
    await expect(http.request("/user")).rejects.toMatchObject({
      needsReconnect: true,
    });
    expect(send).toHaveBeenCalledTimes(3);
  });

  test("cancelled queued work cannot publish or send with an old connection", async () => {
    let active = true;
    let finish!: (value: RequestUrlResponse) => void;
    const send = vi.fn(
      () =>
        new Promise<RequestUrlResponse>((resolve) => {
          finish = resolve;
        }),
    );
    const http = new TaskSourceHttp(
      "https://tasks.googleapis.com",
      "Google Tasks",
      async () => "credential",
      new RequestGate(0),
      () => active,
      undefined,
      send,
    );
    const first = http.request("/first");
    const second = http.request("/second");
    const checkedFirst = expect(first).rejects.toThrow(/cancelled/);
    const checkedSecond = expect(second).rejects.toThrow(/cancelled/);
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    active = false;
    finish(response(200));
    await Promise.all([checkedFirst, checkedSecond]);
    expect(send).toHaveBeenCalledTimes(1);
  });

  test("foreign or absolute API paths are rejected before attaching a credential", async () => {
    const token = vi.fn(async () => "credential");
    const send = vi.fn(async () => response(200));
    const http = new TaskSourceHttp(
      "https://api.github.com",
      "GitHub",
      token,
      new RequestGate(0),
      undefined,
      undefined,
      send,
    );
    await expect(http.request("//elsewhere.example/path")).rejects.toThrow(
      /relative/,
    );
    await expect(
      http.request("https://elsewhere.example/path"),
    ).rejects.toThrow(/relative/);
    expect(token).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });
});
