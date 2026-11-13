import { createHash, webcrypto } from "node:crypto";
import { get } from "node:http";
import type { App } from "obsidian";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const { request } = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("obsidian", async (original) => ({
  ...(await original<typeof import("obsidian")>()),
  Platform: { isDesktopApp: true },
  requestUrl: request,
}));
import { TodoistAuth } from "../src/tasks/todoist-auth";
import {
  RequestPermanentError,
  RequestTransientError,
} from "../src/service/request-gate";

beforeEach(() => {
  vi.stubGlobal("crypto", webcrypto);
  request.mockReset();
});
afterEach(() => vi.restoreAllMocks());

function setup() {
  const secrets = new Map<string, string>();
  const auth = new TodoistAuth(
    {
      secretStorage: {
        getSecret: (key: string) => secrets.get(key),
        setSecret: (key: string, value: string) => secrets.set(key, value),
      },
    } as unknown as App,
    "account",
  );
  return { auth, secrets };
}
function callback(url: URL) {
  return new Promise<number>((resolve, reject) => {
    get(
      {
        hostname: "127.0.0.1",
        port: Number(url.port),
        path: url.pathname + url.search,
      },
      (response) => {
        response.resume();
        response.on("end", () => resolve(response.statusCode!));
      },
    ).on("error", reject);
  });
}

test("registers a public read-only client, validates state and exchanges PKCE code", async () => {
  const h = setup();
  const previous = JSON.stringify({
    clientId: "old-client",
    reference: "old",
    access: "old",
    refresh: "old-refresh",
    expires: Date.now() + 3600_000,
  });
  h.secrets.set("account-oauth", previous);
  request
    .mockResolvedValueOnce({
      status: 201,
      headers: {},
      json: { client_id: "client" },
    })
    .mockResolvedValueOnce({
      status: 200,
      headers: {},
      json: {
        access_token: "initial",
        refresh_token: "refresh",
        expires_in: 3600,
      },
    });
  let opened = "";
  vi.spyOn(window, "open").mockImplementation((url) => {
    opened = String(url);
    return null;
  });
  const pending = h.auth.connect();
  await vi.waitFor(() => expect(opened).not.toBe(""));
  const authorize = new URL(opened);
  const registration = JSON.parse(request.mock.calls[0]![0].body);
  expect(registration).toMatchObject({
    scope: "data:read",
    token_endpoint_auth_method: "none",
  });
  const redirect = new URL(authorize.searchParams.get("redirect_uri")!);
  expect(registration.redirect_uris).toEqual([redirect.toString()]);
  redirect.searchParams.set("state", "wrong");
  redirect.searchParams.set("code", "authorization-code");
  expect(await callback(redirect)).toBe(400);
  expect(h.secrets.get("account-oauth")).toBe(previous);
  redirect.searchParams.set("state", authorize.searchParams.get("state")!);
  expect(await callback(redirect)).toBe(200);
  expect(await pending).toBe("initial");
  expect(h.secrets.get("account-oauth")).toBe(previous);
  const exchange = new URLSearchParams(request.mock.calls[1]![0].body);
  expect(exchange.get("client_secret")).toBeNull();
  expect(
    createHash("sha256")
      .update(exchange.get("code_verifier")!)
      .digest("base64url"),
  ).toBe(authorize.searchParams.get("code_challenge"));
  expect(await h.auth.token("initial")).toBe("initial");
  const rollback = h.auth.commit("initial");
  expect(JSON.parse(h.secrets.get("account-oauth")!).refresh).toBe("refresh");
  rollback();
  expect(h.secrets.get("account-oauth")).toBe(previous);
  h.auth.stop();
});

test("rotates expired OAuth credentials once while leaving legacy tokens alone", async () => {
  const h = setup();
  h.secrets.set(
    "account-oauth",
    JSON.stringify({
      clientId: "client",
      reference: "initial",
      access: "old",
      refresh: "refresh",
      expires: 0,
    }),
  );
  request.mockResolvedValueOnce({
    status: 200,
    headers: {},
    json: { access_token: "new", refresh_token: "rotated", expires_in: 3600 },
  });
  expect(await h.auth.token("legacy")).toBe("legacy");
  expect(
    await Promise.all([h.auth.token("initial"), h.auth.token("initial")]),
  ).toEqual(["new", "new"]);
  expect(request).toHaveBeenCalledOnce();
  expect(JSON.parse(h.secrets.get("account-oauth")!).refresh).toBe("rotated");
  expect(await h.auth.token("initial")).toBe("new");
});

test("failed refresh preserves stored credentials and signals backoff or permanent denial", async () => {
  const h = setup(),
    original = JSON.stringify({
      clientId: "client",
      reference: "initial",
      access: "old",
      refresh: "refresh",
      expires: 0,
    });
  h.secrets.set("account-oauth", original);
  request
    .mockResolvedValueOnce({ status: 429, headers: { "Retry-After": "60" } })
    .mockResolvedValueOnce({ status: 401, headers: {} });
  await expect(h.auth.token("initial")).rejects.toMatchObject({
    status: 429,
    retryAfter: "60",
  } satisfies Partial<RequestTransientError>);
  await expect(h.auth.token("initial")).rejects.toBeInstanceOf(
    RequestPermanentError,
  );
  expect(h.secrets.get("account-oauth")).toBe(original);
});
