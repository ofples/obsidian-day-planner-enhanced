import { Platform, requestUrl, type App } from "obsidian";

interface Tokens {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope?: string;
}

export interface GoogleConnectOptions {
  scopes?: readonly string[];
  validate?: (
    accessToken: string,
    grantedScopes: readonly string[],
  ) => Promise<void>;
}

const calendarScopes = [
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
];

export function googleQuotaError(body: unknown) {
  if (!body || typeof body !== "object" || !("error" in body)) return false;
  const error = body.error;
  if (!error || typeof error !== "object") return false;
  if ("status" in error && error.status === "RESOURCE_EXHAUSTED") return true;
  if (!("errors" in error) || !Array.isArray(error.errors)) return false;
  return error.errors.some((item: unknown) =>
    Boolean(
      item &&
        typeof item === "object" &&
        "reason" in item &&
        [
          "rateLimitExceeded",
          "userRateLimitExceeded",
          "quotaExceeded",
        ].includes(String(item.reason)),
    ),
  );
}

export class GoogleTokenError extends Error {
  constructor(
    readonly status: number,
    readonly retryAfter?: string,
    readonly quota = false,
    detail?: string,
  ) {
    super(
      detail ??
        `Google sign-in failed (${status}). Reconnect in Day Planner settings.`,
    );
  }
}

function tokenErrorDetail(body: unknown): string | undefined {
  if (!body || typeof body !== "object" || !("error" in body)) return;
  if (
    body.error === "invalid_request" &&
    "error_description" in body &&
    typeof body.error_description === "string" &&
    /client_secret.*missing/i.test(body.error_description)
  )
    return "Google OAuth client secret is missing. Restore it under Advanced Google connection in Day Planner settings, then sign in again.";
  if (body.error === "invalid_client")
    return "Google rejected the OAuth client details. Check the client ID and saved client secret under Advanced Google connection in Day Planner settings.";
  if (body.error === "invalid_grant")
    return "Google authorization expired or was revoked. Use Sign in with Google to reconnect.";
}

export async function googleTokenRequest(
  params: Record<string, string>,
): Promise<Tokens> {
  const response = await requestUrl({
    url: "https://oauth2.googleapis.com/token",
    method: "POST",
    contentType: "application/x-www-form-urlencoded",
    body: new URLSearchParams(params).toString(),
    throw: false,
  });
  if (response.status !== 200) {
    let body: unknown;
    try {
      body = response.json;
    } catch {
      // A proxy or network error may return a non-JSON response.
    }
    throw new GoogleTokenError(
      response.status,
      Object.entries(response.headers).find(
        ([name]) => name.toLowerCase() === "retry-after",
      )?.[1],
      response.status === 403 && googleQuotaError(body),
      tokenErrorDetail(body),
    );
  }
  return response.json as Tokens;
}

export class GoogleCalendarAuth {
  private access?: { token: string; expires: number; clientId: string };
  private refreshPending?: Promise<string>;
  private refreshClientId?: string;
  private cancelLogin?: () => void;
  private revision = 0;

  constructor(
    private readonly app: App,
    private readonly key: string,
    private readonly appClientSecret?: (clientId: string) => string | undefined,
    private readonly label = "Google Calendar",
  ) {}

  private storage() {
    const storage = Reflect.get(this.app, "secretStorage") as
      | App["secretStorage"]
      | undefined;
    if (!storage)
      throw new Error(
        `${this.label} sync requires Obsidian 1.11.4 or later (SecretStorage).`,
      );
    return storage;
  }

  setClientSecret(secret: string) {
    this.storage().setSecret(`${this.key}-client`, secret.trim());
  }

  bindLegacyClient(clientId: string) {
    if (
      clientId &&
      this.isConnected() &&
      !this.storage().getSecret(`${this.key}-app-id`)
    )
      this.storage().setSecret(`${this.key}-app-id`, clientId);
  }

  isConnected(clientId?: string) {
    const bound = this.storage().getSecret(`${this.key}-app-id`);
    return Boolean(
      this.storage().getSecret(`${this.key}-refresh`) &&
        (!bound || !clientId || bound === clientId),
    );
  }

  grantedScopes(): readonly string[] {
    return (this.storage().getSecret(`${this.key}-scopes`) ?? "")
      .split(/\s+/)
      .filter(Boolean);
  }

  private clientSecret(clientId: string) {
    return (
      this.appClientSecret?.(clientId) ??
      this.storage().getSecret(`${this.key}-client`) ??
      ""
    );
  }

  async token(clientId: string, force = false): Promise<string> {
    if (
      !force &&
      this.access?.clientId === clientId &&
      this.access.expires > Date.now() + 60_000
    )
      return this.access.token;
    if (this.refreshPending) {
      if (this.refreshClientId === clientId) return this.refreshPending;
      await this.refreshPending.catch(() => {});
      return this.token(clientId, force);
    }
    this.refreshClientId = clientId;
    this.refreshPending = this.refresh(clientId).finally(() => {
      this.refreshPending = undefined;
    });
    return this.refreshPending;
  }

