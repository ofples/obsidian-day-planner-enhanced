import { createHash, webcrypto } from "node:crypto";
import type { Plugin } from "obsidian";
import { get } from "svelte/store";
import { beforeEach, describe, expect, test, vi } from "vitest";

import {
  taskOperationSchema,
  type TaskOperation,
} from "../src/tasks/operations";
import { TaskRegistry } from "../src/tasks/registry";
import { createTaskService } from "../src/tasks/obsidian";
import { TaskService } from "../src/tasks/service";
import type {
  ProviderTask,
  TaskSnapshot,
  TaskStorage,
} from "../src/tasks/types";

beforeEach(() => vi.stubGlobal("crypto", webcrypto));
const namespace = "a".repeat(32);
const task: ProviderTask = {
  id: "task",
  title: "Saved task",
  description: "",
  projectId: "inbox",
  parentId: null,
  labels: [],
  priority: 1,
  completed: false,
  order: 0,
  due: null,
};
const snapshot: TaskSnapshot = {
  provider: "todoist",
  account: { id: "account", name: "Fixture", timezone: "UTC" },
  projects: [],
  tasks: [task],
  fetchedAt: "2026-11-12T00:00:00Z",
};
function emptyState() {
  return JSON.stringify({
    version: 19,
    namespace,
    operations: [],
    links: {},
    schedules: [],
    projections: {},
    issues: {},
    detached: {},
    deletions: {},
    occurrences: {},
    localSources: {},
    identityDecisions: {},
  });
}
function command(status: "pending" | "sent" | "complete" = "sent") {
  return taskOperationSchema.parse({
    id: crypto.randomUUID(),
    tempId: crypto.randomUUID(),
    provider: "todoist",
    accountId: "account",
    mutation: { kind: "create", task },
    base: null,
    status,
    attempts: status === "pending" ? 0 : 1,
    createdAt: snapshot.fetchedAt,
    ...(status === "pending" ? {} : { sentAt: snapshot.fetchedAt }),
    ...(status === "complete" ? { remoteId: task.id, readback: task } : {}),
  });
}

function storageFixture(initial = emptyState()) {
  const disk: {
    state: string | null;
    checkpoint: string | null;
    cache: string | null;
  } = {
    state: initial,
    checkpoint: null,
    cache: JSON.stringify({ version: 1, namespace, snapshot }),
  };
  const events: string[] = [];
  let writes = 0;
  let failure: { at: number; after: boolean } | null = null;
  async function write(kind: "state" | "checkpoint", content: string) {
    writes++;
    events.push(kind);
    const fail = writes === failure?.at;
    if (fail && !failure!.after) throw new Error("Injected write failure");
    disk[kind] = content;
    if (fail) throw new Error("Injected applied-write failure");
  }
  const storage = {
    read: async () => disk.cache,
    write: vi.fn(async (content: string) => {
      disk.cache = content;
    }),
    readState: async () => disk.state,
    writeState: vi.fn((content: string) => write("state", content)),
    readStateCheckpoint: async () => disk.checkpoint,
    writeStateCheckpoint: vi.fn((content: string) =>
      write("checkpoint", content),
    ),
    backupState: vi.fn(async (_content: string, _version: number) => {
      events.push("backup");
    }),
    getSecret: () => "fixture-token",
    setSecret: vi.fn(),
  } satisfies TaskStorage;
  return {
    disk,
    events,
    storage,
    fail(at: number, after: boolean) {
      writes = 0;
      failure = { at, after };
    },
    recover() {
      failure = null;
    },
    newRegistry: () => new TaskRegistry(storage, namespace),
  };
}

async function savedFixture(status: "pending" | "sent" | "complete" = "sent") {
  const h = storageFixture();
  const registry = h.newRegistry();
  await registry.initialize();
  const older = h.disk.state;
  const operation = command(status);
  await registry.change((state) => {
    state.operations.push(operation);
    state.links.source = {
      provider: "todoist",
      accountId: "account",
      taskId: task.id,
      source: {
        path: "day.md",
        from: 0,
        raw: "- [ ] Saved task #todoist",
        title: task.title,
      },
      base: task,
    };
  });
  return { ...h, registry, older, latest: h.disk.state!, operation };
}

