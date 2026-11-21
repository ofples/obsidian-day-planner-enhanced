import { describe, expect, test, vi } from "vitest";
import { get, writable } from "svelte/store";
import {
  defaultSettings,
  mergeStoredSettings,
  type DayPlannerSettings,
} from "../src/settings";
import {
  collectionIncludes,
  collectionNoteLink,
  normalizeNoteProperty,
  noteCollectionSchema,
  noteCollectionFilterSchema,
  projectNoteCollection,
} from "../src/tasks/note-collection-model";
import { NoteCollections } from "../src/tasks/note-collections";
import { NoteTaskDrag } from "../src/tasks/note-drag";

const config = noteCollectionSchema.parse({
  id: "questions",
  name: "Questions",
  folder: "Topics/Questions",
  titleProperty: "question",
  statusProperty: "state",
  groupProperty: "category",
  visibleProperties: ["state", "category"],
});
const first = {
  path: "Topics/Questions/One.md",
  properties: {
    question: "Can I begin again?",
    state: "Active",
    category: ["Practice", "Reflection"],
    minutes: 25,
    rank: 10,
    reviewed: false,
  },
};
const second = {
  path: "Topics/Questions/Two.md",
  properties: {
    question: "",
    state: "Settled for now",
    category: "Reflection",
    rank: 2,
    reviewed: true,
  },
};
const child = {
  path: "Topics/Questions/Nested/Three.md",
  properties: { question: "Nested inquiry", rank: 1 },
};

describe("folder note collection projection", () => {
  test("whole-note dragging keeps a plain title and a copy operation", () => {
    const drag = new NoteTaskDrag("test-vault");
    const transfer = {
      setData: vi.fn(),
      effectAllowed: "none",
    } as unknown as DataTransfer;
    drag.start(
      {
        kind: "note",
        noteId: "one",
        path: first.path,
        title: first.properties.question,
        text: collectionNoteLink({
          path: first.path,
          title: first.properties.question,
        }),
      },
      transfer,
    );
    expect(drag.current()?.title).toBe(first.properties.question);
    expect(transfer.effectAllowed).toBe("copy");
    drag.cancel();
    expect(drag.current()).toBeNull();
  });
  test("folder scope is exact by default, optional recursion does not include siblings or attachments", () => {
    expect(collectionIncludes(config, first.path)).toBe(true);
    expect(collectionIncludes(config, child.path)).toBe(false);
    expect(collectionIncludes({ ...config, recursive: true }, child.path)).toBe(
      true,
    );
    expect(
      collectionIncludes(
        { ...config, recursive: true },
        "Topics/Questions-old/One.md",
      ),
    ).toBe(false);
    expect(collectionIncludes(config, "Topics/Questions/image.png")).toBe(
      false,
    );
  });
  test("titles, metadata, multi-value groups and missing properties preserve note meanings", () => {
    const before = structuredClone([first, second, child]);
    const view = projectNoteCollection(
      { ...config, durationProperty: "minutes" },
      before,
      { [first.path]: "one", [second.path]: "two" },
    );
    expect(view.items.map((item) => item.title)).toEqual([
      "Can I begin again?",
      "Two",
    ]);
    expect(
      view.groups.map((group) => [group.name, group.items.length]),
    ).toEqual([
      ["Practice", 1],
      ["Reflection", 2],
    ]);
    expect(view.items[0]?.durationMinutes).toBe(25);
    expect(view.items[1]?.properties.state).toBe("Settled for now");
    expect(before).toEqual([first, second, child]);
    expect(normalizeNoteProperty({ unknown: "object" })).toBeNull();
  });
  test("typed multi-value filters, search, numeric sorting and empty values compose", () => {
    const active = noteCollectionFilterSchema.parse({
      property: "state",
      operator: "is",
      values: ["Active", "Ongoing"],
    });
    expect(
      projectNoteCollection(
        { ...config, filters: [active] },
        [first, second],
        {},
      ).items,
    ).toHaveLength(1);
    expect(
      projectNoteCollection(config, [first, second], {}, "settled").items[0]
        ?.title,
    ).toBe("Two");
    expect(
      projectNoteCollection(
        { ...config, sortProperty: "rank" },
        [first, second],
        {},
      ).items.map((item) => item.title),
    ).toEqual(["Two", "Can I begin again?"]);
    const boolean = noteCollectionFilterSchema.parse({
      property: "reviewed",
      operator: "is",
      values: [false],
    });
    expect(
      projectNoteCollection(
        { ...config, filters: [boolean] },
        [first, second],
        {},
      ).items[0]?.path,
    ).toBe(first.path);
    const missing = noteCollectionFilterSchema.parse({
      property: "missing",
      operator: "is-empty",
    });
    expect(
      projectNoteCollection(
        { ...config, filters: [missing] },
        [first, second],
        {},
      ).items,
    ).toHaveLength(2);
    expect(() =>
      noteCollectionFilterSchema.parse({ property: "state", operator: "is" }),
    ).toThrow();
  });
  test("links encode filenames and escape title syntax without inserting instructions or checkboxes", () => {
    const link = collectionNoteLink({
      path: "Topics/Some [note] (1)#.md",
      title: "Title ](fake)\n- [ ] injected",
    });
    expect(link).toContain("Some%20%5Bnote%5D%20%281%29%23.md");
    expect(link).not.toContain("\n");
    expect(link).toContain("\\]");
    expect(() =>
      collectionNoteLink({ path: "../Other.md", title: "Bad" }),
    ).toThrow();
  });
  test("old settings acquire no collections or injected note metadata", () => {
    expect(mergeStoredSettings(null).noteCollections).toEqual([]);
    expect(mergeStoredSettings(null).noteCollectionFileIds).toEqual({});
  });
});

