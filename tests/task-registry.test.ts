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
  test("v11 migration preserves exact command bytes before adding occurrence journals", async () => {
    let disk = JSON.stringify(
      {
        version: 11,
        namespace,
        operations: [],
        links: {},
        schedules: [],
        projections: {},
        issues: {},
        detached: {},
        deletions: {},
      },
      null,
      2,
    );
    const original = disk;
    const backupState = vi.fn(async () => {});
    const registry = new TaskRegistry(
      {
        readState: async () => disk,
        writeState: async (value) => {
          disk = value;
        },
        backupState,
      },
      namespace,
    );
    await registry.initialize();
    expect(backupState).toHaveBeenCalledWith(original, 11);
    expect(registry.snapshot()).toMatchObject({ version: 12, occurrences: {} });
  });
  test("v10 migration backs up exact bytes before enabling occurrence-aware commands", async () => {
    let disk = JSON.stringify(
      {
        version: 10,
        namespace,
        operations: [],
        links: {},
        schedules: [],
        projections: {},
        issues: {},
        detached: {},
        deletions: {},
      },
      null,
      2,
    );
    const original = disk;
    const backupState = vi.fn(async () => {});
    const registry = new TaskRegistry(
      {
        readState: async () => disk,
        writeState: async (value) => {
          disk = value;
        },
        backupState,
      },
      namespace,
    );
    await registry.initialize();
    expect(backupState).toHaveBeenCalledWith(original, 10);
    expect(registry.snapshot().version).toBe(12);
  });
  test("v9 migration preserves original recovery bytes before adding deletion records", async () => {
    let disk = JSON.stringify(
      {
        version: 9,
        namespace,
        operations: [],
        links: {},
        schedules: [],
        projections: {},
        issues: {},
        detached: {},
      },
      null,
      2,
    );
    const original = disk;
    const backupState = vi.fn(async () => {});
    const registry = new TaskRegistry(
      {
        readState: async () => disk,
        writeState: async (value) => {
          disk = value;
        },
        backupState,
      },
      namespace,
    );
    await registry.initialize();
    expect(backupState).toHaveBeenCalledWith(original, 9);
    expect(registry.snapshot()).toMatchObject({
      version: 12,
      detached: {},
      deletions: {},
    });
  });
  test("v8 migration backs up original bytes before enabling missing-link recovery", async () => {
    let disk = JSON.stringify({
      version: 8,
      namespace,
      operations: [],
      links: {},
      schedules: [],
      projections: {},
      issues: {},
    });
    const original = disk;
    const backupState = vi.fn(async () => {});
    const registry = new TaskRegistry(
      {
        readState: async () => disk,
        writeState: async (value) => {
          disk = value;
        },
        backupState,
      },
      namespace,
    );
    await registry.initialize();
    expect(backupState).toHaveBeenCalledWith(original, 8);
    expect(registry.snapshot()).toMatchObject({ version: 12, detached: {} });
  });
  test("v7 migration backs up the original unlink format before capture-tag repair", async () => {
    let disk = JSON.stringify({
      version: 7,
      namespace,
      operations: [],
      links: {},
      schedules: [],
      projections: {},
      issues: {},
    });
    const original = disk;
    const backupState = vi.fn(async () => {});
    const registry = new TaskRegistry(
      {
        readState: async () => disk,
        writeState: async (value) => {
          disk = value;
        },
        backupState,
      },
      namespace,
    );
    await registry.initialize();
    expect(backupState).toHaveBeenCalledWith(original, 7);
    expect(JSON.parse(disk).version).toBe(12);
  });
  test("v6 migration backs up the original bytes before enabling unlink journals", async () => {
    let disk = JSON.stringify({
      version: 6,
      namespace,
      operations: [],
      links: {},
      schedules: [],
      projections: {},
      issues: {},
    });
    const original = disk;
    const backupState = vi.fn(async () => {});
    const registry = new TaskRegistry(
      {
        readState: async () => disk,
        writeState: async (value) => {
          disk = value;
        },
        backupState,
      },
      namespace,
    );
    await registry.initialize();
    expect(backupState).toHaveBeenCalledWith(original, 6);
    expect(JSON.parse(disk).version).toBe(12);
  });
  test("v5 migration backs up the registry and keeps its note baselines", async () => {
    let disk = JSON.stringify({
      version: 5,
      namespace,
      operations: [],
      links: {},
      schedules: [],
      projections: {},
      issues: {},
    });
    const original = disk;
    const backupState = vi.fn(async () => {});
    const registry = new TaskRegistry(
      {
        readState: async () => disk,
        writeState: async (text) => {
          disk = text;
        },
        backupState,
      },
      namespace,
    );
    await registry.initialize();
    expect(backupState).toHaveBeenCalledWith(original, 5);
    expect(registry.snapshot().version).toBe(12);
  });

  test("v4 migration retains the acknowledged projection instead of accepting an unmerged note edit", async () => {
    const base = {
      id: "task",
      title: "Original",
      description: "",
      projectId: "work",
      parentId: null,
      labels: [],
      priority: 1,
      completed: false,
      order: 1,
      due: null,
    };
    const source = {
      path: "Tasks.md",
      from: 0,
      raw: "- [ ] Edited #todoist",
      title: "Edited",
    };
    const before = {
      ...source,
      raw: "- [ ] Original #todoist",
      title: "Original",
    };
    let disk = JSON.stringify({
      version: 4,
      namespace,
      operations: [],
      schedules: [],
      links: {
        linked: {
          provider: "todoist",
          accountId: "account",
          taskId: base.id,
          base,
          source,
        },
        capture: {
          provider: "todoist",
          accountId: "account",
          taskId: "other",
          base: { ...base, id: "other" },
          source: { ...source, path: "Other.md" },
        },
      },
      projections: {
        linked: {
          provider: "todoist",
          accountId: "account",
          taskId: base.id,
          linkUid: "linked",
          occurrenceKey: "single",
          base,
          source: before,
          interval: null,
        },
      },
    });
    const registry = new TaskRegistry(
      {
        readState: async () => disk,
        writeState: async (value: string) => {
          disk = value;
        },
      },
      namespace,
    );
    await registry.initialize();
    expect(registry.snapshot().links.linked?.noteBase).toEqual(before);
    expect(registry.snapshot().links.capture?.noteBase).toBeUndefined();
  });

  test("unchanged transactions verify disk ownership and avoid another state write", async () => {
    let disk: string | null = null;
    const writeState = vi.fn(async (value: string) => {
      disk = value;
    });
    const registry = new TaskRegistry(
      { readState: async () => disk, writeState },
      namespace,
    );
    await registry.initialize();
    writeState.mockClear();
    await registry.change(() => {});
    expect(writeState).not.toHaveBeenCalled();
    disk = "Another writer";
    await expect(registry.change(() => {})).rejects.toThrow("another session");
  });

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
    expect(registry.snapshot().version).toBe(12);
    expect(JSON.parse(disk).version).toBe(12);
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
