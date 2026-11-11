import { describe, expect, test, vi } from "vitest";

import type { TaskOperation } from "../src/tasks/operations";
import { TaskQueue } from "../src/tasks/queue";
import { TaskRegistry } from "../src/tasks/registry";
import type {
  ProviderTask,
  TaskProvider,
  TaskSnapshot,
} from "../src/tasks/types";

const task: ProviderTask = {
  id: "remote",
  title: "New task",
  description: "",
  projectId: "work",
  parentId: null,
  labels: [],
  priority: 1,
  completed: false,
  order: 1,
  due: null,
};
const snapshot = (tasks: ProviderTask[]): TaskSnapshot => ({
  provider: "todoist",
  account: { id: "account", name: "Test", timezone: "UTC" },
  projects: [],
  tasks,
  fetchedAt: new Date().toISOString(),
});
async function setup() {
  let disk: string | null = null;
  let failWrite = false;
  const storage = {
    readState: async () => disk,
    writeState: async (value: string) => {
      if (failWrite) throw new Error("disk failed");
      disk = value;
    },
  };
  const registry = new TaskRegistry(storage, "a".repeat(32));
  await registry.initialize();
  const operation: TaskOperation = {
    id: crypto.randomUUID(),
    tempId: crypto.randomUUID(),
    provider: "todoist",
    accountId: "account",
    base: null,
    mutation: {
      kind: "create",
      task: {
        title: task.title,
        description: "",
        projectId: "work",
        parentId: null,
        labels: [],
        priority: 1,
        due: null,
      },
    },
    status: "pending",
    attempts: 0,
    createdAt: new Date().toISOString(),
  };
  await registry.change((state) => {
    state.operations.push(operation);
  });
  return {
    registry,
    operation,
    queue: new TaskQueue(registry, () => {}),
    storage,
    setFailWrite: (value: boolean) => {
      failWrite = value;
    },
  };
}

