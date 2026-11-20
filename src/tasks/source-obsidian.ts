import type { Plugin } from "obsidian";
import { get, type Writable } from "svelte/store";
import { z } from "zod";

import type { GoogleAppConfig } from "../google-calendar/client";
import type { DayPlannerSettings } from "../settings";

import { GitHubBackend } from "./github-backend";
import { githubClientId } from "./github-client";
import { GoogleTasksBackend } from "./google-tasks-backend";
import type { TaskService } from "./service";
import { TaskSourceCollection } from "./source-collection";
import {
  TaskSourceSession,
  type TaskSourceCacheStorage,
} from "./source-session";
import { taskSnapshotSchema } from "./types";

const cacheSchema = z.object({
  version: z.literal(1),
  snapshot: taskSnapshotSchema,
  coverage: z.object({
    complete: z.boolean(),
    streams: z.array(
      z.object({
        id: z.string(),
        containerId: z.string().optional(),
        complete: z.boolean(),
        cursor: z.string().optional(),
        error: z.string().optional(),
      }),
    ),
    unavailableItems: z.number().optional(),
  }),
  verificationRequired: z.array(z.string()).default([]),
});

export function createTaskSources(
  plugin: Plugin,
  todoist: TaskService,
  settings: Writable<DayPlannerSettings>,
  googleRegistration: () => GoogleAppConfig | null,
) {
  const namespace = todoist.registry.snapshot().namespace;
  const timezone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
  const directory =
    plugin.manifest.dir ??
    `${plugin.app.vault.configDir}/plugins/${plugin.manifest.id}`;
  let ignoreReady: Promise<void> | undefined;
  const ensureCacheIgnored = () =>
    (ignoreReady ??= (async () => {
      const path = `${directory}/.gitignore`;
      const before = (await plugin.app.vault.adapter.exists(path))
        ? await plugin.app.vault.adapter.read(path)
        : "";
      if (!before.split(/\r?\n/).includes("source-cache-*.json"))
        await plugin.app.vault.adapter.write(
          path,
          `${before}${before && !before.endsWith("\n") ? "\n" : ""}source-cache-*.json\n`,
        );
    })().catch((error: unknown) => {
      ignoreReady = undefined;
      throw error;
    }));
  const storage = (provider: string): TaskSourceCacheStorage => {
    const path = `${directory}/source-cache-${provider}.json`;
    return {
      read: async () =>
        (await plugin.app.vault.adapter.exists(path))
          ? cacheSchema
              .nullable()
              .parse(JSON.parse(await plugin.app.vault.adapter.read(path)))
          : null,
      write: async (value) => {
        await ensureCacheIgnored();
        return plugin.app.vault.adapter.write(
          path,
          value ? JSON.stringify({ version: 1, ...value }) : "null",
        );
      },
    };
  };
  const googleBackend = new GoogleTasksBackend(
    plugin.app,
    `dp-gtasks-${namespace}`,
    googleRegistration,
    () => get(settings).taskSources.googleTasks,
    timezone,
  );
  const githubBackend = new GitHubBackend(
    plugin.app,
    `dp-github-${namespace}`,
    () => ({
      clientId: githubClientId(get(settings).taskSources.github),
      includePrivate: get(settings).taskSources.github.includePrivate,
    }),
    () => get(settings).taskSources.github,
    timezone,
  );
  const collection = new TaskSourceCollection(
    todoist,
    new TaskSourceSession(
      "google-tasks",
      googleBackend,
      storage("google-tasks"),
    ),
    new TaskSourceSession("github", githubBackend, storage("github")),
    githubBackend,
    settings,
  );
  plugin.register(() => collection.stop());
  return collection;
}