  private async refresh(clientId: string) {
    const revision = this.revision;
    const refreshToken = this.storage().getSecret(`${this.key}-refresh`);
    if (!refreshToken || !this.isConnected(clientId))
      throw new Error(`Connect ${this.label} in Day Planner settings first.`);
    const tokens = await googleTokenRequest({
      client_id: clientId,
      client_secret: this.clientSecret(clientId),
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    });
    if (revision !== this.revision)
      throw new Error("The Google connection changed. Sign in again.");
    this.accept(tokens, clientId);
    return tokens.access_token;
  }

  private accept(tokens: Tokens, clientId: string) {
    if (!tokens.access_token || !Number.isFinite(tokens.expires_in))
      throw new Error("Google returned an invalid token response.");
    this.access = {
      token: tokens.access_token,
      expires: Date.now() + tokens.expires_in * 1000,
      clientId,
    };
    if (tokens.refresh_token) {
      this.storage().setSecret(`${this.key}-refresh`, tokens.refresh_token);
      this.storage().setSecret(`${this.key}-app-id`, clientId);
    }
    if (tokens.scope)
      this.storage().setSecret(`${this.key}-scopes`, tokens.scope);
  }

  async connect(clientId: string, options: GoogleConnectOptions = {}) {
    if (!Platform.isDesktopApp)
      throw new Error(
        "Connect on desktop. Google sign-in via loopback is not available on mobile.",
      );
    if (!clientId.endsWith(".apps.googleusercontent.com"))
      throw new Error("Enter a Google Desktop app OAuth client ID first.");
    this.storage();
    const clientSecret = this.clientSecret(clientId);
    this.revision++;
    this.cancelLogin?.();
    // Obsidian loads plugins through CommonJS; Chromium's dynamic import cannot
    // resolve Node builtins. Keep require inside the desktop guard for mobile.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { createServer } = require("node:http") as typeof import("node:http");
    const random = () =>
      Array.from(crypto.getRandomValues(new Uint8Array(32)))
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");
    const verifier = random();
    const state = random();
    const challengeBytes = new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
    );
    const challenge = btoa(String.fromCharCode(...challengeBytes))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    await new Promise<void>((resolve, reject) => {
      let redirect = "";
      let settled = false;
      let consuming = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (server.listening) server.close();
        this.cancelLogin = undefined;
        if (error) reject(error);
        else resolve();
      };
      const server = createServer((request, response) => {
        const url = new URL(request.url ?? "/", "http://127.0.0.1");
        if (
          url.pathname !== "/oauth2callback" ||
          url.searchParams.get("state") !== state
        ) {
          response.writeHead(400).end("Invalid sign-in request.");
          return;
        }
        if (consuming) {
          response.writeHead(409).end("Sign-in already in progress.");
          return;
        }
        consuming = true;
        const code = url.searchParams.get("code");
        if (!code) {
          response.writeHead(400).end("Sign-in cancelled. Return to Obsidian.");
          finish(new Error("Google sign-in was cancelled."));
          return;
        }
        response
          .writeHead(200, { "Content-Type": "text/plain", Connection: "close" })
          .end(`Return to Obsidian to finish connecting ${this.label}.`);
        void googleTokenRequest({
          client_id: clientId,
          client_secret: clientSecret,
          grant_type: "authorization_code",
          code,
          code_verifier: verifier,
          redirect_uri: redirect,
        })
          .then(async (tokens) => {
            if (settled) return;
            if (!tokens.refresh_token)
              throw new Error(
                "Google did not grant offline access; reconnect and allow access.",
              );
            if (
              !tokens.access_token ||
              !Number.isFinite(tokens.expires_in) ||
              tokens.expires_in <= 0
            )
              throw new Error("Google returned an invalid token response.");
            // OAuth permits omitting scope when it is unchanged from the request.
            const scopes =
              tokens.scope?.split(/\s+/).filter(Boolean) ??
              options.scopes ??
              calendarScopes;
            await options.validate?.(tokens.access_token, scopes);
            // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- Cancellation can settle sign-in while source validation is pending.
            if (settled) return;
            tokens.scope = scopes.join(" ");
            this.accept(tokens, clientId);
            finish();
          })
          .catch((error: unknown) =>
            finish(
              error instanceof Error
                ? error
                : new Error("Google sign-in failed."),
            ),
          );
      });
      const timeout = setTimeout(
        () =>
          finish(new Error("Google sign-in timed out. Try connecting again.")),
        180_000,
      );
      this.cancelLogin = () => finish(new Error("Google sign-in cancelled."));
      server.once("error", finish);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (!address || typeof address === "string") {
          finish(new Error("Could not open the local sign-in listener."));
          return;
        }
        redirect = `http://127.0.0.1:${address.port}/oauth2callback`;
        const params = new URLSearchParams({
          client_id: clientId,
          redirect_uri: redirect,
          response_type: "code",
          scope: (options.scopes ?? calendarScopes).join(" "),
          access_type: "offline",
          prompt: "select_account consent",
          state,
          code_challenge: challenge,
          code_challenge_method: "S256",
        });
        window.open(
          `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`,
        );
      });
    });
  }

  disconnect() {
    this.stop();
    this.access = undefined;
    this.storage().setSecret(`${this.key}-refresh`, "");
  }

  stop() {
    this.revision++;
    this.cancelLogin?.();
  }
}
