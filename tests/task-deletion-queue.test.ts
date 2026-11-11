import { describe, expect, test, vi } from "vitest";

import { taskDeletionSchema } from "../src/tasks/deletion-types";
import type { TaskOperation } from "../src/tasks/operations";
import { TaskQueue } from "../src/tasks/queue";
import { TaskRegistry } from "../src/tasks/registry";
import {
  TaskReadError,
  type ProviderTask,
  type TaskSnapshot,
} from "../src/tasks/types";

const root: ProviderTask = {
  id: "root",
  title: "Saved root",
  description: "Original description",
  projectId: "work",
  parentId: null,
  labels: ["work"],
  priority: 2,
  completed: false,
  order: 1,
  due: null,
};
const child: ProviderTask = {
  ...root,
  id: "child",
  title: "Saved child",
  parentId: root.id,
  order: 2,
};
const snapshot = (tasks: ProviderTask[]): TaskSnapshot => ({
  provider: "todoist",
  account: {
    id: "account",
    name: "Test",
    timezone: "UTC",
    capabilities: { delete: true },
  },
  projects: [{ id: "work", name: "Work", order: 1 }],
  tasks,
  fetchedAt: new Date().toISOString(),
});

async function setup() {
  let disk: string | null = null;
  const storage = {
    readState: async () => disk,
    writeState: async (text: string) => {
      disk = text;
    },
  };
  const registry = new TaskRegistry(storage, "a".repeat(32));
  await registry.initialize();
  const operation: TaskOperation = {
    id: crypto.randomUUID(),
    tempId: crypto.randomUUID(),
    provider: "todoist",
    accountId: "account",
    base: root,
    mutation: { kind: "delete", taskId: root.id },
    status: "pending",
    attempts: 0,
    createdAt: new Date().toISOString(),
  };
  await registry.change((state) => {
    state.operations.push(operation);
    state.deletions[operation.id] = taskDeletionSchema.parse({
      id: operation.id,
      provider: operation.provider,
      accountId: operation.accountId,
      taskId: root.id,
      tasks: [root, child],
      links: {},
      projections: {},
      phase: "queued",
      createdAt: operation.createdAt,
    });
  });
  const tasks = new Map([
    [root.id, structuredClone(root)],
    [child.id, structuredClone(child)],
  ]);
  const applied = new Set<string>();
  const apply = vi.fn(async (op: TaskOperation) => {
    if (!applied.has(op.id)) {
      tasks.clear();
      applied.add(op.id);
    }
    return { taskId: root.id };
  });
  const get = vi.fn(async (id: string) =>
    structuredClone(tasks.get(id) ?? null),
  );
  const read = vi.fn(async () => snapshot([...tasks.values()]));
  const provider = { apply, get, read };
  return {
    registry,
    operation,
    storage,
    tasks,
    applied,
    apply,
    get,
    read,
    provider,
    queue: new TaskQueue(registry, () => {}),
    run: async () =>
      new TaskQueue(registry, () => {}).run(provider, await read(), () => true),
  };
}

