import { derived, get, type Readable, type Writable } from "svelte/store";

import type { DayPlannerSettings } from "../settings";

import type { GitHubBackend } from "./github-backend";
import type { TaskBrowserState, TaskService } from "./service";
import { resolveSourceTask } from "./source-references";
import type { TaskSourceSession } from "./source-session";
import type { TaskSourceReference } from "./source-types";
import { TaskReadError, type TaskSnapshot } from "./types";

/** A read bridge over the existing Todoist owner and two independent source sessions. */
export class TaskSourceCollection {
  readonly snapshots: Readable<TaskSnapshot[]>;
  readonly googleBrowser: Readable<TaskBrowserState>;
  readonly githubBrowser: Readable<TaskBrowserState>;

  constructor(
    readonly todoist: TaskService,
    readonly googleTasks: TaskSourceSession,
    readonly github: TaskSourceSession,
    readonly githubBackend: GitHubBackend,
    readonly settings: Writable<DayPlannerSettings>,
  ) {
    const browser = (session: TaskSourceSession): Readable<TaskBrowserState> =>
      derived([session.state, settings], ([state, prefs]) => {
        const account = session.accountId();
        const connected =
          state.connected &&
          session.isConnected() &&
          (!account ||
            !state.snapshot ||
            state.snapshot.account.id === account);
        return {
          ...state,
          connected,
          snapshot: !connected
            ? null
            : state.snapshot &&
                session.provider === "github" &&
                !prefs.taskSources.github.includePrivate
              ? {
                  ...state.snapshot,
                  tasks: state.snapshot.tasks.filter(
                    (task) => !task.source?.private,
                  ),
                }
              : state.snapshot &&
                  session.provider === "google-tasks" &&
                  !prefs.taskSources.googleTasks.allowCompletion
                ? {
                    ...state.snapshot,
                    account: {
                      ...state.snapshot.account,
                      capabilities: {
                        ...state.snapshot.account.capabilities,
                        complete: false,
                      },
                    },
                  }
                : state.snapshot,
          readOnly: true,
          writable: false,
          operations: [],
          completed: [],
          aliases: {},
        };
      });
    this.googleBrowser = browser(googleTasks);
    this.githubBrowser = browser(github);
    this.snapshots = derived(
      [todoist.state, this.googleBrowser, this.githubBrowser],
      (states) =>
        states.flatMap((state) =>
          state.connected && state.snapshot ? [state.snapshot] : [],
        ),
    );
  }

  browser(provider: string): Readable<TaskBrowserState> {
    return provider === "google-tasks"
      ? this.googleBrowser
      : provider === "github"
        ? this.githubBrowser
        : this.todoist.state;
  }

  session(provider: string) {
    return provider === "google-tasks"
      ? this.googleTasks
      : provider === "github"
        ? this.github
        : undefined;
  }
  snapshot(provider: string) {
    return get(this.browser(provider)).snapshot;
  }
  resolve(ref: TaskSourceReference) {
    return resolveSourceTask(get(this.snapshots), ref);
  }

  refresh(provider: string, manual = false, more = false) {
    return (
      this.session(provider)?.refresh(manual, more) ??
      this.todoist.refresh(manual)
    );
  }

  complete(ref: TaskSourceReference) {
    if (!this.resolve(ref))
      return Promise.reject(
        new TaskReadError(
          "This task's source account changed. Refresh the pane.",
        ),
      );
    const session = this.session(ref.provider);
    return session
      ? session.complete(ref)
      : Promise.reject(
          new TaskReadError("Use the Todoist action to complete this task."),
        );
  }

  async initialize() {
    await Promise.all([
      this.googleTasks.initialize(),
      this.github.initialize(),
    ]);
  }
  stop() {
    this.googleTasks.stop();
    this.github.stop();
  }
}
