import {
  requestUrl,
  type App,
  type RequestUrlParam,
  type RequestUrlResponse,
} from "obsidian";
import { writable } from "svelte/store";
import { z } from "zod";

import {
  RequestCancelledError,
  RequestCooldownError,
  RequestGate,
} from "../service/request-gate";

import { TaskReadError } from "./types";

const tokenSchema = z.object({
  access_token: z.string().min(1),
  scope: z.string().optional(),
  expires_in: z.number().positive().finite().optional(),
  refresh_token: z.string().min(1).optional(),
  refresh_token_expires_in: z.number().positive().finite().optional(),
});
const bundleSchema = z.object({
  clientId: z.string().min(1),
  accountId: z.string().min(1),
  access: z.string().min(1),
  scopes: z.array(z.string()),
  expires: z.number().finite().optional(),
  refresh: z.string().optional(),
  refreshExpires: z.number().finite().optional(),
});
type Bundle = z.infer<typeof bundleSchema>;
const deviceSchema = z.object({
  device_code: z.string().min(1),
  user_code: z
    .string()
    .min(1)
    .max(40)
    .regex(/^[A-Z\d-]+$/),
  verification_uri: z.literal("https://github.com/login/device"),
  expires_in: z.number().positive().max(3600),
  interval: z.number().positive().max(3600),
});
const errorSchema = z.object({ error: z.string() });

function scopes(value: string) {
  return value.split(/[,\s]+/).filter(Boolean);
}

function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new RequestCancelledError());
      return;
    }
    const cancelled = () => {
      clearTimeout(timer);
      reject(new RequestCancelledError());
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", cancelled);
      resolve();
    }, ms);
    signal.addEventListener("abort", cancelled, { once: true });
  });
}

export interface GitHubDeviceState {
  code: string;
  url: string;
  expiresAt: number;
}

/** Public device authorization with staged identity validation and atomic token rotation. */
export class GitHubAuth {
  readonly device = writable<GitHubDeviceState | null>(null);
  private generation = 0;
  private credentialRevision = 0;
  private controller?: AbortController;
  private loginPending?: Promise<void>;
  private refreshPending?: Promise<string>;
  private readonly gate: RequestGate;

  constructor(
    private readonly app: App,
    private readonly key: string,
    private readonly send: (
      request: RequestUrlParam,
    ) => Promise<RequestUrlResponse> = requestUrl,
    private readonly wait: (
      ms: number,
      signal: AbortSignal,
    ) => Promise<void> = pause,
    private readonly now: () => number = Date.now,
    gate?: RequestGate,
  ) {
    this.gate = gate ?? new RequestGate();
  }

  private storage() {
    const storage = Reflect.get(this.app, "secretStorage") as
      | App["secretStorage"]
      | undefined;
    if (!storage)
      throw new Error("GitHub sign-in requires Obsidian SecretStorage.");
    return storage;
  }

  private bundle(): Bundle | undefined {
    const value = this.storage().getSecret(`${this.key}-oauth`);
    if (!value) return;
    let parsed: ReturnType<typeof bundleSchema.safeParse> | undefined;
    try {
      parsed = bundleSchema.safeParse(JSON.parse(value));
    } catch {
      /* Invalid local state is recoverable by sign-in. */
    }
    if (!parsed?.success)
      throw new TaskReadError(
        "GitHub sign-in data is invalid. Sign in again.",
        undefined,
        true,
      );
    return parsed.data;
  }

  connected(clientId: string) {
    return Boolean(clientId && this.bundle()?.clientId === clientId);
  }
  accountId() {
    return this.bundle()?.accountId;
  }
  grantedScopes() {
    return this.bundle()?.scopes ?? [];
  }

  private async oauth(
    path: "/login/device/code" | "/login/oauth/access_token",
    params: Record<string, string>,
    canStart: () => boolean,
  ) {
    try {
      const { response, retryAt } = await this.gate.run(
        () =>
          this.send({
            url: `https://github.com${path}`,
            method: "POST",
            headers: { Accept: "application/json" },
            contentType: "application/x-www-form-urlencoded",
            body: new URLSearchParams(params).toString(),
            throw: false,
          }),
        undefined,
        canStart,
        `POST ${path}`,
      );
      if (!canStart()) throw new RequestCancelledError();
      if (response.status === 429 || response.status >= 500)
        throw new TaskReadError(
          "GitHub sign-in is temporarily limited. Try again after the cooldown.",
          retryAt,
          false,
          response.status,
        );
      if (response.status !== 200 && response.status !== 400)
        throw new TaskReadError(
          "GitHub rejected sign-in. Check the app registration and sign in again.",
          undefined,
          true,
          response.status,
        );
      return response.json as unknown;
    } catch (error) {
      if (error instanceof RequestCooldownError)
        throw new TaskReadError(
          "GitHub sign-in is temporarily limited. Try again after the cooldown.",
          error.retryAt,
          error.permanent,
          error.status,
        );
      throw error;
    }
  }

