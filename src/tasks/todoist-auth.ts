import { Platform, requestUrl, type App } from "obsidian";
import { z } from "zod";

import {
  RequestCancelledError,
  RequestPermanentError,
  RequestTransientError,
} from "../service/request-gate";

const tokenSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  expires_in: z.number().positive().finite(),
});
const bundleSchema = z.object({
  clientId: z.string().min(1),
  reference: z.string().min(1),
  access: z.string().min(1),
  refresh: z.string().min(1),
  expires: z.number().finite(),
});
type Bundle = z.infer<typeof bundleSchema>;

async function oauthRequest(path: string, body: string, contentType: string) {
  const response = await requestUrl({
    url: `https://api.todoist.com/oauth/${path}`,
    method: "POST",
    contentType,
    body,
    throw: false,
  });
  if (response.status === 429 || response.status >= 500)
    throw new RequestTransientError(
      response.status,
      Object.entries(response.headers).find(
        ([name]) => name.toLowerCase() === "retry-after",
      )?.[1],
    );
  if (response.status < 200 || response.status >= 300)
    throw new RequestPermanentError(
      new Error("Todoist sign-in was rejected. Sign in again."),
      response.status,
    );
  return response.json as unknown;
}

/** Credentials are held in one SecretStorage value so refresh token rotation is atomic. */
export class TodoistAuth {
  private stopped = false;
  private cancelLogin?: () => void;
  private refreshPending?: Promise<string>;
  private staged?: Bundle;
  private generation = 0;
  constructor(
    private readonly app: App,
    private readonly key: string,
  ) {}

  private storage() {
    const storage = Reflect.get(this.app, "secretStorage") as
      | App["secretStorage"]
      | undefined;
    if (!storage)
      throw new Error("Todoist sign-in requires Obsidian SecretStorage.");
    return storage;
  }

  private bundle(): Bundle | undefined {
    const value = this.storage().getSecret(`${this.key}-oauth`);
    if (!value) return undefined;
    try {
      return bundleSchema.parse(JSON.parse(value));
    } catch {
      throw new Error("Todoist sign-in data is invalid. Sign in again.");
    }
  }

  async token(fallbackToken: string): Promise<string> {
    if (this.stopped) throw new RequestCancelledError();
    if (this.staged?.reference === fallbackToken) return this.staged.access;
    const bundle = this.bundle();
    if (
      !bundle ||
      (fallbackToken !== bundle.reference && fallbackToken !== bundle.access)
    )
      return fallbackToken;
    if (bundle.expires > Date.now() + 60_000) return bundle.access;
    if (this.refreshPending) return this.refreshPending;
    this.refreshPending = this.refresh(bundle).finally(() => {
      this.refreshPending = undefined;
    });
    return this.refreshPending;
  }

  private async refresh(bundle: Bundle) {
    const params = new URLSearchParams({
      client_id: bundle.clientId,
      grant_type: "refresh_token",
      refresh_token: bundle.refresh,
    });
    const parsed = tokenSchema.safeParse(
      await oauthRequest(
        "access_token",
        params.toString(),
        "application/x-www-form-urlencoded",
      ),
    );
    if (!parsed.success)
      throw new RequestPermanentError(
        new Error("Todoist returned invalid sign-in data. Sign in again."),
      );
    if (this.stopped) throw new RequestCancelledError();
    const current = this.bundle();
    if (
      !current ||
      current.reference !== bundle.reference ||
      current.refresh !== bundle.refresh
    )
      throw new RequestCancelledError();
    this.storage().setSecret(
      `${this.key}-oauth`,
      JSON.stringify({
        ...bundle,
        access: parsed.data.access_token,
        refresh: parsed.data.refresh_token,
        expires: Date.now() + parsed.data.expires_in * 1000,
      }),
    );
    return parsed.data.access_token;
  }

