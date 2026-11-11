import { Platform, requestUrl, type App } from "obsidian";

interface Tokens {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
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
  if (response.status !== 200)
    throw new Error(
      `Google sign-in failed (${response.status}). Reconnect in Day Planner settings.`,
    );
  return response.json as Tokens;
}

export class GoogleCalendarAuth {
  private access?: { token: string; expires: number };
  private refreshPending?: Promise<string>;
  private cancelLogin?: () => void;

  constructor(
    private readonly app: App,
    private readonly key: string,
  ) {}

  private storage() {
    const storage = Reflect.get(this.app, "secretStorage") as
      | App["secretStorage"]
      | undefined;
    if (!storage)
      throw new Error(
        "Google Calendar sync requires Obsidian 1.11.4 or later (SecretStorage).",
      );
    return storage;
  }

  setClientSecret(secret: string) {
    this.storage().setSecret(`${this.key}-client`, secret);
  }

  async token(clientId: string, force = false): Promise<string> {
    if (!force && this.access && this.access.expires > Date.now() + 60_000)
      return this.access.token;
    if (this.refreshPending) return this.refreshPending;
    this.refreshPending = this.refresh(clientId).finally(() => {
      this.refreshPending = undefined;
    });
    return this.refreshPending;
  }

  private async refresh(clientId: string) {
    const refreshToken = this.storage().getSecret(`${this.key}-refresh`);
    if (!refreshToken)
      throw new Error("Connect Google Calendar in Day Planner settings first.");
    const tokens = await googleTokenRequest({
      client_id: clientId,
      client_secret: this.storage().getSecret(`${this.key}-client`) ?? "",
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    });
    this.accept(tokens);
    return tokens.access_token;
  }

  private accept(tokens: Tokens) {
    if (!tokens.access_token || !Number.isFinite(tokens.expires_in))
      throw new Error("Google returned an invalid token response.");
    this.access = {
      token: tokens.access_token,
      expires: Date.now() + tokens.expires_in * 1000,
    };
    if (tokens.refresh_token)
      this.storage().setSecret(`${this.key}-refresh`, tokens.refresh_token);
  }

  async connect(clientId: string) {
    if (!Platform.isDesktopApp)
      throw new Error(
        "Connect on desktop. Google sign-in via loopback is not available on mobile.",
      );
    if (!clientId.endsWith(".apps.googleusercontent.com"))
      throw new Error("Enter a Google Desktop app OAuth client ID first.");
    this.storage();
    this.cancelLogin?.();
    // Desktop-only dependency: mobile can still load the planner without Node.
    const { createServer } = await import("node:http");
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
          .end("Return to Obsidian to finish connecting Google Calendar.");
        void googleTokenRequest({
          client_id: clientId,
          client_secret: this.storage().getSecret(`${this.key}-client`) ?? "",
          grant_type: "authorization_code",
          code,
          code_verifier: verifier,
          redirect_uri: redirect,
        })
          .then((tokens) => {
            if (settled) return;
            if (!tokens.refresh_token)
              throw new Error(
                "Google did not grant offline access; reconnect and allow access.",
              );
            this.accept(tokens);
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
          scope:
            "https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.calendarlist.readonly",
          access_type: "offline",
          prompt: "consent",
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
    this.cancelLogin?.();
  }
}
