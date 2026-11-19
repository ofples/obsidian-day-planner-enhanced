import { get } from "svelte/store";
import { describe, expect, test, vi } from "vitest";

import { SourceActionRejectedError } from "../src/tasks/source-errors";
import { SourcePageBudget, readSourcePages } from "../src/tasks/source-pages";
import { taskSourceReference } from "../src/tasks/source-references";
import {
  TaskSourceSession,
  type SourceReadResult,
  type TaskSourceBackend,
  type TaskSourceCacheStorage,
} from "../src/tasks/source-session";
import type { ProviderTask } from "../src/tasks/types";

const task = (id: string): ProviderTask => ({
  id,
  title: id,
  description: "",
  projectId: "work",
  parentId: null,
  labels: [],
  priority: 1,
  completed: false,
  order: 0,
  due: null,
});
const result = (accountId = "account"): SourceReadResult => ({
  snapshot: {
    provider: "google-tasks",
    account: {
      id: accountId,
      name: "Test",
      timezone: "UTC",
      capabilities: { complete: true },
    },
    projects: [{ id: "work", name: "Work", order: 0 }],
    tasks: [task("item")],
    fetchedAt: new Date().toISOString(),
  },
  coverage: {
    complete: true,
    streams: [{ id: "list:work", containerId: "work", complete: true }],
  },
});
function fixture() {
  const storage: TaskSourceCacheStorage = {
    read: vi.fn(async () => null),
    write: vi.fn(async () => {}),
  };
  const backend: TaskSourceBackend = {
    connected: () => true,
    connect: vi.fn(async () => result()),
    read: vi.fn(async () => result()),
    disconnect: vi.fn(),
    cancel: vi.fn(),
    complete: vi.fn(async (value) => ({ ...value, completed: true })),
    get: vi.fn(async () => ({ ...task("item"), completed: true })),
  };
  return {
    backend,
    storage,
    session: new TaskSourceSession("google-tasks", backend, storage),
  };
}

