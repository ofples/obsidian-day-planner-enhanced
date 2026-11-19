import {
  requestUrl,
  type RequestUrlParam,
  type RequestUrlResponse,
} from "obsidian";

import {
  RequestCancelledError,
  RequestCooldownError,
  RequestGate,
} from "../service/request-gate";

import { TaskReadError } from "./types";

export type SourceRequest = (
  path: string,
  options?: { method: "PATCH" | "POST"; body: unknown },
) => Promise<unknown>;

export interface SourceRateLimit {
  limited: boolean;
  retryAfter?: string;
}

export class TaskSourceHttp {
  constructor(
    private readonly origin: string,
    private readonly label: string,
    private readonly token: () => Promise<string>,
    readonly gate = new RequestGate(),
    private readonly canStart: () => boolean = () => true,
    private readonly rateLimit: (
      response: RequestUrlResponse,
    ) => SourceRateLimit = () => ({ limited: false }),
    private readonly send: (
      request: RequestUrlParam,
    ) => Promise<RequestUrlResponse> = requestUrl,
  ) {}

  readonly request: SourceRequest = async (path, options) => {
    if (!path.startsWith("/") || path.startsWith("//"))
      throw new Error("A source request needs a relative API path.");
    const url = new URL(path, this.origin);
    if (url.origin !== new URL(this.origin).origin)
      throw new Error("The source API origin changed.");
    let response: RequestUrlResponse;
    let retryAt: number | undefined;
    try {
      const result = await this.gate.run(
        async () => {
          const token = await this.token();
          if (!this.canStart()) throw new RequestCancelledError();
          const value = await this.send({
            url: url.toString(),
            method: options?.method ?? "GET",
            headers: {
              Authorization: `Bearer ${token}`,
              Accept: "application/json",
              ...(url.hostname === "api.github.com"
                ? { "X-GitHub-Api-Version": "2022-11-28" }
                : {}),
            },
            ...(options
              ? {
                  contentType: "application/json",
                  body: JSON.stringify(options.body),
                }
              : {}),
            throw: false,
          });
          const limit = this.rateLimit(value);
          return limit.limited
            ? {
                ...value,
                status: 429,
                headers: {
                  ...value.headers,
                  ...(limit.retryAfter
                    ? { "retry-after": limit.retryAfter }
                    : {}),
                },
              }
            : value;
        },
        undefined,
        this.canStart,
        `${options?.method ?? "GET"} ${url.pathname}`,
        (value) => value.status === 401,
      );
      response = result.response;
      retryAt = result.retryAt;
    } catch (error) {
      if (!(error instanceof RequestCooldownError)) throw error;
      throw new TaskReadError(
        error.permanent
          ? `Reconnect ${this.label} to continue.`
          : error.circuitOpen
            ? `${this.label} requests are paused after repeated failures. Use Refresh when ready.`
            : `${this.label} is busy. Refresh after the cooldown.`,
        error.retryAt,
        error.permanent,
        error.status,
      );
    }
    if (!this.canStart()) throw new RequestCancelledError();
    if (response.status < 200 || response.status >= 300)
      throw new TaskReadError(
        response.status === 401
          ? `Reconnect ${this.label} to continue.`
          : response.status === 403
            ? `${this.label} denied access to this source. Check its permissions or organization approval.`
            : response.status === 429
              ? `${this.label} requests are limited. Refresh after the cooldown.`
              : `${this.label} could not finish this request (${response.status}). Cached work is still available.`,
        retryAt,
        response.status === 401,
        response.status,
      );
    return response.json as unknown;
  };
}
