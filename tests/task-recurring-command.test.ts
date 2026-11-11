import { get } from "svelte/store";
import { describe, expect, test, vi } from "vitest";

import type { TaskOperation } from "../src/tasks/operations";
import { TaskService } from "../src/tasks/service";
import {
  TaskReadError,
  type ProviderTask,
  type TaskProvider,
  type TaskSnapshot,
} from "../src/tasks/types";

const task: ProviderTask = {
  id: "recurring",
  title: "Water plants",
  description: "Keep this description",
  projectId: "home",
  parentId: null,
  labels: [],
  priority: 1,
  order: 1,
  completed: false,
  completionCount: 0,
  due: {
    date: "2026-11-12",
    recurring: true,
    text: "every day",
    timezone: null,
  },
};
const snapshot = (
  value: ProviderTask,
  resetRecurringSubtasks = true,
): TaskSnapshot => ({
  provider: "todoist",
  account: {
    id: "account",
    name: "Test",
    timezone: "Asia/Kolkata",
    preferences: { resetRecurringSubtasks },
  },
  projects: [{ id: "home", name: "Home", order: 1 }],
  tasks: [value],
  fetchedAt: "2026-11-12T00:00:00Z",
});

async function setup() {
  let disk = JSON.stringify({
    version: 1,
    namespace: "a".repeat(32),
    snapshot: snapshot(task),
  });
  let state: string | null = null;
  const storage = {
    read: async () => disk,
    write: async (value: string) => {
      disk = value;
    },
    readState: async () => state,
    writeState: async (value: string) => {
      state = value;
    },
    getSecret: () => "credential",
    setSecret: vi.fn(),
  };
  let remote = structuredClone(task);
  let online = false;
  let loseResponse = false;
  let resetRecurringSubtasks = true;
  const applied = new Set<string>();
  const apply = vi.fn(async (operation: TaskOperation) => {
    if (!applied.has(operation.id)) {
      applied.add(operation.id);
      remote = {
        ...remote,
        completionCount: remote.completionCount! + 1,
        due: { ...remote.due!, date: "2026-11-13" },
      };
    }
    if (loseResponse) {
      loseResponse = false;
      throw new Error("Response lost");
    }
    return { taskId: remote.id };
  });
  const provider: TaskProvider = {
    read: async () => {
      if (!online) throw new TaskReadError("Offline", Date.now() + 60_000);
      return snapshot(remote, resetRecurringSubtasks);
    },
    get: async () => structuredClone(remote),
    apply,
  };
  const create = async () => {
    const service = new TaskService(storage, () => provider);
    await service.initialize();
    return service;
  };
  return {
    service: await create(),
    create,
    apply,
    applied,
    remote: () => remote,
    online: () => {
      online = true;
    },
    loseResponse: () => {
      loseResponse = true;
    },
    preference: (value: boolean) => {
      resetRecurringSubtasks = value;
    },
  };
}

describe("recurring completion intent", () => {
  test("concurrent offline clicks retain one occurrence and one frozen preference across restart", async () => {
    const h = await setup();
    const [first, second] = await Promise.all([
      h.service.complete(task),
      h.service.complete(task),
    ]);
    await h.service.refresh();
    expect(second.id).toBe(first.id);
    expect(h.service.registry.snapshot().operations).toHaveLength(1);
    expect(first.recurringCompletion).toEqual({ resetSubtasks: true });
    expect(h.apply).not.toHaveBeenCalled();
    h.service.stop();
    h.online();
    h.preference(false);
    const restored = await h.create();
    await restored.refresh();
    expect(h.apply).toHaveBeenCalledTimes(1);
    expect(h.apply.mock.calls[0]![0].recurringCompletion).toEqual({
      resetSubtasks: true,
    });
    expect(restored.registry.snapshot().operations[0]).toMatchObject({
      status: "complete",
      base: { completionCount: 0 },
      readback: { completionCount: 1 },
    });
    expect(get(restored.state).snapshot?.tasks).toHaveLength(1);
    expect(get(restored.state).snapshot?.tasks[0]).toMatchObject({
      completed: false,
      completionCount: 1,
    });
    expect(
      get(restored.state).snapshot?.account.preferences?.resetRecurringSubtasks,
    ).toBe(false);
    restored.stop();
  });

  test("a lost response replays the immutable UUID and advances the occurrence once", async () => {
    const h = await setup();
    h.online();
    h.loseResponse();
    const saved = await h.service.complete(task);
    await h.service.refresh();
    expect(h.service.registry.snapshot().operations[0]?.status).toBe("sent");
    expect(h.remote().completionCount).toBe(1);
    h.service.stop();
    h.preference(false);
    const restored = await h.create();
    await restored.registry.updateOperation(saved.id, { retryAt: undefined });
    await restored.refresh();
    expect(h.apply.mock.calls.map(([operation]) => operation.id)).toEqual([
      saved.id,
      saved.id,
    ]);
    expect(h.apply.mock.calls[0]![0].recurringCompletion).toEqual(
      h.apply.mock.calls[1]![0].recurringCompletion,
    );
    expect(h.applied.size).toBe(1);
    expect(h.remote().completionCount).toBe(1);
    expect(restored.registry.snapshot().operations[0]?.status).toBe("complete");
    restored.stop();
  });

  test("a stale task row keeps its original occurrence and cannot complete the next one", async () => {
    const h = await setup();
    h.online();
    await h.service.complete(task);
    await h.service.refresh();
    expect(h.remote().completionCount).toBe(1);
    const stale = await h.service.complete(task);
    await h.service.refresh();
    expect(
      h.service.registry
        .snapshot()
        .operations.find((item) => item.id === stale.id)?.status,
    ).toBe("conflict");
    expect(h.apply).toHaveBeenCalledTimes(1);
    expect(h.remote().completionCount).toBe(1);
    h.service.stop();
  });

  test("another occurrence cannot replace the saved completion while it is offline", async () => {
    const h = await setup();
    await h.service.complete(task);
    await expect(
      h.service.complete({ ...task, completionCount: 1 }),
    ).rejects.toThrow("saved recurring completion");
    expect(h.service.registry.snapshot().operations).toHaveLength(1);
    h.service.stop();
  });

  test("legacy recurring data requires a refreshed occurrence counter", async () => {
    const h = await setup();
    await expect(
      h.service.complete({ ...task, completionCount: undefined }),
    ).rejects.toThrow("load its occurrence");
    expect(h.service.registry.snapshot().operations).toHaveLength(0);
    h.service.stop();
  });
  test("a schedule-owned command keeps its reserved identity when another completion is pending", async () => {
    const h = await setup();
    await h.service.complete(task);
    const id = crypto.randomUUID();
    await expect(
      h.service.mutate({ kind: "complete", taskId: task.id }, undefined, {
        id,
        base: task,
        provider: "todoist",
        accountId: "account",
      }),
    ).rejects.toThrow("saved recurring completion");
    expect(h.service.registry.snapshot().operations).toHaveLength(1);
    expect(h.service.registry.snapshot().operations[0]?.id).not.toBe(id);
    h.service.stop();
  });
});
