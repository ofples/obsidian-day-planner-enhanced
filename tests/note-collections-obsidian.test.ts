import type { Plugin } from "obsidian";
import { get, writable } from "svelte/store";
import { afterEach, expect, test, vi } from "vitest";

import { defaultSettings, type DayPlannerSettings } from "../src/settings";
import { noteCollectionSchema } from "../src/tasks/note-collection-model";
import { createNoteCollections } from "../src/tasks/note-collections-obsidian";

vi.mock("obsidian", () => ({
  FuzzySuggestModal: class {},
  Modal: class {},
  Setting: class {},
  TFolder: class {},
}));

afterEach(() => vi.useRealTimers());

test("folder renames wait for the host's descendant-path cache and preserve note identities", async () => {
  vi.useFakeTimers();
  const { TFolder } = await import("obsidian");
  let paths = ["Topics/Questions/One.md"];
  let folder = "Topics/Questions";
  const callbacks = new Map<string, (...args: unknown[]) => void>();
  const settings = writable<DayPlannerSettings>({
    ...structuredClone(defaultSettings),
    noteCollections: [
      noteCollectionSchema.parse({
        id: "questions",
        name: "Questions",
        folder,
      }),
    ],
    noteCollectionFileIds: { "Topics/Questions/One.md": "one" },
  });
  const plugin = {
    app: {
      vault: {
        getMarkdownFiles: () => paths.map((path) => ({ path })),
        getAbstractFileByPath: (path: string) =>
          path === folder ? new TFolder() : null,
        on: (event: string, callback: (...args: unknown[]) => void) => {
          callbacks.set(event, callback);
          return {};
        },
      },
      metadataCache: {
        getCache: () => ({ frontmatter: { question: "An inquiry" } }),
        on: () => ({}),
      },
      workspace: { onLayoutReady: (callback: () => void) => callback() },
    },
    registerEvent: () => {},
    register: () => {},
  } as unknown as Plugin;
  const service = createNoteCollections(plugin, settings, () =>
    Promise.resolve(),
  );
  // Obsidian fires the folder event while descendant enumeration is still old.
  callbacks.get("rename")!({ path: "Topics/Inquiry" }, folder);
  expect(get(settings).noteCollections[0]?.folder).toBe(folder);
  folder = "Topics/Inquiry";
  paths = ["Topics/Inquiry/One.md"];
  await vi.runOnlyPendingTimersAsync();
  expect(get(settings).noteCollections[0]?.folder).toBe(folder);
  expect(get(service.state).documents.map((note) => note.path)).toEqual(paths);
  expect(get(settings).noteCollectionFileIds).toEqual({
    "Topics/Inquiry/One.md": "one",
  });
  // A deferred native callback after unload must not alter saved configuration.
  callbacks.get("rename")!({ path: "Topics/Other" }, folder);
  service.dispose();
  await vi.runOnlyPendingTimersAsync();
  expect(get(settings).noteCollections[0]?.folder).toBe(folder);
});
