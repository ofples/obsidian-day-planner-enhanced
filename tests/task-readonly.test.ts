import { get } from "svelte/store";
import { expect, test, vi } from "vitest";

import { TaskService } from "../src/tasks/service";
import type { TaskOperation } from "../src/tasks/operations";
import type { TaskSnapshot } from "../src/tasks/types";

test("read-only refresh and restart retain pending commands without dispatching them", async () => {
  let cache: string | null = null;
  let registry: string | null = null;
  let secret = "";
  let enabled = true;
  const snapshot: TaskSnapshot = {
    provider: "todoist",
    account: { id: "account", name: "Fixture", timezone: "UTC" },
    projects: [{ id: "inbox", name: "Inbox", order: 0 }],
    tasks: [],
    fetchedAt: "2026-11-13T00:00:00Z",
  };
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
  const apply = vi.fn(async () => ({ taskId: "created" }));
  const read = vi.fn(async () => structuredClone(snapshot));
  const provider = () => ({ read, apply });
  let service = new TaskService(storage, provider, () => enabled);
  await service.initialize();
  await service.connect("token");
  const pending: TaskOperation = {
    id: crypto.randomUUID(),
    tempId: crypto.randomUUID(),
    provider: "todoist",
    accountId: "account",
    mutation: {
      kind: "create",
      task: {
        title: "Queued",
        description: "",
        projectId: "inbox",
        parentId: null,
        labels: [],
        priority: 1,
        due: null,
      },
    },
    base: null,
    status: "pending",
    attempts: 0,
    createdAt: "2026-11-13T00:00:00Z",
  };
  await service.registry.change((state) => {
    state.operations.push(pending);
  });
  const before = structuredClone(service.registry.snapshot());
  enabled = false;
  service.publish();
  expect(get(service.state)).toMatchObject({ readOnly: true, writable: false });
  await service.refresh(true);
  expect(apply).not.toHaveBeenCalled();
  expect(service.registry.snapshot()).toEqual(before);
  await expect(service.mutate(pending.mutation)).rejects.toThrow();
  service.stop();
  service = new TaskService(storage, provider, () => enabled);
  await service.initialize();
  await service.refresh(true);
  expect(apply).not.toHaveBeenCalled();
  expect(service.registry.snapshot()).toEqual(before);
  expect(get(service.state)).toMatchObject({ readOnly: true, writable: false });
  enabled = true;
  service.publish();
  let finish!: (value: TaskSnapshot) => void;
  read.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const refreshing = service.refresh(true);
  enabled = false;
  service.publish();
  finish(structuredClone(snapshot));
  await refreshing;
  expect(apply).not.toHaveBeenCalled();
  expect(service.registry.snapshot()).toEqual(before);
  service.stop();
});