describe("verified deletion outbox", () => {
  test("active grandchildren remain in scope through a known completed parent", async () => {
    const h = await setup();
    const completed = { ...child, completed: true };
    const grandchild = {
      ...root,
      id: "grandchild",
      parentId: child.id,
      order: 3,
    };
    h.tasks.set(child.id, completed);
    h.tasks.set(grandchild.id, grandchild);
    await h.registry.change((state) => {
      state.deletions[h.operation.id]!.tasks = [root, completed, grandchild];
    });
    h.read
      .mockResolvedValueOnce(snapshot([root, grandchild]))
      .mockResolvedValue(snapshot([]));
    await h.run();
    expect(h.apply).toHaveBeenCalledTimes(1);
    expect(h.registry.snapshot().operations[0]).toMatchObject({
      status: "complete",
      deletionReadback: { root: null, child: null, grandchild: null },
    });
  });

  test("recovery schema rejects foreign note links and projection identities", async () => {
    const h = await setup();
    const record = h.registry.snapshot().deletions[h.operation.id]!;
    const source = {
      path: "Tasks.md",
      from: 0,
      raw: "- [ ] Saved root #todoist",
      title: "Saved root",
    };
    const link = {
      provider: "todoist",
      accountId: "account",
      taskId: root.id,
      base: root,
      source,
    };
    expect(
      taskDeletionSchema.safeParse({
        ...record,
        links: { uid: { ...link, accountId: "other" } },
      }).success,
    ).toBe(false);
    expect(
      taskDeletionSchema.safeParse({
        ...record,
        links: { uid: { ...link, base: child } },
      }).success,
    ).toBe(false);
    expect(
      taskDeletionSchema.safeParse({
        ...record,
        links: { uid: link },
        projections: {
          uid: {
            ...link,
            linkUid: "different",
            occurrenceKey: "single",
            interval: null,
          },
        },
      }).success,
    ).toBe(false);
  });

  test("only a matching saved recovery record can authorize deletion", async () => {
    const h = await setup();
    await h.registry.change((state) => {
      delete state.deletions[h.operation.id];
    });
    await h.run();
    expect(h.apply).not.toHaveBeenCalled();
    expect(h.registry.snapshot().operations[0]?.status).toBe("failed");
  });

  test("cancellation during individual preflight never sends the saved delete", async () => {
    const h = await setup();
    h.get.mockImplementationOnce(async () => {
      await h.registry.change((state) => {
        state.operations[0]!.status = "cancelled";
        state.deletions[h.operation.id]!.phase = "cancelled";
      });
      return root;
    });
    await h.run();
    expect(h.apply).not.toHaveBeenCalled();
    expect(h.registry.snapshot().operations[0]?.status).toBe("cancelled");
    expect(h.tasks.size).toBe(2);
  });

  test("a recovery record from another account cannot authorize the outbox", async () => {
    const h = await setup();
    await h.registry.change((state) => {
      state.deletions[h.operation.id]!.accountId = "another";
    });
    await h.run();
    expect(h.apply).not.toHaveBeenCalled();
    expect(h.registry.snapshot().operations[0]?.status).toBe("failed");
  });

  test("individual verification support is required before the command is sent", async () => {
    const h = await setup();
    await h.queue.run(
      { read: h.read, apply: h.apply },
      snapshot([root, child]),
      () => true,
    );
    expect(h.apply).not.toHaveBeenCalled();
    expect(h.registry.snapshot().operations[0]?.status).toBe("failed");
  });

  test.each(["renamed child", "new child", "moved child", "new duration"])(
    "preflight detects %s after confirmation",
    async (change) => {
      const h = await setup();
      if (change === "renamed child")
        h.tasks.set(child.id, { ...child, title: "Changed" });
      if (change === "new child") h.tasks.set("new", { ...child, id: "new" });
      if (change === "moved child")
        h.tasks.set(child.id, { ...child, parentId: null });
      if (change === "new duration")
        h.tasks.set(child.id, {
          ...child,
          duration: { amount: 45, unit: "minute" },
        });
      await h.run();
      expect(h.apply).not.toHaveBeenCalled();
      expect(h.registry.snapshot().operations[0]?.status).toBe("conflict");
    },
  );

  test("lost acknowledgment replays the original UUID after restart", async () => {
    const h = await setup();
    const apply = h.apply.getMockImplementation()!;
    h.apply.mockImplementationOnce(async (op) => {
      await apply(op);
      throw new Error("response lost");
    });
    await h.run();
    expect(h.registry.snapshot().operations[0]?.status).toBe("sent");
    const restored = new TaskRegistry(h.storage, "a".repeat(32));
    await restored.initialize();
    await restored.updateOperation(h.operation.id, { retryAt: undefined });
    await new TaskQueue(restored, () => {}).run(
      h.provider,
      snapshot([]),
      () => true,
    );
    expect(h.applied.size).toBe(1);
    expect(h.apply.mock.calls.map(([op]) => op.id)).toEqual([
      h.operation.id,
      h.operation.id,
    ]);
    expect(restored.snapshot().operations[0]).toMatchObject({
      status: "complete",
      deletionReadback: { root: null, child: null },
    });
  });

  test("partial individual verification survives a failed child read and restart", async () => {
    const h = await setup();
    const get = h.get.getMockImplementation()!;
    h.get.mockImplementation(async (id) => {
      if (id === child.id && !h.tasks.size)
        throw new TaskReadError("Access revoked", undefined, true);
      return get(id);
    });
    await expect(h.run()).rejects.toThrow("Access revoked");
    expect(h.registry.snapshot().operations[0]).toMatchObject({
      status: "acknowledged",
      deletionReadback: { root: null },
    });
    const restored = new TaskRegistry(h.storage, "a".repeat(32));
    await restored.initialize();
    await restored.updateOperation(h.operation.id, { retryAt: undefined });
    h.get.mockImplementation(get);
    h.get.mockClear();
    await new TaskQueue(restored, () => {}).run(
      h.provider,
      snapshot([]),
      () => true,
    );
    expect(h.get.mock.calls).toEqual([[child.id]]);
    expect(h.apply).toHaveBeenCalledTimes(1);
    expect(restored.snapshot().operations[0]?.status).toBe("complete");
  });

  test("verification failure keeps the saved command acknowledged", async () => {
    const h = await setup();
    h.get
      .mockResolvedValueOnce(root)
      .mockRejectedValue(
        new TaskReadError("Permission denied", undefined, true),
      );
    await expect(h.run()).rejects.toThrow("Permission denied");
    expect(h.registry.snapshot().operations[0]).toMatchObject({
      status: "acknowledged",
    });
    expect(
      h.registry.snapshot().operations[0]?.deletionReadback,
    ).toBeUndefined();
    expect(h.registry.snapshot().deletions[h.operation.id]?.tasks).toEqual([
      root,
      child,
    ]);
  });

  test("an unrelated task response cannot verify a deleted child", async () => {
    const h = await setup();
    h.get
      .mockResolvedValueOnce(root)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ ...child, id: "other" });
    await expect(h.run()).rejects.toThrow("different task");
    expect(h.registry.snapshot().operations[0]?.deletionReadback).toEqual({
      root: null,
    });
    expect(h.registry.snapshot().operations[0]?.status).toBe("acknowledged");
  });

  test("a surviving child remains in authoritative readback", async () => {
    const h = await setup();
    h.apply.mockImplementation(async () => {
      h.tasks.delete(root.id);
      h.tasks.set(child.id, { ...child, parentId: null });
      return { taskId: root.id };
    });
    const fresh = await h.run();
    expect(
      h.registry.snapshot().operations[0]?.deletionReadback?.child?.parentId,
    ).toBe(null);
    expect(fresh.tasks.map((task) => task.id)).toEqual([child.id]);
  });

  test("failed cache publication resumes verification without another delete", async () => {
    const h = await setup();
    h.read
      .mockResolvedValueOnce(snapshot([root, child]))
      .mockRejectedValueOnce(new Error("snapshot unavailable"));
    await expect(h.run()).rejects.toThrow("snapshot unavailable");
    expect(h.registry.snapshot().operations[0]?.status).toBe("verified");
    const restored = new TaskRegistry(h.storage, "a".repeat(32));
    await restored.initialize();
    h.read.mockResolvedValue(snapshot([]));
    await new TaskQueue(restored, () => {}).run(
      h.provider,
      snapshot([]),
      () => true,
    );
    expect(restored.snapshot().operations[0]?.status).toBe("complete");
    expect(h.apply).toHaveBeenCalledTimes(1);
  });
});
