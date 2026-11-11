import { webcrypto } from "node:crypto";
import { requestUrl, type App } from "obsidian";
import { beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("obsidian", () => ({
  requestUrl: vi.fn(),
  Platform: { isDesktopApp: true },
}));

import { GoogleCalendarApi } from "../src/google-calendar/api";
import { GoogleCalendarAuth } from "../src/google-calendar/auth";
import type { GoogleEvent } from "../src/google-calendar/types";

const snapshot = {
  title: "Work",
  start: "2026-11-11T04:30:00.000Z",
  end: "2026-11-11T05:30:00.000Z",
};
const event: GoogleEvent = {
  id: "test",
  etag: '"version1"',
  summary: "Old title",
  start: { dateTime: snapshot.start },
  end: { dateTime: snapshot.end },
};
const response = (status: number, json: unknown = {}, headers = {}) => ({
  status,
  json,
  headers,
  text: "",
  arrayBuffer: new ArrayBuffer(0),
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("crypto", webcrypto);
});

describe("Google REST transport", () => {
  const setup = () => {
    const token = vi.fn(async () => "test-access-token");
    return {
      token,
      api: new GoogleCalendarApi(
        { token } as unknown as GoogleCalendarAuth,
        "test-client",
        "calendar@example.com",
        "namespace",
      ),
    };
  };
  test("retrieves every page using expanded recurring instances", async () => {
    const { api } = setup();
    vi.mocked(requestUrl)
      .mockResolvedValueOnce(
        response(200, { items: [event], nextPageToken: "page2" }),
      )
      .mockResolvedValueOnce(
        response(200, { items: [{ ...event, id: "second" }] }),
      );
    expect(await api.list(snapshot.start, snapshot.end)).toHaveLength(2);
    const urls = vi
      .mocked(requestUrl)
      .mock.calls.map(([arg]) => new URL((arg as { url: string }).url));
    expect(urls[0]?.searchParams.get("singleEvents")).toBe("true");
    expect(urls[1]?.searchParams.get("pageToken")).toBe("page2");
  });
  test("PATCH changes only title and times and uses the Google version", async () => {
    const { api } = setup();
    vi.mocked(requestUrl).mockResolvedValue(response(200, event));
    await api.update(event, snapshot);
    const arg = vi.mocked(requestUrl).mock.calls[0]![0] as {
      method: string;
      headers: Record<string, string>;
      body: string;
    };
    expect(arg.method).toBe("PATCH");
    expect(arg.headers["If-Match"]).toBe(event.etag);
    expect(JSON.parse(arg.body)).toEqual({
      summary: snapshot.title,
      start: { dateTime: snapshot.start },
      end: { dateTime: snapshot.end },
    });
  });
  test("a precondition failure is surfaced without a forced overwrite", async () => {
    const { api } = setup();
    vi.mocked(requestUrl).mockResolvedValue(response(412));
    await expect(api.update(event, snapshot)).rejects.toThrow("Google changed");
    expect(requestUrl).toHaveBeenCalledTimes(1);
  });
  test("deletions use If-Match and handle empty 204 responses", async () => {
    const { api } = setup();
    vi.mocked(requestUrl).mockResolvedValue(response(204));
    await api.remove(event);
    expect(requestUrl).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "DELETE",
        headers: expect.objectContaining({ "If-Match": event.etag }),
      }),
    );
  });
  test("401 refreshes the access token once; 403 is never treated as deletion", async () => {
    const { api, token } = setup();
    vi.mocked(requestUrl)
      .mockResolvedValueOnce(response(401))
      .mockResolvedValueOnce(response(200, event));
    await api.get(event.id);
    expect(token).toHaveBeenLastCalledWith("test-client", true);
    vi.mocked(requestUrl).mockResolvedValue(response(403));
    await expect(api.get(event.id)).rejects.toThrow("403");
  });
  test("read-only calendar access is rejected before synchronization", async () => {
    const { api } = setup();
    vi.mocked(requestUrl).mockResolvedValue(
      response(200, { id: "calendar", accessRole: "reader" }),
    );
    await expect(api.validateCalendar()).rejects.toThrow("can edit");
  });
  test("a duplicate insert is recovered by reading its deterministic ID", async () => {
    const { api } = setup();
    vi.mocked(requestUrl)
      .mockResolvedValueOnce(response(409))
      .mockResolvedValueOnce(response(200, event));
    expect(await api.create("test", "uid", snapshot)).toEqual(event);
  });
});

describe("Google OAuth", () => {
  const setup = () => {
    const secrets = new Map<string, string>();
    const app = {
      secretStorage: {
        getSecret: (key: string) => secrets.get(key) ?? null,
        setSecret: (key: string, value: string) => {
          secrets.set(key, value);
        },
      },
    } as unknown as App;
    return { secrets, auth: new GoogleCalendarAuth(app, "test-key") };
  };
  test("refreshes coalesce and tokens stay in SecretStorage", async () => {
    const { auth, secrets } = setup();
    secrets.set("test-key-refresh", "test-refresh-token");
    vi.mocked(requestUrl).mockResolvedValue(
      response(200, { access_token: "test-access-token", expires_in: 3600 }),
    );
    expect(
      await Promise.all([auth.token("client"), auth.token("client")]),
    ).toEqual(["test-access-token", "test-access-token"]);
    expect(requestUrl).toHaveBeenCalledTimes(1);
    await auth.token("client");
    expect(requestUrl).toHaveBeenCalledTimes(1);
    auth.disconnect();
    expect(secrets.get("test-key-refresh")).toBe("");
  });
  test("uses a loopback callback, random state and PKCE without a relay", async () => {
    const { auth, secrets } = setup();
    vi.mocked(requestUrl).mockResolvedValue(
      response(200, {
        access_token: "test-access-token",
        refresh_token: "test-refresh-token",
        expires_in: 3600,
      }),
    );
    let authUrl: URL | undefined;
    let invalidStatus: number | undefined;
    let callback: Promise<void> | undefined;
    const open = vi.spyOn(window, "open").mockImplementation((url) => {
      authUrl = new URL(String(url));
      callback = (async () => {
        const redirect = authUrl!.searchParams.get("redirect_uri")!;
        invalidStatus = (await fetch(`${redirect}?state=invalid&code=invalid`))
          .status;
        const params = new URLSearchParams({
          state: authUrl!.searchParams.get("state")!,
          code: "test-code",
        });
        expect((await fetch(`${redirect}?${params.toString()}`)).status).toBe(
          200,
        );
      })();
      return null;
    });
    try {
      await auth.connect("test.apps.googleusercontent.com");
      await callback;
      expect(invalidStatus).toBe(400);
      expect(authUrl?.origin).toBe("https://accounts.google.com");
      expect(authUrl?.searchParams.get("code_challenge_method")).toBe("S256");
      const arg = vi.mocked(requestUrl).mock.calls[0]![0] as { body: string };
      const verifier = new URLSearchParams(arg.body).get("code_verifier")!;
      const digest = Buffer.from(
        await webcrypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(verifier),
        ),
      ).toString("base64url");
      expect(authUrl?.searchParams.get("code_challenge")).toBe(digest);
      expect(secrets.get("test-key-refresh")).toBe("test-refresh-token");
    } finally {
      open.mockRestore();
      auth.stop();
    }
  });
});
