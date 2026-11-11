import type { App, Plugin } from "obsidian";

import { TaskService } from "./service";
import { TodoistProvider } from "./todoist";

export function createTaskService(plugin: Plugin) {
  const path = `${plugin.manifest.dir ?? `${plugin.app.vault.configDir}/plugins/${plugin.manifest.id}`}/task-cache.json`;
  const adapter = plugin.app.vault.adapter;
  const secrets = Reflect.get(plugin.app, "secretStorage") as
    | App["secretStorage"]
    | undefined;
  return new TaskService(
    {
      read: async () =>
        (await adapter.exists(path)) ? adapter.read(path) : null,
      write: (content) => adapter.write(path, content),
      getSecret: (key) => secrets?.getSecret(key) ?? null,
      setSecret: (key, value) => {
        if (!secrets)
          throw new Error("Task connections require Obsidian 1.11.4 or later.");
        secrets.setSecret(key, value);
      },
    },
    (token) => new TodoistProvider(token),
  );
}
