import type { App, Plugin } from "obsidian";

import { TaskService } from "./service";
import { TodoistProvider } from "./todoist";
import { TodoistAuth } from "./todoist-auth";

export function createTaskService(
  plugin: Plugin,
  writesEnabled: () => boolean = () => true,
  weakWritesEnabled: () => boolean = () => false,
) {
  let active = true;
  plugin.register(() => {
    active = false;
  });
  const path = `${plugin.manifest.dir ?? `${plugin.app.vault.configDir}/plugins/${plugin.manifest.id}`}/task-cache.json`;
  const adapter = plugin.app.vault.adapter;
  const statePath = path.replace(/task-cache\.json$/, "task-state.json");
  const checkpointPath = statePath.replace(/\.json$/, "-checkpoint.json");
  const secrets = Reflect.get(plugin.app, "secretStorage") as
    | App["secretStorage"]
    | undefined;
  let oauth: TodoistAuth | undefined;
  const auth = (): TodoistAuth =>
    (oauth ??= new TodoistAuth(plugin.app, service.connectionKey));
  plugin.register(() => oauth?.stop());
  const service: TaskService = new TaskService(
    {
      read: async () =>
        (await adapter.exists(path)) ? adapter.read(path) : null,
      write: (content) => adapter.write(path, content),
      readState: async () =>
        (await adapter.exists(statePath)) ? adapter.read(statePath) : null,
      writeState: (content) => adapter.write(statePath, content),
      readStateCheckpoint: async () =>
        (await adapter.exists(checkpointPath))
          ? adapter.read(checkpointPath)
          : null,
      writeStateCheckpoint: (content) => adapter.write(checkpointPath, content),
      backupState: async (content, version) => {
        const digest = await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(content),
        );
        const hash = Array.from(new Uint8Array(digest))
          .map((byte) => byte.toString(16).padStart(2, "0"))
          .join("")
          .slice(0, 20);
        const backupPath = statePath.replace(
          /\.json$/,
          `-v${version}-${hash}.backup.json`,
        );
        if (await adapter.exists(backupPath)) {
          if ((await adapter.read(backupPath)) !== content)
            throw new Error(
              "The saved task tracking backup changed. Preserve it before retrying.",
            );
        } else await adapter.write(backupPath, content);
      },
      getSecret: (key) => secrets?.getSecret(key) ?? null,
      setSecret: (key, value) => {
        if (!secrets)
          throw new Error("Task connections require Obsidian 1.11.4 or later.");
        secrets.setSecret(key, value);
      },
    },
    (token) =>
      new TodoistProvider(
        token,
        () => active,
        () => auth().token(token),
      ),
    writesEnabled,
    (write) => auth().connect(write),
    (token) => auth().commit(token),
    (token) => auth().discard(token),
    weakWritesEnabled,
  );
  return service;
}
