import type { App } from "obsidian";
import { z } from "zod";

import {
  RequestCancelledError,
  RequestGate,
  RequestPermanentError,
  RequestTransientError,
} from "../service/request-gate";

import { GitHubProvider } from "./github";
import { GitHubAuth } from "./github-auth";
import type { GitHubSelection } from "./github-config";
import { githubRateLimit } from "./github-rate-limit";
import { TaskSourceHttp } from "./source-http";
import type { SourceReadResult, TaskSourceBackend } from "./source-session";
import { TaskReadError } from "./types";

const userSchema = z.object({
  node_id: z.string().min(1),
  login: z.string().min(1),
  name: z.string().nullable().optional(),
});

export class GitHubBackend implements TaskSourceBackend {
  readonly auth: GitHubAuth;
  readonly gate = new RequestGate();
  private generation = 0;

  constructor(
    app: App,
    key: string,
    private readonly registration: () => {
      clientId: string;
      includePrivate: boolean;
    },
    private readonly selection: () => GitHubSelection,
    private readonly timezone: () => string,
  ) {
    this.auth = new GitHubAuth(app, key);
  }

  connected() {
    return this.auth.connected(this.registration().clientId);
  }
  accountId() {
    return this.auth.accountId();
  }

  private async provider(access?: string) {
    const generation = this.generation;
    const clientId = this.registration().clientId;
    const token = async () => {
      if (access) return access;
      try {
        return await this.auth.token(clientId);
      } catch (error) {
        if (!(error instanceof TaskReadError)) throw error;
        if (error.needsReconnect)
          throw new RequestPermanentError(error, error.status);
        if (error.status === 429 || (error.status && error.status >= 500))
          throw new RequestTransientError(
            error.status,
            error.retryAt
              ? String(Math.max(0, (error.retryAt - Date.now()) / 1000))
              : undefined,
          );
        throw error;
      }
    };
    const http = new TaskSourceHttp(
      "https://api.github.com",
      "GitHub",
      token,
      this.gate,
      () => generation === this.generation,
      githubRateLimit,
    );
    const user = userSchema.parse(await http.request("/user"));
    if (generation !== this.generation) throw new RequestCancelledError();
    return {
      provider: new GitHubProvider(
        http.request,
        {
          id: user.node_id,
          name: user.name ?? user.login,
          timezone: this.timezone(),
        },
        user.login,
        this.selection,
        () => this.registration().includePrivate,
      ),
      accountId: user.node_id,
    };
  }

  async connect(): Promise<SourceReadResult> {
    this.generation++;
    const config = this.registration();
    this.gate.resetForUserRetry();
    let staged: SourceReadResult | undefined;
    await this.auth.connect(
      config.clientId,
      config.includePrivate,
      async (access) => {
        const { provider, accountId } = await this.provider(access);
        staged = await provider.read();
        return accountId;
      },
    );
    if (!staged) throw new TaskReadError("GitHub sign-in did not finish.");
    return staged;
  }

  async read(previous?: SourceReadResult) {
    return (await this.provider()).provider.read(previous);
  }
  async discoverProjects() {
    return (await this.provider()).provider.discoverProjects();
  }
  async lookupProject(url: string) {
    return (await this.provider()).provider.lookupProject(url);
  }
  retry() {
    this.gate.resetForUserRetry();
  }
  disconnect() {
    this.generation++;
    this.auth.disconnect();
  }
  cancel() {
    this.generation++;
    this.auth.cancel();
  }
}
