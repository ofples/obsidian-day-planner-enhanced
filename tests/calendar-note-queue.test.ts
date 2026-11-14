import type { Plugin } from "obsidian";
import { expect, test, vi } from "vitest";

import { GoogleCalendarSync } from "../src/google-calendar/service";
import type { AppStore } from "../src/redux/store";
import type { PeriodicNotes } from "../src/service/periodic-notes";
import { defaultSettingsForTests } from "../src/settings";

function fixture() {
  const edits = { isWriting: false, revision: 0 };
  const sync = new GoogleCalendarSync(
    {} as Plugin,
    {} as PeriodicNotes,
    () => defaultSettingsForTests,
    {} as AppStore,
    edits,
  );
  const scan = vi.fn(async () => []);
  Reflect.set(sync, "noteContext", () => ({ notes: { scan } }));
  return { sync, edits, scan };
}

test("queued drops wait for calendar work and execute in arrival order", async () => {
  const { sync, scan } = fixture();
  Reflect.set(sync, "busy", true);
  const order: string[] = [];
  let release!: () => void;
  const hold = new Promise<void>((resolve) => (release = resolve));
  const first = sync.editNotes(async () => {
    order.push("first");
    await hold;
  });
  const second = sync.editNotes(async () => {
    order.push("second");
  });
  await new Promise((resolve) => setTimeout(resolve, 150));
  expect(scan).not.toHaveBeenCalled();
  Reflect.set(sync, "busy", false);
  await new Promise((resolve) => setTimeout(resolve, 150));
  expect(order).toEqual(["first"]);
  release();
  await Promise.all([first, second]);
  expect(order).toEqual(["first", "second"]);
  expect(scan).toHaveBeenCalledTimes(2);
});

test("waits for a local transaction before applying the drop", async () => {
  const { sync, edits, scan } = fixture();
  edits.isWriting = true;
  const operation = sync.editNotes(async () => "inserted");
  await new Promise((resolve) => setTimeout(resolve, 150));
  expect(scan).not.toHaveBeenCalled();
  edits.isWriting = false;
  await new Promise((resolve) => setTimeout(resolve, 150));
  await expect(operation).resolves.toBe("inserted");
});

test("a failed drop releases the queue for the following drop", async () => {
  const { sync } = fixture();
  const first = sync.editNotes(async () => {
    throw new Error("file removed");
  });
  const second = sync.editNotes(async () => "next");
  await expect(first).rejects.toThrow("file removed");
  await expect(second).resolves.toBe("next");
});

test("unloading cancels waiting drops without running note writes", async () => {
  const { sync, scan } = fixture();
  Reflect.set(sync, "busy", true);
  const operation = sync.editNotes(async () => "unexpected");
  const checked = expect(operation).rejects.toThrow("Reopen Day Planner");
  await new Promise((resolve) => setTimeout(resolve, 150));
  Reflect.set(sync, "stopped", true);
  await new Promise((resolve) => setTimeout(resolve, 150));
  await checked;
  expect(scan).not.toHaveBeenCalled();
});

test("flushes the latest editor content before scanning the queued write", async () => {
  const { sync, scan } = fixture();
  const order: string[] = [];
  scan.mockImplementation(async () => {
    order.push("scan");
    return [];
  });
  await sync.editNotes(
    async () => {
      order.push("write");
    },
    async () => {
      order.push("flush");
    },
  );
  expect(order).toEqual(["flush", "scan", "write"]);
});