describe("task source sessions", () => {
  test("confirmed completion refreshes once for child state or a following instance", async () => {
    const { backend, session } = fixture();
    Object.assign(backend, { refreshAfterCompletion: true });
    await session.connect();
    const snapshot = get(session.state).snapshot!;
    backend.read = vi.fn(async () => ({
      ...result(),
      snapshot: { ...result().snapshot, tasks: [task("next-instance")] },
    }));
    await session.complete(taskSourceReference(snapshot, snapshot.tasks[0]!));
    expect(backend.complete).toHaveBeenCalledTimes(1);
    expect(backend.read).toHaveBeenCalledTimes(1);
    expect(get(session.state).snapshot?.tasks[0]?.id).toBe("next-instance");
    await session.refresh();
    expect(backend.read).toHaveBeenCalledTimes(1);
  });
  test("a cached snapshot from another credential account is not published on startup", async () => {
    const { backend, storage, session } = fixture();
    backend.accountId = () => "new-account";
    storage.read = async () => ({
      ...result("old-account"),
      verificationRequired: [],
    });
    await session.initialize();
    expect(get(session.state).connected).toBe(true);
    expect(get(session.state).snapshot).toBeNull();
  });
  test("refresh is single flight, fresh opening reads cache, and failed reads keep last good data", async () => {
    const { backend, session } = fixture();
    await session.connect();
    await session.refresh();
    expect(backend.read).not.toHaveBeenCalled();
    let reject!: (reason: Error) => void;
    backend.read = vi.fn(
      () =>
        new Promise<SourceReadResult>((_, fail) => {
          reject = fail;
        }),
    );
    const first = session.refresh(true);
    const second = session.refresh(true);
    await Promise.resolve();
    expect(backend.read).toHaveBeenCalledTimes(1);
    reject(new Error("Offline"));
    await Promise.all([first, second]);
    expect(get(session.state).snapshot?.tasks[0]?.id).toBe("item");
    expect(get(session.state).error).toBe("Offline");
  });

  test("partial container reads retain cached rows and a complete read can remove them", async () => {
    const { backend, session } = fixture();
    await session.connect();
    backend.read = async () => ({
      snapshot: { ...result().snapshot, tasks: [] },
      coverage: {
        complete: false,
        streams: [
          {
            id: "list:work",
            containerId: "work",
            complete: false,
            error: "Denied",
          },
        ],
      },
    });
    await session.refresh(true);
    expect(get(session.state).snapshot?.tasks).toHaveLength(1);
    backend.read = async () => ({
      ...result(),
      snapshot: { ...result().snapshot, tasks: [] },
    });
    await session.refresh(true);
    expect(get(session.state).snapshot?.tasks).toHaveLength(0);
  });

  test("late old-account responses cannot overwrite a new connection or its cache", async () => {
    const { backend, storage, session } = fixture();
    await session.connect();
    let finish!: (value: SourceReadResult) => void;
    backend.read = () =>
      new Promise((resolve) => {
        finish = resolve;
      });
    const old = session.refresh(true);
    await Promise.resolve();
    await session.disconnect();
    backend.connect = async () => result("new-account");
    await session.connect();
    finish(result("account"));
    await old;
    expect(get(session.state).snapshot?.account.id).toBe("new-account");
    expect(
      vi.mocked(storage.write).mock.calls.at(-1)?.[0]?.snapshot.account.id,
    ).toBe("new-account");
    expect(get(session.state).loading).toBe(false);
  });

  test("an uncertain completion is persisted and verified instead of replayed", async () => {
    const { backend, storage, session } = fixture();
    await session.connect();
    const snapshot = get(session.state).snapshot!;
    const ref = taskSourceReference(snapshot, snapshot.tasks[0]!);
    backend.complete = vi.fn(async () => {
      throw new Error("Lost response");
    });
    await session.complete(ref);
    expect(get(session.state).verificationRequired).toEqual(["item"]);
    expect(get(session.state).snapshot?.tasks[0]?.completed).toBe(false);
    expect(
      vi
        .mocked(storage.write)
        .mock.calls.some(([value]) =>
          value?.verificationRequired.includes("item"),
        ),
    ).toBe(true);
    await session.refresh(true);
    expect(backend.complete).toHaveBeenCalledTimes(1);
    await session.complete(ref);
    expect(backend.get).toHaveBeenCalledTimes(1);
    expect(backend.complete).toHaveBeenCalledTimes(1);
    expect(get(session.state).verificationRequired).toEqual([]);
    expect(get(session.state).snapshot?.tasks[0]?.completed).toBe(true);
  });

  test("source/account-qualified actions reject stale references and missing editing permission", async () => {
    const { backend, session } = fixture();
    await session.connect();
    await expect(
      session.complete({
        provider: "github",
        accountId: "account",
        itemId: "item",
      }),
    ).rejects.toThrow(/does not currently/);
    await expect(
      session.complete({
        provider: "google-tasks",
        accountId: "old-account",
        itemId: "item",
      }),
    ).rejects.toThrow(/does not currently/);
    session.state.update((value) => ({
      ...value,
      snapshot: {
        ...value.snapshot!,
        account: {
          ...value.snapshot!.account,
          capabilities: { complete: false },
        },
      },
    }));
    await expect(
      session.complete({
        provider: "google-tasks",
        accountId: "account",
        itemId: "item",
      }),
    ).rejects.toThrow(/does not currently/);
    expect(backend.complete).not.toHaveBeenCalled();
  });

  test("a confirmed rejection restores the row without requiring uncertain-delivery verification", async () => {
    const { backend, session } = fixture();
    await session.connect();
    const snapshot = get(session.state).snapshot!;
    backend.complete = vi.fn(async () => {
      throw new SourceActionRejectedError("Task changed before the write");
    });
    await session.complete(taskSourceReference(snapshot, snapshot.tasks[0]!));
    expect(get(session.state).verificationRequired).toEqual([]);
    expect(get(session.state).snapshot?.tasks[0]?.completed).toBe(false);
    expect(get(session.state).error).toMatch(/changed/);
    expect(backend.get).not.toHaveBeenCalled();
  });

  test("completion is optimistic before persistence but sends only after it", async () => {
    const { backend, storage, session } = fixture();
    await session.connect();
    let saved!: () => void;
    storage.write = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          saved = resolve;
        }),
    );
    const snapshot = get(session.state).snapshot!;
    const pending = session.complete(
      taskSourceReference(snapshot, snapshot.tasks[0]!),
    );
    expect(get(session.state).snapshot?.tasks[0]?.completed).toBe(true);
    expect(backend.complete).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(storage.write).toHaveBeenCalledTimes(1));
    storage.write = vi.fn(async () => {});
    saved();
    await pending;
    expect(backend.complete).toHaveBeenCalledTimes(1);
  });

  test("page readers stop repeated cursors and share one budget across containers", async () => {
    const budget = new SourcePageBudget(3, 2000);
    const fetch = vi.fn(async () => ({ items: ["item"], next: "same" }));
    const first = await readSourcePages("one", budget, fetch);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(first.state.error).toMatch(/repeated/);
    const second = await readSourcePages("two", budget, async () => ({
      items: ["other"],
      next: "next",
    }));
    expect(second.state.complete).toBe(false);
    expect(budget.available).toBe(false);
    await readSourcePages("one", new SourcePageBudget(), fetch, first.state);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