  connect(
    clientId: string,
    includePrivate: boolean,
    validate: (access: string, granted: readonly string[]) => Promise<string>,
  ) {
    if (this.loginPending) return this.loginPending;
    if (!clientId || !/^[\w.-]{1,200}$/.test(clientId))
      return Promise.reject(
        new TaskReadError(
          "GitHub sign-in is not configured for this build. Configure an owned OAuth app under Advanced connections.",
        ),
      );
    this.storage();
    this.gate.resetForUserRetry();
    const generation = ++this.generation;
    const controller = new AbortController();
    this.controller = controller;
    const canStart = () =>
      !controller.signal.aborted && generation === this.generation;
    const requested = [
      "read:project",
      "offline_access",
      ...(includePrivate ? ["repo"] : []),
    ];
    const pending = (async () => {
      const code = deviceSchema.parse(
        await this.oauth(
          "/login/device/code",
          { client_id: clientId, scope: requested.join(" ") },
          canStart,
        ),
      );
      const expiresAt = this.now() + code.expires_in * 1000;
      this.device.set({
        code: code.user_code,
        url: code.verification_uri,
        expiresAt,
      });
      let interval = Math.max(5000, code.interval * 1000);
      while (canStart() && this.now() < expiresAt) {
        await this.wait(
          Math.min(interval, expiresAt - this.now()),
          controller.signal,
        );
        if (!canStart()) throw new RequestCancelledError();
        if (this.now() >= expiresAt) break;
        const raw = await this.oauth(
          "/login/oauth/access_token",
          {
            client_id: clientId,
            device_code: code.device_code,
            grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          },
          canStart,
        );
        const error = errorSchema.safeParse(raw);
        if (error.success) {
          if (error.data.error === "authorization_pending") continue;
          if (error.data.error === "slow_down") {
            interval += 5000;
            continue;
          }
          throw new TaskReadError(
            error.data.error === "access_denied"
              ? "GitHub sign-in was declined."
              : error.data.error === "expired_token"
                ? "GitHub sign-in expired. Start again for a new code."
                : "GitHub could not finish sign-in. Check that device flow is enabled for this OAuth app.",
          );
        }
        const tokens = tokenSchema.parse(raw);
        const granted =
          tokens.scope === undefined ? requested : scopes(tokens.scope);
        if (
          (!granted.includes("read:project") && !granted.includes("project")) ||
          (includePrivate && !granted.includes("repo"))
        )
          throw new TaskReadError(
            "GitHub did not grant the requested access. Sign in again and allow the selected permissions.",
          );
        const accountId = await validate(tokens.access_token, granted);
        if (!canStart()) throw new RequestCancelledError();
        this.credentialRevision++;
        this.storage().setSecret(
          `${this.key}-oauth`,
          JSON.stringify(this.accepted(tokens, clientId, accountId, granted)),
        );
        return;
      }
      throw new TaskReadError(
        "GitHub sign-in expired. Start again for a new code.",
      );
    })().finally(() => {
      if (this.loginPending === pending) {
        this.loginPending = undefined;
        this.controller = undefined;
        this.device.set(null);
      }
    });
    this.loginPending = pending;
    return pending;
  }

  private accepted(
    tokens: z.infer<typeof tokenSchema>,
    clientId: string,
    accountId: string,
    granted: readonly string[],
  ): Bundle {
    return {
      clientId,
      accountId,
      access: tokens.access_token,
      scopes: [...granted],
      ...(tokens.expires_in
        ? { expires: this.now() + tokens.expires_in * 1000 }
        : {}),
      ...(tokens.refresh_token ? { refresh: tokens.refresh_token } : {}),
      ...(tokens.refresh_token_expires_in
        ? {
            refreshExpires: this.now() + tokens.refresh_token_expires_in * 1000,
          }
        : {}),
    };
  }

  token(clientId: string): Promise<string> {
    const bundle = this.bundle();
    if (!bundle || bundle.clientId !== clientId)
      return Promise.reject(
        new TaskReadError("Sign in to GitHub first.", undefined, true),
      );
    if (!bundle.expires || bundle.expires > this.now() + 60_000)
      return Promise.resolve(bundle.access);
    if (
      !bundle.refresh ||
      (bundle.refreshExpires && bundle.refreshExpires <= this.now())
    )
      return Promise.reject(
        new TaskReadError(
          "GitHub authorization expired. Sign in again.",
          undefined,
          true,
        ),
      );
    if (this.refreshPending) return this.refreshPending;
    const revision = this.credentialRevision;
    const pending = (async () => {
      const raw = await this.oauth(
        "/login/oauth/access_token",
        {
          client_id: clientId,
          grant_type: "refresh_token",
          refresh_token: bundle.refresh!,
        },
        () => revision === this.credentialRevision,
      );
      if (revision !== this.credentialRevision)
        throw new RequestCancelledError();
      const tokens = tokenSchema.safeParse(raw);
      if (!tokens.success)
        throw new TaskReadError(
          "GitHub authorization expired. Sign in again.",
          undefined,
          true,
        );
      const current = this.bundle();
      if (
        current?.access !== bundle.access ||
        current.refresh !== bundle.refresh
      )
        throw new RequestCancelledError();
      const rotated = this.accepted(
        tokens.data,
        bundle.clientId,
        bundle.accountId,
        tokens.data.scope === undefined
          ? bundle.scopes
          : scopes(tokens.data.scope),
      );
      if (!rotated.refresh)
        throw new TaskReadError(
          "GitHub did not return a refresh token. Sign in again.",
          undefined,
          true,
        );
      this.storage().setSecret(`${this.key}-oauth`, JSON.stringify(rotated));
      return rotated.access;
    })().finally(() => {
      if (this.refreshPending === pending) this.refreshPending = undefined;
    });
    this.refreshPending = pending;
    return pending;
  }

  cancel() {
    this.generation++;
    this.controller?.abort();
    this.controller = undefined;
    this.loginPending = undefined;
    this.device.set(null);
  }

  disconnect() {
    this.credentialRevision++;
    this.cancel();
    this.storage().setSecret(`${this.key}-oauth`, "");
  }
}
