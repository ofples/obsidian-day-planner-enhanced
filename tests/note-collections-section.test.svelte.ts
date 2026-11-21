import { flushSync, mount, unmount } from "svelte";
import { get, writable } from "svelte/store";
import { expect, test, vi } from "vitest";
import { defaultSettings } from "../src/settings";
import { NoteCollections } from "../src/tasks/note-collections";
import {
  noteCollectionSchema,
  type NoteCollectionConfig,
  type NoteScalar,
} from "../src/tasks/note-collection-model";
import type { NoteTaskDrag } from "../src/tasks/note-drag";
import NoteCollectionsSection from "../src/ui/components/note-collections-section.svelte";

function setup(
  configured = false,
  completion?: NoteCollectionConfig["completion"],
) {
  const docs = new Map([
    [
      "Questions/One.md",
      {
        question: "An open question",
        state: "Active",
        category: "Reflection",
        minutes: 20,
      },
    ],
    [
      "Questions/Two.md",
      {
        question: "An ongoing question",
        state: "Ongoing",
        category: "Practice",
        minutes: 30,
      },
    ],
  ]);
  const config = noteCollectionSchema.parse({
    completion,
    id: "q",
    name: "Questions",
    folder: "Questions",
    titleProperty: "question",
    statusProperty: "state",
    groupProperty: "category",
    visibleProperties: ["category"],
  });
  const settings = writable({
    ...structuredClone(defaultSettings),
    noteCollections: configured ? [config] : [],
  });
  const saved = vi.fn(async () => {}),
    open = vi.fn(async () => {}),
    schedule = vi.fn(async () => {});
  const service = new NoteCollections({
    settings,
    saved,
    open,
    schedule,
    writeProperty: async (
      path: string,
      property: string,
      value: NoteScalar,
    ) => {
      Object.assign(docs.get(path)!, { [property]: value });
    },
    paths: () => [...docs.keys()],
    properties: (path) => docs.get(path),
    folderExists: (path) => path === "Questions",
    chooseFolder: async () => "Questions",
  });
  const target = document.createElement("div");
  document.body.append(target);
  const drag = { start: vi.fn(), cancel: vi.fn() };
  const props = $state({
    port: service,
    noteDrag: drag as unknown as NoteTaskDrag,
    query: "",
  });
  const component = mount(NoteCollectionsSection, { target, props });
  flushSync();
  const button = (name: string) =>
    Array.from(target.querySelectorAll<HTMLButtonElement>("button")).find(
      (element) =>
        (element.getAttribute("aria-label") ?? element.textContent?.trim()) ===
        name,
    )!;
  const input = (name: string) =>
    target.querySelector<HTMLInputElement>(`input[aria-label="${name}"]`)!;
  const select = (name: string) =>
    target.querySelector<HTMLSelectElement>(`select[aria-label="${name}"]`)!;
  function change(name: string, value: string) {
    const field = select(name);
    field.value = value;
    field.dispatchEvent(new Event("change", { bubbles: true }));
    flushSync();
  }
  return {
    target,
    props,
    settings,
    service,
    saved,
    open,
    schedule,
    drag,
    button,
    input,
    select,
    change,
    cleanup: async () => {
      await unmount(component);
      target.remove();
      service.dispose();
    },
  };
}
test("folder setup defaults to filenames; mapping, filtering and grouping save as one source", async () => {
  const h = setup();
  h.button("Add collection").click();
  flushSync();
  h.button("Choose folder").click();
  await vi.waitFor(() =>
    expect(h.input("Collection name").value).toBe("Questions"),
  );
  h.target.querySelector("summary")!.click();
  flushSync();
  h.change("Title", "question");
  h.change("Status", "state");
  h.change("Group by", "category");
  h.change("Duration (minutes)", "minutes");
  h.button("Add filter").click();
  flushSync();
  h.change("Filter property 1", "state");
  const checkbox = Array.from(
    h.target.querySelectorAll<HTMLLabelElement>(".filter-values label"),
  )
    .find((label) => label.textContent?.trim() === "Active")!
    .querySelector("input")!;
  checkbox.click();
  flushSync();
  h.button("Save").click();
  await vi.waitFor(() => expect(h.target.querySelector("form")).toBeNull());
  expect(get(h.settings).noteCollections[0]?.filters[0]?.values).toEqual([
    "Active",
  ]);
  expect(h.target.querySelectorAll(".collection-note")).toHaveLength(1);
  expect(h.target.textContent).toContain("An open question");
  expect(h.target.textContent).not.toContain("An ongoing question");
  expect(h.target.querySelector(".collection-group-name")?.textContent).toBe(
    "Reflection",
  );
  await h.cleanup();
});
test("opening, linked scheduling, search and folding preserve note status and use distinct whole-note drags", async () => {
  const h = setup(true);
  expect(h.target.querySelectorAll(".collection-note")).toHaveLength(2);
  const openQuestion = Array.from(
    h.target.querySelectorAll<HTMLButtonElement>(".collection-note-open"),
  ).find((button) => button.textContent?.includes("An open question"))!;
  openQuestion.click();
  expect(h.open).toHaveBeenCalledWith("Questions/One.md");
  h.target
    .querySelector<HTMLButtonElement>(
      '[aria-label="Schedule An open question"]',
    )!
    .click();
  expect(h.schedule).toHaveBeenCalledWith(
    expect.objectContaining({ kind: "note", title: "An open question" }),
  );
  const event = new Event("dragstart", { bubbles: true });
  Object.defineProperty(event, "dataTransfer", { value: {} });
  openQuestion.dispatchEvent(event);
  expect(h.drag.start).toHaveBeenCalledWith(
    expect.objectContaining({
      kind: "note",
      noteId: expect.any(String),
      title: "An open question",
      path: "Questions/One.md",
    }),
    {},
  );
  h.props.query = "ongoing";
  flushSync();
  expect(h.target.querySelectorAll(".collection-note")).toHaveLength(1);
  h.target.querySelector<HTMLButtonElement>(".collection-toggle")!.click();
  flushSync();
  expect(h.target.querySelectorAll(".collection-note")).toHaveLength(0);
  await h.cleanup();
});
test("cancel and removing a collection leave source notes untouched and missing folders show recovery guidance", async () => {
  const h = setup(true),
    before = structuredClone(get(h.settings).noteCollections);
  h.target
    .querySelector<HTMLButtonElement>('[aria-label="Configure Questions"]')!
    .click();
  flushSync();
  h.input("Collection name").value = "Unsaved";
  h.input("Collection name").dispatchEvent(
    new Event("input", { bubbles: true }),
  );
  h.button("Cancel").click();
  flushSync();
  expect(get(h.settings).noteCollections).toEqual(before);
  h.target
    .querySelector<HTMLButtonElement>('[aria-label="Configure Questions"]')!
    .click();
  flushSync();
  h.button("Remove collection").click();
  await vi.waitFor(() => expect(h.target.querySelector("form")).toBeNull());
  expect(get(h.settings).noteCollections).toEqual([]);
  expect(h.open).not.toHaveBeenCalled();
  expect(h.schedule).not.toHaveBeenCalled();
  await h.cleanup();
});

