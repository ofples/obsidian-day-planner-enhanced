/** A shared serial request gate. Cooldowns fail fast so callers do not accumulate
 * long-lived waiters or silently replay mutations. */
export class RequestCooldownError extends Error {
  constructor(
    readonly retryAt: number | undefined,
    readonly status?: number,
    readonly circuitOpen = false,
    readonly permanent = false,
  ) {
    super("Provider request is in backoff.");
  }
}

export function retryAfterAt(value: string | undefined, now: number) {
  if (!value?.trim()) return undefined;
  const text = value.trim();
  if (/^\d+(?:\.\d+)?$/.test(text)) {
    const seconds = Number(text);
    const deadline = now + seconds * 1000;
    return Number.isFinite(seconds) && Number.isFinite(deadline)
      ? deadline
      : undefined;
  }
  if (/^[+-]?\d+(?:\.\d+)?$/.test(text)) return undefined;
  const date = Date.parse(text);
  return Number.isFinite(date) ? Math.max(now, date) : undefined;
}

/** Queued work is abandoned when its owning plugin unloads. */
export class RequestCancelledError extends Error {
  constructor() {
    super("Provider request was cancelled because the plugin was unloaded.");
  }
}

/** A nested token request received a transient HTTP response. */
export class RequestTransientError extends Error {
  constructor(
    readonly status: number,
    readonly retryAfter?: string,
  ) {
    super("Provider token request is temporarily unavailable.");
  }
}

/** A rejected credential is not a transient transport failure. */
export class RequestPermanentError extends Error {
  constructor(
    readonly original: unknown,
    readonly status?: number,
  ) {
    super("Permanent provider authorization failure.");
  }
}

type ResponseMetadata = { status: number; headers: Record<string, string> };

export class RequestGate {
  private tail: Promise<void> = Promise.resolve();
  private queued = 0;
  private nextStart = 0;
  private cooldownUntil = 0;
  private readonly failureCounts = new Map<string, number>();
  private cooldownStatus?: number;
  private circuitOpen = false;
  private permanentPaused = false;

  constructor(private readonly spacingMs = 1000) {}

  private checkCooldown() {
    if (this.cooldownUntil > Date.now() || this.circuitOpen)
      throw new RequestCooldownError(
        this.cooldownUntil > Date.now() ? this.cooldownUntil : undefined,
        this.cooldownStatus,
        this.circuitOpen,
        this.permanentPaused,
      );
  }

  /** Explicit user retry may close the circuit only after the server deadline. */
  resetForUserRetry() {
    if (this.cooldownUntil > Date.now()) return false;
    this.circuitOpen = false;
    this.failureCounts.clear();
    this.permanentPaused = false;
    return true;
  }

  private backoff(key: string, status: number | undefined, value?: string) {
    const failures = (this.failureCounts.get(key) ?? 0) + 1;
    this.failureCounts.set(key, failures);
    if (failures >= 5) this.circuitOpen = true;
    const now = Date.now();
    const fallback = Math.min(300_000, 1000 * 2 ** Math.min(failures - 1, 9));
    const supplied = retryAfterAt(value, now);
    this.cooldownUntil = Math.max(
      this.cooldownUntil,
      supplied ?? now + fallback,
    );
    this.cooldownStatus = status;
    return this.cooldownUntil;
  }

  run<T extends ResponseMetadata>(
    send: () => Promise<T>,
    isTransient: (response: T) => boolean = () => false,
    canStart: () => boolean = () => true,
    key = "default",
    isPermanent: (response: T) => boolean = () => false,
  ): Promise<{ response: T; retryAt?: number }> {
    if (this.queued >= 64)
      return Promise.reject(
        new RequestCooldownError(Math.max(this.nextStart, Date.now() + 1000)),
      );
    this.queued++;
    const operation = this.tail.then(async () => {
      if (!canStart()) throw new RequestCancelledError();
      this.checkCooldown();
      const delay = this.nextStart - Date.now();
      if (delay > 0)
        await new Promise<void>((resolve) => setTimeout(resolve, delay));
      if (!canStart()) throw new RequestCancelledError();
      this.checkCooldown();
      this.nextStart = Date.now() + this.spacingMs;
      let response: T;
      try {
        response = await send();
      } catch (error) {
        if (error instanceof RequestPermanentError) {
          this.circuitOpen = true;
          this.permanentPaused = true;
          this.cooldownStatus = error.status;
          throw error.original;
        }
        if (error instanceof RequestCancelledError) throw error;
        if (error instanceof RequestTransientError)
          throw new RequestCooldownError(
            this.backoff("oauth:token", error.status, error.retryAfter),
            error.status,
          );
        throw new RequestCooldownError(this.backoff(key, undefined));
      }
      if (
        response.status === 429 ||
        response.status >= 500 ||
        isTransient(response)
      ) {
        const retry = Object.entries(response.headers).find(
          ([name]) => name.toLowerCase() === "retry-after",
        )?.[1];
        return { response, retryAt: this.backoff(key, response.status, retry) };
      }
      if (isPermanent(response)) {
        this.circuitOpen = true;
        this.permanentPaused = true;
        this.cooldownStatus = response.status;
      }
      if (response.status >= 200 && response.status < 400)
        this.failureCounts.delete(key);
      return { response };
    });
    this.tail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation.finally(() => {
      this.queued--;
    });
  }
}

const todoistGates = new Map<string, RequestGate>();
const googleGates = new WeakMap<object, RequestGate>();

export function todoistRequestGate(credential: string) {
  let gate = todoistGates.get(credential);
  if (!gate) todoistGates.set(credential, (gate = new RequestGate()));
  return gate;
}

export function googleRequestGate(connection: object) {
  let gate = googleGates.get(connection);
  if (!gate) googleGates.set(connection, (gate = new RequestGate()));
  return gate;
}