  async connect(write = false): Promise<string> {
    if (!Platform.isDesktopApp)
      throw new Error("Todoist sign-in is available on desktop.");
    if (this.stopped) throw new RequestCancelledError();
    this.storage();
    this.cancelLogin?.();
    this.staged = undefined;
    const generation = ++this.generation;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { createServer } = require("node:http") as typeof import("node:http");
    const random = () =>
      Array.from(crypto.getRandomValues(new Uint8Array(32)))
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");
    const verifier = random(),
      state = random();
    const digest = new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
    );
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- stop may run while the digest is pending.
    if (this.stopped || generation !== this.generation)
      throw new RequestCancelledError();
    const challenge = btoa(String.fromCharCode(...digest))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    return new Promise<string>((resolve, reject) => {
      let settled = false,
        consuming = false,
        redirect = "",
        clientId = "";
      const finish = (error?: Error, token?: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (server.listening) server.close();
        this.cancelLogin = undefined;
        if (error) reject(error);
        else resolve(token!);
      };
      const server = createServer((request, response) => {
        const url = new URL(request.url ?? "/", "http://localhost");
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
        if (!code || !clientId) {
          response.writeHead(400).end("Sign-in cancelled.");
          finish(new Error("Todoist sign-in was cancelled."));
          return;
        }
        response
          .writeHead(200, { "Content-Type": "text/plain", Connection: "close" })
          .end("Return to Obsidian to finish connecting Todoist.");
        const params = new URLSearchParams({
          client_id: clientId,
          grant_type: "authorization_code",
          code,
          code_verifier: verifier,
          redirect_uri: redirect,
        });
        void oauthRequest(
          "access_token",
          params.toString(),
          "application/x-www-form-urlencoded",
        )
          .then((data) => {
            if (settled || this.stopped) return;
            const parsed = tokenSchema.safeParse(data);
            if (!parsed.success)
              throw new Error(
                "Todoist returned invalid sign-in data. Try again.",
              );
            const tokens = parsed.data;
            this.staged = {
              clientId,
              reference: tokens.access_token,
              access: tokens.access_token,
              refresh: tokens.refresh_token,
              expires: Date.now() + tokens.expires_in * 1000,
            };
            finish(undefined, tokens.access_token);
          })
          .catch((error: unknown) =>
            finish(
              error instanceof Error
                ? error
                : new Error("Todoist sign-in failed."),
            ),
          );
      });
      const timeout = setTimeout(
        () => finish(new Error("Todoist sign-in timed out.")),
        180_000,
      );
      this.cancelLogin = () => finish(new Error("Todoist sign-in cancelled."));
      server.once("error", finish);
      server.listen(0, "127.0.0.1", () => {
        if (settled) {
          server.close();
          return;
        }
        const address = server.address();
        if (!address || typeof address === "string") {
          finish(new Error("Could not open the local sign-in listener."));
          return;
        }
        redirect = `http://localhost:${address.port}/oauth2callback`;
        const scope = write ? "data:read_write" : "data:read";
        const body = JSON.stringify({
          client_name: "Day Planner Enhanced",
          redirect_uris: [redirect],
          scope,
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          token_endpoint_auth_method: "none",
        });
        void oauthRequest("register", body, "application/json")
          .then((data) => {
            if (settled || this.stopped) return;
            const parsed = z
              .object({ client_id: z.string().min(1) })
              .safeParse(data);
            if (!parsed.success)
              throw new Error("Todoist returned invalid client registration.");
            clientId = parsed.data.client_id;
            const params = new URLSearchParams({
              client_id: clientId,
              redirect_uri: redirect,
              response_type: "code",
              scope,
              state,
              code_challenge: challenge,
              code_challenge_method: "S256",
            });
            window.open(
              `https://app.todoist.com/oauth/authorize?${params.toString()}`,
            );
          })
          .catch((error: unknown) =>
            finish(
              error instanceof Error
                ? error
                : new Error("Todoist registration failed."),
            ),
          );
      });
    });
  }

  commit(token: string): () => void {
    if (!this.staged || this.staged.reference !== token)
      throw new Error("Todoist sign-in expired. Sign in again.");
    const storage = this.storage();
    const key = `${this.key}-oauth`;
    const previous = storage.getSecret(key) ?? "";
    storage.setSecret(key, JSON.stringify(this.staged));
    this.staged = undefined;
    return () => storage.setSecret(key, previous);
  }

  discard(token: string) {
    if (this.staged?.reference === token) this.staged = undefined;
  }

  stop() {
    this.stopped = true;
    this.staged = undefined;
    this.generation++;
    this.cancelLogin?.();
  }
}
