import type { Plugin } from "obsidian";
import { expect, test, vi } from "vitest";

vi.mock("obsidian", async (load) => ({
  ...(await load<typeof import("obsidian")>()),
  requestUrl: vi.fn(async () => {
    throw new Error("This cache check must not contact a provider.");
  }),
}));

import { GoogleTasksBackend } from "../src/tasks/google-tasks-backend";
import { createTaskSources } from "../src/tasks/source-obsidian";

import { taskSourcesFixture } from "./util/task-sources";

test("installed source caches are ignored before task data is written", async () => {
  const h = await taskSourcesFixture();
  const files = new Map([["plugins/test/.gitignore", "existing-rule\n"]]);
  const written: string[] = [];
  const plugin = {
    manifest: { id: "day-planner-enhanced", dir: "plugins/test" },
    register: () => {},
    app: {
      vault: {
        configDir: ".obsidian",
        adapter: {
          exists: async (path: string) => files.has(path),
          read: async (path: string) => files.get(path) ?? "",
          write: async (path: string, value: string) => {
            written.push(path);
            files.set(path, value);
          },
        },
      },
    },
  } as unknown as Plugin;
  vi.spyOn(GoogleTasksBackend.prototype, "connected").mockReturnValue(true);
  vi.spyOn(GoogleTasksBackend.prototype, "accountId").mockReturnValue(
    h.googleSnapshot.account.id,
  );
  vi.spyOn(GoogleTasksBackend.prototype, "read").mockResolvedValue({
    snapshot: h.googleSnapshot,
    coverage: { complete: true, streams: [] },
  });
  const sources = createTaskSources(plugin, h.service, h.settings, () => null);
  try {
    await sources.initialize();
    await sources.googleTasks.refresh(true);
    expect(written).toEqual([
      "plugins/test/.gitignore",
      "plugins/test/source-cache-google-tasks.json",
    ]);
    expect(files.get("plugins/test/.gitignore")).toBe(
      "existing-rule\nsource-cache-*.json\n",
    );
    expect(
      JSON.parse(files.get("plugins/test/source-cache-google-tasks.json")!)
        .snapshot.provider,
    ).toBe("google-tasks");
  } finally {
    sources.stop();
    vi.restoreAllMocks();
  }
});
