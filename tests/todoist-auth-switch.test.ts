import { expect, test, vi } from "vitest";
import { TaskService } from "../src/tasks/service";
import type { TaskSnapshot } from "../src/tasks/types";

test("rejected account switch never commits staged credentials", async () => {
  let cache: string | null = null,
    state: string | null = null,
    secret = "";
  const storage = {
    read: async () => cache,
    write: async (value: string) => {
      cache = value;
    },
    readState: async () => state,
    writeState: async (value: string) => {
      state = value;
    },
    getSecret: () => secret,
    setSecret: (_key: string, value: string) => {
      secret = value;
    },
  };
  const snapshot = (id: string): TaskSnapshot => ({
    provider: "todoist",
    account: { id, name: id, timezone: "UTC" },
    projects: [],
    tasks: [],
    fetchedAt: "2026-11-11T00:00:00Z",
  });
  const commit = vi.fn(() => vi.fn()),
    discard = vi.fn();
  const service = new TaskService(
    storage,
    (token) => ({
      read: async () => snapshot(token === "old-token" ? "old" : "new"),
    }),
    () => false,
    async () => "new-token",
    commit,
    discard,
  );
  await service.initialize();
  await service.connect("old-token");
  await expect(service.signIn()).rejects.toThrow("Switch account");
  expect(secret).toBe("old-token");
  expect(commit).not.toHaveBeenCalled();
  expect(discard).toHaveBeenCalledExactlyOnceWith("new-token");
  await service.signIn(true);
  expect(commit).toHaveBeenCalledExactlyOnceWith("new-token");
  expect(secret).toBe("new-token");
  service.stop();
});