test("groups collapse independently and cards omit metadata already shown in the heading", async () => {
  const h = setup(true);
  expect(
    h.target.querySelectorAll('.collection-metadata [title="category"]'),
  ).toHaveLength(0);
  h.button("Toggle Reflection").click();
  flushSync();
  expect(h.button("Toggle Reflection").getAttribute("aria-expanded")).toBe(
    "false",
  );
  expect(h.target.textContent).not.toContain("An open question");
  expect(h.target.textContent).toContain("An ongoing question");
  h.button("Toggle Reflection").click();
  flushSync();
  expect(h.target.querySelectorAll(".collection-note")).toHaveLength(2);
  h.settings.update((value) => ({
    ...value,
    noteCollections: value.noteCollections.map((config) => ({
      ...config,
      groupProperty: "state",
    })),
  }));
  flushSync();
  expect(
    h.target.querySelectorAll('.collection-metadata [title="state"]'),
  ).toHaveLength(0);
  await h.cleanup();
});

test("completion is optional, updates the chosen field, and can be reverted", async () => {
  const h = setup(true, {
    property: "state",
    checkedValue: "Done",
    uncheckedValue: "Active",
  });
  h.button("Configure Questions").click();
  flushSync();
  expect(h.input("Completion property").value).toBe("state");
  expect(h.input("When checked").value).toBe("Done");
  h.button("Cancel").click();
  flushSync();
  h.input("Complete An open question").click();
  await vi.waitFor(() =>
    expect(h.input("Revert An open question").checked).toBe(true),
  );
  h.input("Revert An open question").click();
  await vi.waitFor(() =>
    expect(h.input("Complete An open question").checked).toBe(false),
  );
  h.button("Configure Questions").click();
  flushSync();
  h.input("Allow note completion").click();
  flushSync();
  h.button("Save").click();
  await vi.waitFor(() => expect(h.target.querySelector("form")).toBeNull());
  expect(get(h.settings).noteCollections[0]?.completion).toBeUndefined();
  expect(h.target.querySelectorAll(".collection-note-complete")).toHaveLength(
    0,
  );
  await h.cleanup();
});

test("the settings opt-in starts with typed checkbox values and saves custom text mappings", async () => {
  const h = setup(true);
  expect(h.target.querySelectorAll(".collection-note-complete")).toHaveLength(
    0,
  );
  h.button("Configure Questions").click();
  flushSync();
  h.input("Allow note completion").click();
  flushSync();
  expect(h.select("When checked").value).toBe("true");
  expect(h.select("When reverted").value).toBe("false");
  h.input("Completion property").value = "state";
  h.input("Completion property").dispatchEvent(
    new Event("input", { bubbles: true }),
  );
  h.change("When checked type", "string");
  h.input("When checked").value = "Done";
  h.input("When checked").dispatchEvent(new Event("input", { bubbles: true }));
  h.change("When reverted type", "string");
  h.input("When reverted").value = "Active";
  h.input("When reverted").dispatchEvent(new Event("input", { bubbles: true }));
  h.button("Save").click();
  await vi.waitFor(() => expect(h.target.querySelector("form")).toBeNull());
  expect(get(h.settings).noteCollections[0]?.completion).toEqual({
    property: "state",
    checkedValue: "Done",
    uncheckedValue: "Active",
  });
  await h.cleanup();
});
