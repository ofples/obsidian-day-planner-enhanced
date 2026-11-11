import { describe, expect, test, vi } from "vitest";

import { TaskRegistry } from "../src/tasks/registry";

const namespace = "a".repeat(32);
const legacy = JSON.stringify({
  version: 1,
  namespace,
  operations: [],
  links: {},
});

describe("task registry migration", () => {
  test("backs up v1 bytes before persisting the current projection format", async () => {
    let disk = legacy;
    const events: string[] = [];
    const storage = {
      readState: async () => disk,
      backupState: async (content: string, version: number) => {
        expect(content).toBe(legacy);
        expect(version).toBe(1);
        events.push("backup");
      },
      writeState: async (content: string) => {
        events.push("write");
        disk = content;
      },
    };
    const registry = new TaskRegistry(storage, namespace);
    await registry.initialize();
    expect(events).toEqual(["backup", "write"]);
    expect(registry.snapshot().version).toBe(3);
    expect(JSON.parse(disk).version).toBe(3);
  });

  test("failed backup preserves the original registry", async () => {
    const writeState = vi.fn(async () => {});
    const registry = new TaskRegistry(
      {
        readState: async () => legacy,
        writeState,
        backupState: async () => {
          throw new Error("backup failed");
        },
      },
      namespace,
    );
    await expect(registry.initialize()).rejects.toThrow("backup failed");
    expect(writeState).not.toHaveBeenCalled();
  });

  test("v2 migration preserves acknowledged command readbacks", async () => {
    const task = {
      id: "task",
      title: "Keep",
      description: "",
      projectId: "inbox",
      parentId: null,
      labels: [],
      priority: 1,
      completed: false,
      order: 1,
      due: null,
    };
    const operation = {
      id: crypto.randomUUID(),
      tempId: crypto.randomUUID(),
      provider: "todoist",
      accountId: "account",
      base: task,
      mutation: { kind: "update", taskId: task.id, changes: { title: "Keep" } },
      status: "verified",
      remoteId: task.id,
      attempts: 1,
      createdAt: new Date().toISOString(),
      readback: task,
    };
    const original = JSON.stringify({
      version: 2,
      namespace,
      operations: [operation],
      links: {},
    });
    let disk = original;
    const backupState = vi.fn(async () => {});
    const registry = new TaskRegistry(
      {
        readState: async () => disk,
        writeState: async (content: string) => {
          disk = content;
        },
        backupState,
      },
      namespace,
    );
    await registry.initialize();
    expect(backupState).toHaveBeenCalledWith(original, 2);
    expect(registry.snapshot().operations[0]).toMatchObject(operation);
    expect(registry.snapshot().schedules).toEqual([]);
    expect(registry.snapshot().projections).toEqual({});
  });

  test("future formats are preserved without writing a migration", async () => {
    const writeState = vi.fn(async () => {});
    const backupState = vi.fn(async () => {});
    const registry = new TaskRegistry(
      {
        readState: async () =>
          JSON.stringify({ version: 99, namespace, operations: [], links: {} }),
        writeState,
        backupState,
      },
      namespace,
    );
    await expect(registry.initialize()).rejects.toThrow();
    expect(writeState).not.toHaveBeenCalled();
    expect(backupState).not.toHaveBeenCalled();
  });
});
