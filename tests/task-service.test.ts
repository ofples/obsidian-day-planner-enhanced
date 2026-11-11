import { get } from "svelte/store";
import { describe, expect, test, vi } from "vitest";

import { TaskService } from "../src/tasks/service";
import { TaskReadError, type TaskSnapshot } from "../src/tasks/types";

const snapshot: TaskSnapshot = {
  provider: "todoist",
  account: { id: "one", name: "Test", timezone: "UTC" },
  projects: [],
  tasks: [],
  fetchedAt: "2026-11-11T00:00:00Z",
};
async function setup() {
  let disk: string | null = null;
  let secret: string | null = null;
  let registry: string | null = null;
  const read = vi.fn(async () => structuredClone(snapshot));
  const storage = {
    read: async () => disk,
    readState: async () => registry,
    writeState: async (value: string) => {
      registry = value;
    },
    write: async (value: string) => {
      disk = value;
    },
    getSecret: () => secret,
    setSecret: (_key: string, value: string) => {
      secret = value;
    },
  };
  const service = new TaskService(storage, () => ({ read }));
  await service.initialize();
  return {
    service,
    read,
    storage,
    disk: () => disk,
    secret: () => secret,
    changeDisk: (value: string) => {
      disk = value;
    },
  };
}

describe("task snapshot lifecycle", () => {
  test("overlapping refreshes share one request and unload prevents late cache publication", async () => {
    const h = await setup();
    await h.service.connect("token");
    let finish!: (value: TaskSnapshot) => void;
    h.read.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const before = h.disk(),
      calls = h.read.mock.calls.length;
    const first = h.service.refresh(),
      second = h.service.refresh();
    expect(h.read).toHaveBeenCalledTimes(calls + 1);
    h.service.stop();
    finish({ ...snapshot, fetchedAt: "2026-11-12T00:00:00Z" });
    await Promise.all([first, second]);
    expect(h.disk()).toBe(before);
  });
  test("credentials stay outside cache and failed validation preserves the connection", async () => {
    const h = await setup();
    await h.service.connect("private-token");
    const before = h.disk();
    expect(before).not.toContain("private-token");
    h.read.mockRejectedValueOnce(new TaskReadError("Reconnect Todoist"));
    await expect(h.service.connect("bad-token")).rejects.toThrow("Reconnect");
    expect(h.secret()).toBe("private-token");
    expect(h.disk()).toBe(before);
    expect(get(h.service.state).snapshot).toEqual(snapshot);
  });
  test("a failed refresh retains its previous complete snapshot", async () => {
    const h = await setup();
    await h.service.connect("token");
    const before = h.disk();
    h.read.mockRejectedValueOnce(new Error("page two failed"));
    await h.service.refresh();
    expect(h.disk()).toBe(before);
    expect(get(h.service.state)).toMatchObject({ snapshot, loading: false });
    expect(get(h.service.state).error).toContain("Could not refresh");
  });
  test("disconnect while fetching prevents stale publication and re-connection", async () => {
    const h = await setup();
    await h.service.connect("token");
    let finish!: (value: TaskSnapshot) => void;
    h.read.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const before = h.disk();
    const pending = h.service.refresh();
    h.service.disconnect();
    finish({ ...snapshot, fetchedAt: "2026-11-12T00:00:00Z" });
    await pending;
    expect(h.disk()).toBe(before);
    expect(get(h.service.state).connected).toBe(false);
    expect(h.secret()).toBe("");
  });
  test("a new account requires an explicit switch and refresh cannot switch it", async () => {
    const h = await setup();
    await h.service.connect("token");
    h.read.mockResolvedValue({
      ...snapshot,
      account: { ...snapshot.account, id: "two", name: "Other" },
    });
    await expect(h.service.connect("new-token")).rejects.toThrow(
      "Switch account",
    );
    expect(h.secret()).toBe("token");
    await h.service.refresh();
    expect(get(h.service.state).snapshot?.account.id).toBe("one");
    await h.service.connect("new-token", true);
    expect(get(h.service.state).snapshot?.account.id).toBe("two");
  });
  test("cache can be reloaded offline and unexpected writers stop saves", async () => {
    const h = await setup();
    await h.service.connect("token");
    const restored = new TaskService(h.storage, () => ({ read: h.read }));
    await restored.initialize();
    expect(get(restored.state).snapshot).toEqual(snapshot);
    h.changeDisk("changed elsewhere");
    await h.service.refresh();
    expect(h.disk()).toBe("changed elsewhere");
    expect(get(h.service.state).error).toContain("another session");
  });
  test("rate limits coalesce refresh requests and stop prevents publication", async () => {
    const h = await setup();
    await h.service.connect("token");
    const retryAt = Date.now() + 60000;
    h.read.mockRejectedValueOnce(new TaskReadError("Wait", retryAt));
    await h.service.refresh();
    const calls = h.read.mock.calls.length;
    await h.service.refresh();
    expect(h.read).toHaveBeenCalledTimes(calls);
    h.service.stop();
    await h.service.refresh();
    expect(h.read).toHaveBeenCalledTimes(calls);
  });
});
