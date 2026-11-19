import type { RequestUrlResponse } from "obsidian";

import type { SourceRateLimit } from "./source-http";

/** GraphQL may report rate limiting inside an otherwise successful HTTP response. */
export function githubRateLimit(response: RequestUrlResponse): SourceRateLimit {
  const headers = new Map(
    Object.entries(response.headers).map(([name, value]) => [
      name.toLowerCase(),
      value,
    ]),
  );
  let graphLimit = false;
  try {
    const body = response.json as unknown;
    if (
      body &&
      typeof body === "object" &&
      "errors" in body &&
      Array.isArray(body.errors)
    )
      graphLimit = body.errors.some((error: unknown) =>
        Boolean(
          error &&
            typeof error === "object" &&
            "type" in error &&
            error.type === "RATE_LIMITED",
        ),
      );
  } catch {
    /* An HTTP error can have no JSON body. */
  }
  const limited =
    graphLimit ||
    response.status === 429 ||
    (response.status === 403 &&
      (headers.get("x-ratelimit-remaining") === "0" ||
        headers.has("retry-after")));
  if (!limited) return { limited: false };
  const supplied = headers.get("retry-after");
  if (supplied) return { limited, retryAfter: supplied };
  const reset = Number(headers.get("x-ratelimit-reset"));
  return {
    limited,
    retryAfter: String(
      Number.isFinite(reset) && reset > 0
        ? Math.max(1, Math.ceil(reset - Date.now() / 1000))
        : 60,
    ),
  };
}
