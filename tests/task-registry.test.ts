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
  test("backs up v1 bytes before persisting the v2 readback format", async () => {
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
    expect(registry.snapshot().version).toBe(2);
    expect(JSON.parse(disk).version).toBe(2);
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
