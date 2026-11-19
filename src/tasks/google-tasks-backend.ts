import type { App } from "obsidian";
import { z } from "zod";

import {
  GoogleCalendarAuth,
  GoogleTokenError,
  googleQuotaError,
} from "../google-calendar/auth";
import { type GoogleAppConfig } from "../google-calendar/client";
import {
  RequestCancelledError,
  RequestGate,
  RequestPermanentError,
  RequestTransientError,
} from "../service/request-gate";

import { GoogleTasksProvider, type GoogleTasksSelection } from "./google-tasks";
import { TaskSourceHttp } from "./source-http";
import type { SourceReadResult, TaskSourceBackend } from "./source-session";
import { TaskReadError, type ProviderTask } from "./types";

export const googleTasksReadScope =
  "https://www.googleapis.com/auth/tasks.readonly";
export const googleTasksEditScope = "https://www.googleapis.com/auth/tasks";
const profileSchema = z.object({
  sub: z.string().min(1),
  email: z.string().optional(),
  name: z.string().optional(),
});

/** Shares Google's loopback flow, but owns independent credentials and consent. */
export class GoogleTasksBackend implements TaskSourceBackend {
  readonly auth: GoogleCalendarAuth;
  readonly gate = new RequestGate();
  private generation = 0;

  constructor(
    app: App,
    key: string,
    private readonly registration: () => GoogleAppConfig | null,
    private readonly selection: () => GoogleTasksSelection,
    private readonly timezone: () => string,
  ) {
    this.auth = new GoogleCalendarAuth(
      app,
      key,
      (id) => {
        const config = this.registration();
        return config?.clientId === id ? config.clientSecret : undefined;
      },
      "Google Tasks",
    );
  }

  connected() {
    return this.auth.isConnected(this.registration()?.clientId);
  }

  private app() {
    const config = this.registration();
    if (!config?.clientId)
      throw new TaskReadError(
        "Google app configuration is unavailable. Check the Google connection settings.",
      );
    return config;
  }

  private async provider(access?: string, granted?: readonly string[]) {
    const generation = this.generation;
    const config = this.app();
    const canStart = () => generation === this.generation;
    const token = async () => {
      if (access) return access;
      try {
        return await this.auth.token(config.clientId);
      } catch (error) {
        if (!(error instanceof GoogleTokenError)) throw error;
        if (error.quota || error.status === 429 || error.status >= 500)
          throw new RequestTransientError(error.status, error.retryAfter);
        throw new RequestPermanentError(
          new TaskReadError(error.message, undefined, true, error.status),
          error.status,
        );
      }
    };
    const profileHttp = new TaskSourceHttp(
      "https://openidconnect.googleapis.com",
      "Google Tasks",
      token,
      this.gate,
      canStart,
    );
    const profile = profileSchema.parse(
      await profileHttp.request("/v1/userinfo"),
    );
    if (!canStart()) throw new RequestCancelledError();
    const http = new TaskSourceHttp(
      "https://tasks.googleapis.com",
      "Google Tasks",
      token,
      this.gate,
      canStart,
      (response) => ({
        limited: response.status === 403 && googleQuotaError(response.json),
      }),
    );
    const scopes = granted ?? this.auth.grantedScopes();
    return new GoogleTasksProvider(
      http.request,
      {
        id: profile.sub,
        name: profile.name ?? profile.email ?? "Google account",
        timezone: this.timezone(),
      },
      () => ({
        ...this.selection(),
        allowCompletion:
          this.selection().allowCompletion &&
          scopes.includes(googleTasksEditScope),
      }),
    );
  }

  async connect(): Promise<SourceReadResult> {
    const config = this.app();
    this.gate.resetForUserRetry();
    const scope = this.selection().allowCompletion
      ? googleTasksEditScope
      : googleTasksReadScope;
    let staged: SourceReadResult | undefined;
    await this.auth.connect(config.clientId, {
      scopes: ["openid", "email", scope],
      validate: async (access, granted) => {
        if (!granted.includes(scope))
          throw new TaskReadError(
            "Google did not grant the requested Tasks access. Sign in again and allow it.",
          );
        const provider = await this.provider(access, granted);
        staged = await provider.read();
      },
    });
    if (!staged)
      throw new TaskReadError("Google Tasks sign-in did not finish.");
    return staged;
  }

  async read(previous?: SourceReadResult) {
    return (await this.provider()).read(previous);
  }

  retry() {
    this.gate.resetForUserRetry();
  }

  async complete(task: ProviderTask) {
    return (await this.provider()).complete(task);
  }
  async get(task: ProviderTask) {
    return (await this.provider()).get(task);
  }

  disconnect() {
    this.generation++;
    this.auth.disconnect();
  }

  cancel() {
    this.generation++;
    this.auth.stop();
  }
}