describe("saved task tracking repair", () => {
  test("the vault adapter verifies an existing content-addressed backup before restoration", async () => {
    const dir = ".obsidian/plugins/day-planner-enhanced";
    const content = emptyState();
    const digest = createHash("sha256")
      .update(content)
      .digest("hex")
      .slice(0, 20);
    const backupPath = `${dir}/task-state-v19-${digest}.backup.json`;
    const files = new Map([[backupPath, "Unexpected bytes"]]);
    const adapter = {
      exists: async (path: string) => files.has(path),
      read: async (path: string) => files.get(path)!,
      write: vi.fn(async (path: string, bytes: string) => {
        files.set(path, bytes);
      }),
    };
    const service = createTaskService({
      register: vi.fn(),
      manifest: { id: "day-planner-enhanced", dir },
      app: { vault: { configDir: ".obsidian", adapter } },
    } as unknown as Plugin);
    const storage = Reflect.get(service, "storage") as TaskStorage;
    await expect(storage.backupState!(content, 19)).rejects.toThrow(
      "backup changed",
    );
    expect(adapter.write).not.toHaveBeenCalled();
    files.set(backupPath, content);
    await storage.backupState!(content, 19);
    expect(adapter.write).not.toHaveBeenCalled();
    files.delete(backupPath);
    await storage.backupState!(content, 19);
    expect(files.get(backupPath)).toBe(content);
  });

  test("upgrade establishes the original checkpoint before exact-byte legacy migration", async () => {
    const legacy = JSON.stringify(
      { version: 18, namespace, operations: [], links: {} },
      null,
      2,
    );
    const h = storageFixture(legacy);
    const registry = h.newRegistry();
    await registry.initialize();
    expect(h.events).toEqual([
      "checkpoint",
      "backup",
      "checkpoint",
      "state",
      "checkpoint",
    ]);
    expect(h.storage.backupState).toHaveBeenCalledWith(legacy, 18);
    expect(JSON.parse(h.disk.checkpoint!).committed).toBe(h.disk.state);
    expect(registry.snapshot().version).toBe(19);
  });

  test("restoring older bytes holds writes and retains the latest command and source identities for review", async () => {
    const h = await savedFixture();
    h.disk.state = h.older;
    const checkpoint = h.disk.checkpoint;
    const restarted = h.newRegistry();
    await restarted.initialize();
    expect(restarted.snapshot().operations[0]).toEqual(h.operation);
    expect(restarted.snapshot().links.source?.taskId).toBe(task.id);
    expect(get(restarted.restoration)).toMatchObject({
      loaded: { commands: 0, links: 0 },
      saved: { commands: 1, links: 1 },
      canRestore: true,
    });
    await expect(
      restarted.change((state) => {
        state.links = {};
      }),
    ).rejects.toThrow("Review saved task tracking");
    expect(h.disk.state).toBe(h.older);
    expect(h.disk.checkpoint).toBe(checkpoint);
    expect(h.storage.backupState).not.toHaveBeenCalled();
  });

  test.each(["pending", "sent", "complete"] as const)(
    "confirmed repair preserves %s command UUIDs and requires fresh readback across restart",
    async (status) => {
      const h = await savedFixture(status);
      h.disk.state = h.older;
      const registry = h.newRegistry();
      await registry.initialize();
      const review = await registry.reviewRestoration();
      expect(review.fingerprint).toHaveLength(64);
      expect(await registry.restoreTracking(review)).toEqual({ kind: "saved" });
      expect(h.disk.state).toBe(h.latest);
      expect(h.storage.backupState).toHaveBeenCalledWith(h.older, 19);
      expect(registry.snapshot().operations[0]).toEqual(h.operation);
      expect(registry.needsReadback).toBe(true);
      await expect(registry.change(() => {})).rejects.toThrow("Refresh tasks");
      const restarted = h.newRegistry();
      await restarted.initialize();
      expect(get(restarted.restoration)).toBeNull();
      expect(restarted.needsReadback).toBe(true);
      expect(await restarted.restoreTracking(review)).toEqual({
        kind: "saved",
      });
      await restarted.acknowledgeReadback();
      await restarted.change(() => {});
      expect(restarted.needsReadback).toBe(false);
      expect(restarted.snapshot().operations[0]).toEqual(h.operation);
      expect(await restarted.restoreTracking(review)).toEqual({
        kind: "saved",
      });
      expect(h.storage.backupState).toHaveBeenCalledTimes(1);
    },
  );

  test.each([null, "{broken"])(
    "missing or malformed state %s can restore the supported saved checkpoint",
    async (content) => {
      const h = await savedFixture();
      h.disk.state = content;
      const registry = h.newRegistry();
      await registry.initialize();
      const review = await registry.reviewRestoration();
      expect(review.loaded.readable).toBe(false);
      expect(review.canRestore).toBe(true);
      await registry.restoreTracking(review);
      expect(h.disk.state).toBe(h.latest);
      if (content !== null)
        expect(h.storage.backupState).toHaveBeenCalledWith(content, 0);
      else expect(h.storage.backupState).not.toHaveBeenCalled();
    },
  );

  test.each([{ version: 99 }, { version: 19, namespace: "b".repeat(32) }])(
    "future or foreign restored metadata stays preserved %j",
    async (metadata) => {
      const h = await savedFixture();
      h.disk.state = JSON.stringify(metadata);
      const loaded = h.disk.state,
        checkpoint = h.disk.checkpoint;
      const registry = h.newRegistry();
      await registry.initialize();
      const review = await registry.reviewRestoration();
      expect(review.canRestore).toBe(false);
      await expect(registry.restoreTracking(review)).rejects.toThrow(
        "matching supported",
      );
      expect(h.disk.state).toBe(loaded);
      expect(h.disk.checkpoint).toBe(checkpoint);
      expect(h.storage.backupState).not.toHaveBeenCalled();
    },
  );

  test.each([{ version: 2 }, { namespace: "b".repeat(32) }])(
    "unsupported checkpoint stays preserved %j",
    async (metadata) => {
      const h = await savedFixture();
      h.disk.checkpoint = JSON.stringify({
        ...JSON.parse(h.disk.checkpoint!),
        ...metadata,
      });
      const loaded = h.disk.state,
        checkpoint = h.disk.checkpoint;
      await expect(h.newRegistry().initialize()).rejects.toThrow();
      expect(h.disk.state).toBe(loaded);
      expect(h.disk.checkpoint).toBe(checkpoint);
    },
  );

  test("changed comparison requires confirmation again before backup or replacement", async () => {
    const h = await savedFixture();
    h.disk.state = h.older;
    const registry = h.newRegistry();
    await registry.initialize();
    const review = await registry.reviewRestoration();
    h.disk.state = h.older + "\n";
    const result = await registry.restoreTracking(review);
    expect(result.kind).toBe("changed");
    expect(h.storage.backupState).not.toHaveBeenCalled();
    expect(h.disk.state).toBe(h.older + "\n");
    if (result.kind === "changed")
      await registry.restoreTracking(result.review);
    expect(h.disk.state).toBe(h.latest);
  });

  test("backup failure and replacement during backup retain repair", async () => {
    const h = await savedFixture();
    h.disk.state = h.older;
    const registry = h.newRegistry();
    await registry.initialize();
    const review = await registry.reviewRestoration();
    h.storage.backupState.mockRejectedValueOnce(
      new Error("Backup unavailable"),
    );
    await expect(registry.restoreTracking(review)).rejects.toThrow(
      "Backup unavailable",
    );
    expect(h.disk.state).toBe(h.older);
    h.storage.backupState.mockImplementationOnce(async () => {
      h.disk.state = h.older + "\n";
    });
    expect((await registry.restoreTracking(review)).kind).toBe("changed");
    expect(h.disk.state).toBe(h.older + "\n");
    expect(get(registry.restoration)).not.toBeNull();
  });

  test.each(
    [1, 2, 3].flatMap((at) => [false, true].map((after) => ({ at, after }))),
  )(
    "interrupted intent write recovers its actual bytes across restart $at/$after",
    async ({ at, after }) => {
      const h = storageFixture();
      const registry = h.newRegistry();
      await registry.initialize();
      const operation = command();
      h.fail(at, after);
      await expect(
        registry.change((state) => {
          state.operations.push(operation);
        }),
      ).rejects.toThrow("write failure");
      h.recover();
      const restarted = h.newRegistry();
      await restarted.initialize();
      const reachedState = at === 3 || (at === 2 && after);
      expect(restarted.snapshot().operations).toEqual(
        reachedState ? [operation] : [],
      );
      expect(get(restarted.restoration)).toBeNull();
      expect(JSON.parse(h.disk.checkpoint!).committed).toBe(h.disk.state);
      expect(JSON.parse(h.disk.checkpoint!).pending).toBeUndefined();
    },
  );

  test.each(
    [1, 2].flatMap((at) => [false, true].map((after) => ({ at, after }))),
  )(
    "interrupted confirmed restoration retains recovery or fresh-readback hold $at/$after",
    async ({ at, after }) => {
      const h = await savedFixture();
      h.disk.state = h.older;
      const registry = h.newRegistry();
      await registry.initialize();
      h.fail(at, after);
      await expect(
        registry.restoreTracking(await registry.reviewRestoration()),
      ).rejects.toThrow("write failure");
      h.recover();
      const restarted = h.newRegistry();
      await restarted.initialize();
      expect(restarted.snapshot().operations[0]).toEqual(h.operation);
      if (at === 2 && after) {
        expect(get(restarted.restoration)).toBeNull();
        expect(restarted.needsReadback).toBe(true);
      } else {
        expect(get(restarted.restoration)).not.toBeNull();
        await restarted.restoreTracking(await restarted.reviewRestoration());
      }
      expect(h.disk.state).toBe(h.latest);
      expect(restarted.needsReadback).toBe(true);
    },
  );

  test("a repeated confirmed comparison rechecks files changed after its receipt", async () => {
    const h = await savedFixture();
    h.disk.state = h.older;
    const registry = h.newRegistry();
    await registry.initialize();
    const review = await registry.reviewRestoration();
    await registry.restoreTracking(review);
    h.disk.state = h.older;
    const result = await registry.restoreTracking(review);
    expect(result.kind).toBe("changed");
    expect(h.disk.state).toBe(h.older);
    expect(get(registry.restoration)).not.toBeNull();
  });

  test("an in-session replacement opens repair before registry mutation", async () => {
    const h = await savedFixture();
    h.disk.state = h.older;
    await expect(h.registry.change(() => {})).rejects.toThrow(
      "another session",
    );
    expect(get(h.registry.restoration)?.canRestore).toBe(true);
    expect(h.disk.state).toBe(h.older);
  });

  test.each(["{broken", JSON.stringify({ version: 2 })])(
    "an unsupported in-session checkpoint replacement holds task writes %s",
    async (content) => {
      const h = await savedFixture();
      h.disk.checkpoint = content;
      await expect(h.registry.change(() => {})).rejects.toThrow(
        "unsupported format",
      );
      expect(get(h.registry.restoration)?.canRestore).toBe(false);
      expect(h.disk.state).toBe(h.latest);
      expect(h.disk.checkpoint).toBe(content);
    },
  );

  test("malformed committed tracking inside a supported checkpoint is preserved before replacement", async () => {
    const h = await savedFixture();
    h.disk.state = h.older;
    const registry = h.newRegistry();
    await registry.initialize();
    const review = await registry.reviewRestoration();
    const checkpoint = JSON.parse(h.disk.checkpoint!);
    checkpoint.committed = JSON.stringify({
      ...JSON.parse(h.latest),
      operations: [{ id: "invalid" }],
    });
    h.disk.checkpoint = JSON.stringify(checkpoint);
    await expect(registry.restoreTracking(review)).rejects.toThrow();
    expect(h.disk.state).toBe(h.older);
    expect(h.storage.backupState).not.toHaveBeenCalled();
    await expect(h.newRegistry().initialize()).rejects.toThrow();
  });

  test("a restored legacy checkpoint migrates after confirmation while retaining fresh-readback hold", async () => {
    const legacy = JSON.stringify(
      { version: 18, namespace, operations: [], links: {} },
      null,
      2,
    );
    const h = storageFixture("{broken");
    h.disk.checkpoint = JSON.stringify({
      version: 1,
      namespace,
      committed: legacy,
    });
    const registry = h.newRegistry();
    await registry.initialize();
    await registry.restoreTracking(await registry.reviewRestoration());
    expect(registry.snapshot().version).toBe(19);
    expect(registry.needsReadback).toBe(true);
    expect(h.storage.backupState).toHaveBeenCalledWith("{broken", 0);
    expect(h.storage.backupState).toHaveBeenCalledWith(legacy, 18);
    expect(JSON.parse(h.disk.checkpoint!).committed).toBe(h.disk.state);
  });

  test("service review sends no provider requests and saved recovery replays the original UUID after fresh readback", async () => {
    const h = await savedFixture();
    h.disk.state = h.older;
    const read = vi.fn(async () => structuredClone(snapshot));
    const apply = vi.fn(async (_operation: TaskOperation) => ({
      taskId: task.id,
    }));
    const service = new TaskService(h.storage, () => ({
      read,
      apply,
      get: async () => task,
    }));
    await service.initialize();
    expect(get(service.state).writable).toBe(false);
    await service.refresh();
    expect(read).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
    await service.restoreTracking(await service.registry.reviewRestoration());
    expect(read).toHaveBeenCalledTimes(2);
    expect(read.mock.invocationCallOrder[0]).toBeLessThan(
      apply.mock.invocationCallOrder[0]!,
    );
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply.mock.calls[0]?.[0]).toMatchObject({
      id: h.operation.id,
      tempId: h.operation.tempId,
    });
    expect(get(service.state).writable).toBe(true);
    expect(service.registry.snapshot().operations[0]?.status).toBe("complete");
    service.stop();
  });

  test("a failed fresh provider read holds restored writes through another service restart", async () => {
    const h = await savedFixture("complete");
    h.disk.state = h.older;
    const read = vi.fn(async (): Promise<TaskSnapshot> => {
      throw new Error("Offline");
    });
    const apply = vi.fn(async (_operation: TaskOperation) => ({
      taskId: task.id,
    }));
    const service = new TaskService(h.storage, () => ({ read, apply }));
    await service.initialize();
    await service.restoreTracking(await service.registry.reviewRestoration());
    expect(get(service.state)).toMatchObject({
      writable: false,
      needsTrackingReadback: true,
    });
    expect(apply).not.toHaveBeenCalled();
    service.stop();
    const restarted = new TaskService(h.storage, () => ({ read, apply }));
    await restarted.initialize();
    expect(get(restarted.state)).toMatchObject({
      writable: false,
      needsTrackingReadback: true,
    });
    read.mockResolvedValueOnce(snapshot);
    await restarted.refresh();
    expect(get(restarted.state)).toMatchObject({
      writable: true,
      needsTrackingReadback: false,
    });
    expect(apply).not.toHaveBeenCalled();
    restarted.stop();
  });
});
