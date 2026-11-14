import { get } from "svelte/store";
import { expect, test, vi } from "vitest";

import { TaskService } from "../src/tasks/service";
import type { TaskOperation } from "../src/tasks/operations";
import type { ProviderTask, TaskSnapshot } from "../src/tasks/types";

const task: ProviderTask = {
  id: "task",
  title: "Task",
  description: "",
  projectId: "project",
  parentId: null,
  labels: [],
  priority: 1,
  completed: false,
  order: 1,
  due: null,
};
const snapshot: TaskSnapshot = {
  provider: "todoist",
  account: { id: "account", name: "Test", timezone: "UTC" },
  projects: [],
  tasks: [task],
  fetchedAt: "2026-11-14T00:00:00Z",
};

async function harness() {
  let cache: string | null = null,
    registry: string | null = null,
    secret: string | null = null,
    enabled = true;
  let current = { ...task };
  const storage = {
    read: async () => cache,
    write: async (value: string) => {
      cache = value;
    },
    readState: async () => registry,
    writeState: async (value: string) => {
      registry = value;
    },
    getSecret: () => secret,
    setSecret: (_key: string, value: string) => {
      secret = value;
    },
  };
  const read = vi.fn(async () => structuredClone(snapshot));
  const getTask = vi.fn(async () => structuredClone(current));
  const apply = vi.fn(async (_operation: TaskOperation) => ({
    taskId: task.id,
  }));
  const service = new TaskService(
    storage,
    () => ({ read, get: getTask, apply }),
    () => false,
    undefined,
    undefined,
    undefined,
    () => enabled,
  );
  await service.initialize();
  await service.connect("token");
  return {
    service,
    getTask,
    apply,
    setCurrent: (value: ProviderTask) => {
      current = value;
    },
    disable: () => {
      enabled = false;
    },
  };
}

test("weak completion requires enabled mode and does not create a legacy outbox entry", async () => {
  const h = await harness();
  h.disable();
  await expect(h.service.completeWeak(task)).rejects.toThrow("disabled");
  expect(h.apply).not.toHaveBeenCalled();
  expect(h.service.registry.snapshot().operations).toEqual([]);
  h.service.stop();
});

test("an ambiguous readback retains the same command UUID for explicit retry", async () => {
  const h = await harness();
  await expect(h.service.completeWeak(task)).rejects.toThrow(
    "Refresh to confirm",
  );
  const first = h.apply.mock.calls[0]![0];
  h.apply.mockImplementationOnce(async () => {
    h.setCurrent({ ...task, completed: true });
    return { taskId: task.id };
  });
  await h.service.completeWeak(task);
  expect(h.apply.mock.calls[1]![0].id).toBe(first.id);
  expect(get(h.service.state).snapshot?.tasks[0]?.completed).toBe(true);
  expect(h.service.registry.snapshot().operations).toEqual([]);
  h.service.stop();
});

test("a successful manual refresh permits retry with the same UUID after the attempt limit", async () => {
  const h = await harness();
  for (let index = 0; index < 3; index++)
    await expect(h.service.completeWeak(task)).rejects.toThrow(
      "Refresh to confirm",
    );
  const first = h.apply.mock.calls[0]![0].id;
  await expect(h.service.completeWeak(task)).rejects.toThrow(
    "needs a Todoist refresh",
  );
  expect(h.apply).toHaveBeenCalledTimes(3);
  await h.service.refresh(true);
  h.apply.mockImplementationOnce(async () => {
    h.setCurrent({ ...task, completed: true });
    return { taskId: task.id };
  });
  await h.service.completeWeak(task);
  expect(h.apply.mock.calls[3]![0].id).toBe(first);
  h.service.stop();
});

test("recurring completion retries the same occurrence with the same UUID", async () => {
  const h = await harness();
  const recurring: ProviderTask = {
    ...task,
    due: { date: "2026-11-14", recurring: true, text: "daily", timezone: null },
    completionCount: 1,
  };
  h.setCurrent(recurring);
  await expect(h.service.completeWeak(recurring)).rejects.toThrow(
    "Refresh to confirm",
  );
  const first = h.apply.mock.calls[0]![0].id;
  h.apply.mockImplementationOnce(async () => {
    h.setCurrent({
      ...recurring,
      due: { ...recurring.due!, date: "2026-11-15" },
      completionCount: 2,
    });
    return { taskId: task.id };
  });
  await h.service.completeWeak(recurring);
  expect(h.apply.mock.calls[1]![0].id).toBe(first);
  expect(get(h.service.state).snapshot?.tasks[0]?.completionCount).toBe(2);
  h.service.stop();
});