function fixture() {
  const documents = new Map(
    [first, second, child].map((document) => [
      document.path,
      structuredClone(document.properties),
    ]),
  );
  const folders = new Set(["Topics/Questions", "Topics/Questions/Nested"]);
  const settings = writable<DayPlannerSettings>({
    ...structuredClone(defaultSettings),
    noteCollections: [structuredClone(config)],
    noteCollectionFileIds: {},
  });
  let serial = 0;
  const saved = vi.fn(async () => {}),
    open = vi.fn(async () => {});
  const host = {
    settings,
    saved,
    open,
    paths: () => [...documents.keys()],
    properties: (path: string) => documents.get(path),
    folderExists: (path: string) => folders.has(path),
    chooseFolder: async () => "Topics/Questions",
    makeId: () => "id-" + ++serial,
  };
  const service = new NoteCollections(host);
  return { documents, folders, settings, saved, open, host, service };
}
describe("live note collection service", () => {
  test("metadata edits, creation and deletion update the projection without writing notes", () => {
    const f = fixture();
    const noteId = get(f.settings).noteCollectionFileIds[first.path];
    f.documents.set(first.path, {
      ...first.properties,
      question: "Changed question",
    });
    f.service.changed(first.path);
    expect(
      get(f.service.state).documents.find(
        (document) => document.path === first.path,
      )?.properties.question,
    ).toBe("Changed question");
    f.documents.set("Topics/Questions/New.md", { ...first.properties });
    f.service.changed("Topics/Questions/New.md");
    expect(get(f.service.state).documents).toHaveLength(3);
    f.documents.delete(first.path);
    f.service.deleted(first.path);
    expect(get(f.settings).noteCollectionFileIds[first.path]).toBeUndefined();
    f.documents.set(first.path, { ...first.properties });
    f.service.changed(first.path);
    expect(get(f.settings).noteCollectionFileIds[first.path]).not.toBe(noteId);
    f.service.dispose();
  });
  test("note and folder renames preserve identities, mappings and missing-folder diagnostics", async () => {
    const f = fixture(),
      before = get(f.settings).noteCollectionFileIds[first.path]!;
    const moved = "Topics/Questions/Renamed.md";
    f.documents.set(moved, f.documents.get(first.path)!);
    f.documents.delete(first.path);
    f.service.renamed(first.path, moved);
    expect(get(f.settings).noteCollectionFileIds[moved]).toBe(before);
    const item = projectNoteCollection(
      config,
      get(f.service.state).documents,
      get(f.settings).noteCollectionFileIds,
    ).items.find((note) => note.id === before)!;
    await f.service.open(item);
    expect(f.open).toHaveBeenCalledWith(moved);
    f.folders.delete(config.folder);
    f.service.refresh();
    expect(get(f.service.state).missingFolders).toEqual([config.id]);
    f.service.dispose();
  });
  test("saving and removing sources preserves files, supports empty folders and rolls back rejected saves", async () => {
    const f = fixture(),
      original = structuredClone([...f.documents]);
    f.folders.add("Empty");
    await f.service.save({
      ...config,
      id: "empty",
      name: "Empty",
      folder: "Empty",
    });
    expect(get(f.settings).noteCollections).toHaveLength(2);
    await f.service.remove("empty");
    expect([...f.documents]).toEqual(original);
    f.saved.mockRejectedValueOnce(Error("Disk unavailable"));
    await expect(
      f.service.save({ ...config, name: "Changed name" }),
    ).rejects.toThrow("Disk unavailable");
    expect(get(f.settings).noteCollections[0]?.name).toBe("Questions");
    f.service.dispose();
  });
  test("folder inspection suggests existing typed properties, and disposed services stop observing settings", () => {
    const f = fixture(),
      inspection = f.service.inspect(config.folder, false);
    expect(inspection.properties).toContain("question");
    expect(inspection.values.state).toEqual(["Active", "Settled for now"]);
    expect(inspection.values.reviewed).toEqual([false, true]);
    f.service.dispose();
    const snapshot = get(f.service.state);
    f.settings.set({ ...get(f.settings), noteCollections: [] });
    expect(get(f.service.state)).toBe(snapshot);
  });
});
