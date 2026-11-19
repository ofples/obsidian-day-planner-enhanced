import type { App, RequestUrlParam, RequestUrlResponse } from "obsidian";
import { get } from "svelte/store";
import { describe, expect, test, vi } from "vitest";

import { RequestGate } from "../src/service/request-gate";
import { GitHubAuth } from "../src/tasks/github-auth";

const response = (json: unknown, status = 200): RequestUrlResponse => ({
  status,
  json,
  headers: {},
  text: "",
  arrayBuffer: new ArrayBuffer(0),
});
const device = {
  device_code: "opaque-device",
  user_code: "ABCD-EFGH",
  verification_uri: "https://github.com/login/device",
  expires_in: 900,
  interval: 5,
};
const tokens = {
  access_token: "new-access",
  refresh_token: "new-refresh",
  expires_in: 120,
  refresh_token_expires_in: 3600,
  scope: "read:project,offline_access",
};
const original = {
  clientId: "client",
  accountId: "original-account",
  access: "old-access",
  scopes: ["read:project"],
};
function fixture() {
  const secrets = new Map<string, string>([
    ["source-github-oauth", JSON.stringify(original)],
  ]);
  const app = {
    secretStorage: {
      getSecret: (key: string) => secrets.get(key) ?? null,
      setSecret: (key: string, value: string) => {
        secrets.set(key, value);
      },
    },
  } as unknown as App;
  return { app, secrets };
}

describe("GitHub device authorization", () => {
  test("shows the code, respects pending/slow-down intervals and validates before replacing credentials", async () => {
    const { app, secrets } = fixture();
    let now = 0;
    const waits: number[] = [];
    const send = vi
      .fn<(value: RequestUrlParam) => Promise<RequestUrlResponse>>()
      .mockResolvedValueOnce(response(device))
      .mockResolvedValueOnce(response({ error: "authorization_pending" }))
      .mockResolvedValueOnce(response({ error: "slow_down" }))
      .mockResolvedValueOnce(response(tokens));
    const auth = new GitHubAuth(
      app,
      "source-github",
      send,
      async (ms) => {
        waits.push(ms);
        now += ms;
        expect(get(auth.device)?.code).toBe(device.user_code);
      },
      () => now,
      new RequestGate(0),
    );
    const validate = vi.fn(
      async (access: string, scopes: readonly string[]) => {
        expect(access).toBe("new-access");
        expect(scopes).toContain("read:project");
        expect(JSON.parse(secrets.get("source-github-oauth")!).access).toBe(
          "old-access",
        );
        return "new-account";
      },
    );
    const first = auth.connect("client", false, validate);
    expect(auth.connect("client", false, validate)).toBe(first);
    await first;
    expect(waits).toEqual([5000, 5000, 10000]);
    expect(validate).toHaveBeenCalledTimes(1);
    expect(get(auth.device)).toBeNull();
    expect(auth.accountId()).toBe("new-account");
    expect(await auth.token("client")).toBe("new-access");
    const requested = new URLSearchParams(String(send.mock.calls[0]?.[0].body));
    expect(requested.get("scope")).toBe("read:project offline_access");
    expect(
      send.mock.calls.every(([request]) =>
        request.url.startsWith("https://github.com/login/"),
      ),
    ).toBe(true);
  });

  test("private repository scope is requested only by an explicit opt-in", async () => {
    const { app } = fixture();
    const send = vi.fn(async (request: RequestUrlParam) =>
      response(
        request.url.endsWith("/device/code")
          ? device
          : { ...tokens, scope: "read:project,offline_access,repo" },
      ),
    );
    const auth = new GitHubAuth(
      app,
      "source-github",
      send,
      async () => {},
      () => 0,
      new RequestGate(0),
    );
    await auth.connect("client", true, async () => "account");
    expect(
      new URLSearchParams(String(send.mock.calls[0]?.[0].body)).get("scope"),
    ).toBe("read:project offline_access repo");
  });

  test.each(["cancel", "expire"])(
    "%s stops polling and retains the original account",
    async (action) => {
      const { app, secrets } = fixture();
      let now = 0;
      const send = vi.fn(async () => response({ ...device, expires_in: 1 }));
      const auth = new GitHubAuth(
        app,
        "source-github",
        send,
        async (ms) => {
          now += ms;
          if (action === "cancel") auth.cancel();
        },
        () => now,
        new RequestGate(0),
      );
      await expect(
        auth.connect("client", false, async () => "new"),
      ).rejects.toThrow(action === "cancel" ? /cancelled/ : /expired/);
      expect(send).toHaveBeenCalledTimes(1);
      expect(JSON.parse(secrets.get("source-github-oauth")!)).toEqual(original);
      expect(get(auth.device)).toBeNull();
    },
  );

  test("a failed account validation never replaces the active credential", async () => {
    const { app, secrets } = fixture();
    const send = vi.fn(async (request: RequestUrlParam) =>
      response(request.url.endsWith("/device/code") ? device : tokens),
    );
    const auth = new GitHubAuth(
      app,
      "source-github",
      send,
      async () => {},
      () => 0,
      new RequestGate(0),
    );
    await expect(
      auth.connect("client", false, async () => {
        throw new Error("Account read failed");
      }),
    ).rejects.toThrow(/Account read failed/);
    expect(JSON.parse(secrets.get("source-github-oauth")!)).toEqual(original);
  });

  test("expiring tokens refresh once and rotate atomically without a client secret", async () => {
    const { app, secrets } = fixture();
    let now = 0;
    const send = vi
      .fn<(request: RequestUrlParam) => Promise<RequestUrlResponse>>()
      .mockResolvedValueOnce(response(device))
      .mockResolvedValueOnce(response(tokens))
      .mockResolvedValueOnce(
        response({
          ...tokens,
          access_token: "rotated-access",
          refresh_token: "rotated-refresh",
          expires_in: 3600,
        }),
      );
    const auth = new GitHubAuth(
      app,
      "source-github",
      send,
      async (ms) => {
        now += ms;
      },
      () => now,
      new RequestGate(0),
    );
    await auth.connect("client", false, async () => "new-account");
    now += 70_000;
    expect(
      await Promise.all([auth.token("client"), auth.token("client")]),
    ).toEqual(["rotated-access", "rotated-access"]);
    expect(send).toHaveBeenCalledTimes(3);
    const params = new URLSearchParams(String(send.mock.calls[2]?.[0].body));
    expect(params.get("grant_type")).toBe("refresh_token");
    expect(params.has("client_secret")).toBe(false);
    const saved = JSON.parse(secrets.get("source-github-oauth")!);
    expect(saved.refresh).toBe("rotated-refresh");
    expect(saved.accountId).toBe("new-account");
    auth.disconnect();
    expect(auth.connected("client")).toBe(false);
  });

  test("a missing owned app registration fails before network activity", async () => {
    const { app } = fixture();
    const send = vi.fn(async () => response(device));
    const auth = new GitHubAuth(app, "source-github", send);
    await expect(auth.connect("", false, async () => "new")).rejects.toThrow(
      /not configured/,
    );
    expect(send).not.toHaveBeenCalled();
  });
});
