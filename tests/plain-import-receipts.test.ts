import { get } from "svelte/store";
import { expect, test } from "vitest";

import type { GoogleCalendarSync } from "../src/google-calendar/service";
import { PlainTaskImporter } from "../src/tasks/plain-import";

test("concurrent imports serialize metadata and preserve both receipts", async () => {
  let disk: string | null = null;
  const host = {
    read: async () => null,
    flush: async () => {},
    readImports: async () => disk,
    writeImports: async (value: string) => {
      await Promise.resolve();
      disk = value;
    },
  };
  const calendar = {} as Pick<GoogleCalendarSync, "editNotes">;
  const importer = new PlainTaskImporter(calendar, host);
  const a = { path: "A.md", from: 0, raw: "- [ ] A", title: "A", uid: "a" };
  const b = { path: "B.md", from: 0, raw: "- [ ] B", title: "B", uid: "b" };
  const aId = crypto.randomUUID(),
    bId = crypto.randomUUID();
  await Promise.all([
    importer.runPane("account-a", aId, "first", async () => a),
    importer.runPane("account-b", bId, "second", async () => b),
  ]);
  expect(get(importer.imports)).toEqual({ "account-a": a, "account-b": b });
  const restored = new PlainTaskImporter(calendar, host);
  await restored.initialize();
  expect(get(restored.imports)).toEqual({ "account-a": a, "account-b": b });
  let invoked = false;
  await expect(
    restored.runPane("account-a", aId, "first", async () => {
      invoked = true;
      return a;
    }),
  ).resolves.toEqual(a);
  expect(invoked).toBe(false);
});

test("legacy source mappings load without losing existing entries", async () => {
  const source = { path: "Old.md", from: 2, raw: "- [ ] Old", title: "Old" };
  let disk: string | null = JSON.stringify({ legacy: source });
  const host = {
    read: async () => null,
    flush: async () => {},
    readImports: async () => disk,
    writeImports: async (value: string) => {
      disk = value;
    },
  };
  const importer = new PlainTaskImporter(
    {} as Pick<GoogleCalendarSync, "editNotes">,
    host,
  );
  await importer.runPane("new", crypto.randomUUID(), "request", async () => ({
    ...source,
    path: "New.md",
  }));
  expect(get(importer.imports).legacy).toEqual(source);
  const restored = new PlainTaskImporter(
    {} as Pick<GoogleCalendarSync, "editNotes">,
    host,
  );
  await restored.initialize();
  expect(get(restored.imports).legacy).toEqual(source);
});

test("a failure before preparing an edit permits a different destination", async () => {
  let disk: string | null = null;
  const host = {
    read: async () => null,
    flush: async () => {},
    readImports: async () => disk,
    writeImports: async (value: string) => {
      disk = value;
    },
  };
  const importer = new PlainTaskImporter(
    {} as Pick<GoogleCalendarSync, "editNotes">,
    host,
  );
  await expect(
    importer.runPane("key", crypto.randomUUID(), "first", async () => {
      throw new Error("Calendar busy");
    }),
  ).rejects.toThrow("Calendar busy");
  const source = { path: "B.md", from: 0, raw: "- [ ] B", title: "B" };
  await expect(
    importer.runPane("key", crypto.randomUUID(), "second", async () => source),
  ).resolves.toEqual(source);
});