describe("durable task writes", () => {
  test("saved intent is detached from mutable caller objects", async () => {
    const h = await setup();
    if (h.operation.mutation.kind === "create") h.operation.mutation.task.title = "Changed after save";
    const saved = h.registry.snapshot().operations[0]!;
    expect(saved.mutation).toMatchObject({ kind: "create", task: { title: "New task" } });
  });
  test("each queued edit is verified before a later edit replaces the same field", async () => {
    const h = await setup();
    await h.registry.updateOperation(h.operation.id, {
      base: task,
      mutation: {
        kind: "update",
        taskId: task.id,
        changes: { title: "First" },
      },
    });
    const second: TaskOperation = {
      ...h.operation,
      id: crypto.randomUUID(),
      base: { ...task, title: "First" },
      mutation: {
        kind: "update",
        taskId: task.id,
        changes: { title: "Second" },
      },
    };
    await h.registry.change((state) => {
      state.operations.push(second);
    });
    let remote = { ...task };
    const apply = vi.fn(async (operation: TaskOperation) => {
      if (operation.mutation.kind === "update")
        remote = { ...remote, ...operation.mutation.changes };
      return { taskId: task.id };
    });
    await h.queue.run(
      { get: async () => remote, read: async () => snapshot([remote]), apply },
      snapshot([task]),
      () => true,
    );
    expect(apply).toHaveBeenCalledTimes(2);
    expect(remote.title).toBe("Second");
    expect(h.registry.snapshot().operations.map((op) => op.status)).toEqual([
      "complete",
      "complete",
    ]);
    expect(
      h.registry.snapshot().operations.map((op) => op.readback?.title),
    ).toEqual(["First", "Second"]);
  });

  test("verified readback survives a failed snapshot publication and restart", async () => {
    const h = await setup();
    const apply = vi.fn(async () => ({ taskId: task.id }));
    await expect(
      h.queue.run(
        {
          get: async () => task,
          apply,
          read: async () => {
            throw new Error("snapshot offline");
          },
        },
        snapshot([]),
        () => true,
      ),
    ).rejects.toThrow("snapshot offline");
    expect(h.registry.snapshot().operations[0]?.status).toBe("verified");
    const restored = new TaskRegistry(h.storage, "a".repeat(32));
    await restored.initialize();
    await new TaskQueue(restored, () => {}).run(
      { apply, read: async () => snapshot([task]) },
      snapshot([task]),
      () => true,
    );
    expect(apply).toHaveBeenCalledTimes(1);
    expect(restored.snapshot().operations[0]?.status).toBe("complete");
  });
  test("an acknowledged patch with an ignored field remains visible for review", async () => {
    const h = await setup();
    await h.registry.updateOperation(h.operation.id, {
      base: task,
      mutation: {
        kind: "update",
        taskId: task.id,
        changes: { duration: { amount: 45, unit: "minute" } },
      },
    });
    const apply = vi.fn(async () => ({ taskId: task.id }));
    await h.queue.run(
      {
        read: async () => snapshot([{ ...task, duration: null }]),
        get: async () => ({ ...task, duration: null }),
        apply,
      },
      snapshot([task]),
      () => true,
    );
    expect(apply).toHaveBeenCalledTimes(1);
    expect(h.registry.snapshot().operations[0]?.status).toBe("conflict");
    expect(h.registry.snapshot().operations[0]?.error).toContain(
      "different field values",
    );
  });
  test("a lost create response retries the saved UUID after restart and creates once", async () => {
    const h = await setup();
    const serverIds = new Set<string>();
    let loseResponse = true;
    const apply = vi.fn(async (op: TaskOperation) => {
      expect(h.registry.snapshot().operations[0]?.status).toBe("sent");
      serverIds.add(op.id);
      if (loseResponse) {
        loseResponse = false;
        throw new Error("response lost");
      }
      return { taskId: "remote" };
    });
    const provider: TaskProvider = {
      read: async () => snapshot([task]),
      apply,
    };
    await h.queue.run(provider, snapshot([]), () => true);
    expect(h.registry.snapshot().operations[0]?.status).toBe("sent");
    const restored = new TaskRegistry(h.storage, "a".repeat(32));
    await restored.initialize();
    await restored.updateOperation(h.operation.id, { retryAt: undefined });
    // Inspect the restored intent as the active source after restarting.
    apply.mockImplementation(async (op) => {
      serverIds.add(op.id);
      return { taskId: "remote" };
    });
    await new TaskQueue(restored, () => {}).run(
      provider,
      snapshot([task]),
      () => true,
    );
    expect(apply.mock.calls.map(([op]) => op.id)).toEqual([
      h.operation.id,
      h.operation.id,
    ]);
    expect(serverIds.size).toBe(1);
    expect(restored.snapshot().operations[0]).toMatchObject({
      status: "complete",
      remoteId: "remote",
      attempts: 2,
    });
  });
  test("an acknowledged operation survives a readback failure without repeating its write", async () => {
    const h = await setup();
    const apply = vi.fn(async () => ({ taskId: "remote" }));
    const read = vi.fn(async () => {
      throw new Error("readback offline");
    });
    const provider: TaskProvider = { apply, read };
    await expect(
      h.queue.run(provider, snapshot([]), () => true),
    ).rejects.toThrow("offline");
    expect(h.registry.snapshot().operations[0]?.status).toBe("acknowledged");
    await h.registry.updateOperation(h.operation.id, { retryAt: undefined });
    await h.queue.run(
      { ...provider, read: async () => snapshot([task]) },
      snapshot([task]),
      () => true,
    );
    expect(apply).toHaveBeenCalledTimes(1);
    expect(h.registry.snapshot().operations[0]?.status).toBe("complete");
  });
  test("failed intent persistence prevents the provider write", async () => {
    const h = await setup();
    h.setFailWrite(true);
    const apply = vi.fn(async () => ({ taskId: "remote" }));
    await expect(
      h.queue.run(
        { apply, read: async () => snapshot([]) },
        snapshot([]),
        () => true,
      ),
    ).rejects.toThrow("disk failed");
    expect(apply).not.toHaveBeenCalled();
  });
  test("preflight read failure keeps an unsent operation pending", async () => {
    const h = await setup();
    await h.registry.updateOperation(h.operation.id, {
      base: task,
      mutation: {
        kind: "update",
        taskId: task.id,
        changes: { title: "Edited" },
      },
    });
    const apply = vi.fn(async () => ({ taskId: "remote" }));
    await h.queue.run(
      {
        read: async () => snapshot([task]),
        get: async () => {
          throw new Error("offline");
        },
        apply,
      },
      snapshot([task]),
      () => true,
    );
    expect(h.registry.snapshot().operations[0]?.status).toBe("pending");
    expect(apply).not.toHaveBeenCalled();
  });
  test("commands from another account stay untouched", async () => {
    const h = await setup();
    const apply = vi.fn(async () => ({ taskId: "remote" }));
    await h.queue.run(
      { read: async () => snapshot([]), apply },
      {
        ...snapshot([]),
        account: { id: "other", name: "Other", timezone: "UTC" },
      },
      () => true,
    );
    expect(apply).not.toHaveBeenCalled();
    expect(h.registry.snapshot().operations[0]?.status).toBe("pending");
  });
});
