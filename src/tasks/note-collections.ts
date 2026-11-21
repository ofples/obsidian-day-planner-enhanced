import { get, writable, type Readable, type Writable } from "svelte/store";

import type { DayPlannerSettings } from "../settings";

import {
  collectionIncludes,
  normalizeNoteProperty,
  noteCollectionSchema,
  notePropertyValues,
  type CollectionDocument,
  type CollectionNote,
  type NoteCollectionConfig,
  type NoteScalar,
  type NoteProperty,
} from "./note-collection-model";

export interface NoteCollectionsState {
  configs: NoteCollectionConfig[];
  documents: CollectionDocument[];
  identities: Record<string, string>;
  missingFolders: string[];
  error: string;
}
export interface NoteCollectionInspection {
  properties: string[];
  values: Record<string, NoteScalar[]>;
}
export interface NoteCollectionsPort {
  schedule?: (note: CollectionNote) => Promise<void>;
  state: Readable<NoteCollectionsState>;
  inspect(folder: string, recursive: boolean): NoteCollectionInspection;
  chooseFolder(): Promise<string | null>;
  save(config: NoteCollectionConfig): Promise<void>;
  remove(id: string): Promise<void>;
  open(note: CollectionNote): Promise<void>;
  setCompleted?(note: CollectionNote, completed: boolean): Promise<void>;
}
export interface NoteCollectionsHost {
  schedule?: (note: CollectionNote) => Promise<void>;
  settings: Writable<DayPlannerSettings>;
  /** Resolves only after the settings subscription has persisted its latest value. */
  saved(): Promise<void>;
  paths(): string[];
  properties(path: string): Record<string, unknown> | undefined;
  folderExists(path: string): boolean;
  chooseFolder(): Promise<string | null>;
  open(path: string): Promise<void>;
  writeProperty?(
    path: string,
    property: string,
    value: NoteScalar,
    expected: NoteProperty | undefined,
  ): Promise<void>;
  makeId?(): string;
}

/** Metadata stays read-only unless the collection explicitly opts into completion. */
export class NoteCollections implements NoteCollectionsPort {
  readonly schedule?: (note: CollectionNote) => Promise<void>;
  readonly state = writable<NoteCollectionsState>({
    configs: [],
    documents: [],
    identities: {},
    missingFolders: [],
    error: "",
  });
  private documents = new Map<string, CollectionDocument>();
  private readonly stop: () => void;
  private signature = "";
  private active = true;
  private readonly pendingCompletions = new Set<string>();
  constructor(private readonly host: NoteCollectionsHost) {
    this.schedule = host.schedule;
    this.stop = host.settings.subscribe((settings) => {
      const signature = JSON.stringify([
        settings.noteCollections,
        settings.noteCollectionFileIds,
      ]);
      if (signature === this.signature) return;
      this.signature = signature;
      this.refresh();
    });
  }
  dispose() {
    this.active = false;
    this.stop();
  }
  chooseFolder() {
    return this.host.chooseFolder();
  }
  private read(path: string): CollectionDocument {
    const properties = Object.fromEntries(
      Object.entries(this.host.properties(path) ?? {})
        .filter(
          ([key]) =>
            key !== "position" &&
            !["__proto__", "constructor", "prototype"].includes(key),
        )
        .map(([key, value]) => [key, normalizeNoteProperty(value)]),
    );
    return { path, properties };
  }
  refresh() {
    if (!this.active) return;
    const settings = get(this.host.settings),
      configs = settings.noteCollections;
    const paths = this.host
      .paths()
      .filter((path) =>
        configs.some((config) => collectionIncludes(config, path)),
      );
    this.documents = new Map(paths.map((path) => [path, this.read(path)]));
    const identities = { ...settings.noteCollectionFileIds };
    let changed = false;
    for (const path of paths)
      if (!identities[path]) {
        identities[path] = this.host.makeId?.() ?? crypto.randomUUID();
        changed = true;
      }
    if (changed) {
      this.host.settings.update((current) => ({
        ...current,
        noteCollectionFileIds: identities,
      }));
      void this.host.saved().catch(() => {
        if (this.active)
          this.state.update((value) => ({
            ...value,
            error:
              "Collection identities could not be saved. Check writable storage before restarting.",
          }));
      });
      return;
    }
    this.publish();
  }
  private publish() {
    const settings = get(this.host.settings);
    this.state.set({
      configs: settings.noteCollections,
      documents: [...this.documents.values()],
      identities: settings.noteCollectionFileIds,
      missingFolders: settings.noteCollections
        .filter((config) => !this.host.folderExists(config.folder))
        .map((config) => config.id),
      error: "",
    });
  }
  changed(path: string) {
    if (!this.active) return;
    const settings = get(this.host.settings);
    if (
      !settings.noteCollections.some((config) =>
        collectionIncludes(config, path),
      )
    )
      return;
    if (!settings.noteCollectionFileIds[path]) {
      this.refresh();
      return;
    }
    this.documents.set(path, this.read(path));
    this.publish();
  }
  deleted(path: string) {
    for (const key of this.documents.keys())
      if (key === path || key.startsWith(path + "/"))
        this.documents.delete(key);
    this.host.settings.update((current) => ({
      ...current,
      noteCollectionFileIds: Object.fromEntries(
        Object.entries(current.noteCollectionFileIds).filter(
          ([key]) => key !== path && !key.startsWith(path + "/"),
        ),
      ),
    }));
    this.publish();
  }
  renamed(from: string, to: string) {
    if (!this.active) return;
    const replace = (path: string) =>
      path === from || path.startsWith(from + "/")
        ? to + path.slice(from.length)
        : path;
    const settings = get(this.host.settings);
    if (
      !settings.noteCollections.some(
        (config) => replace(config.folder) !== config.folder,
      ) &&
      !Object.keys(settings.noteCollectionFileIds).some(
        (path) => replace(path) !== path,
      )
    )
      return;
    this.host.settings.update((current) => ({
      ...current,
      noteCollections: current.noteCollections.map((config) => ({
        ...config,
        folder: replace(config.folder),
      })),
      noteCollectionFileIds: {
        ...Object.fromEntries(
          Object.entries(current.noteCollectionFileIds).filter(
            ([path]) => replace(path) === path,
          ),
        ),
        ...Object.fromEntries(
          Object.entries(current.noteCollectionFileIds)
            .filter(([path]) => replace(path) !== path)
            .map(([path, id]) => [replace(path), id]),
        ),
      },
    }));
    this.refresh();
  }
  inspect(folder: string, recursive: boolean): NoteCollectionInspection {
    const properties = new Map<string, Map<string, NoteScalar>>();
    for (const path of this.host
      .paths()
      .filter((path) => collectionIncludes({ folder, recursive }, path))) {
      for (const [key, value] of Object.entries(this.read(path).properties)) {
        const values = properties.get(key) ?? new Map<string, NoteScalar>();
        for (const scalar of notePropertyValues(value))
          values.set(JSON.stringify(scalar), scalar);
        properties.set(key, values);
      }
    }
    return {
      properties: [...properties.keys()].sort((a, b) => a.localeCompare(b)),
      values: Object.fromEntries(
        [...properties].map(([key, values]) => [
          key,
          [...values.values()].sort((a, b) =>
            String(a).localeCompare(String(b)),
          ),
        ]),
      ),
    };
  }
  private async update(
    change: (settings: DayPlannerSettings) => DayPlannerSettings,
  ) {
    const before = get(this.host.settings),
      draft = change(before),
      identities = { ...draft.noteCollectionFileIds };
    for (const path of this.host.paths())
      if (
        draft.noteCollections.some((config) =>
          collectionIncludes(config, path),
        ) &&
        !identities[path]
      )
        identities[path] = this.host.makeId?.() ?? crypto.randomUUID();
    const next = { ...draft, noteCollectionFileIds: identities };
    this.host.settings.set(next);
    try {
      await this.host.saved();
    } catch (error) {
      // A concurrent settings edit owns its own state; only undo our exact draft.
      if (get(this.host.settings) === next) this.host.settings.set(before);
      throw error;
    }
  }
  async save(input: NoteCollectionConfig) {
    const config = noteCollectionSchema.parse(input);
    if (!this.host.folderExists(config.folder))
      throw Error(
        "This folder is unavailable. Choose an existing vault folder.",
      );
    await this.update((current) => ({
      ...current,
      noteCollections: [
        ...current.noteCollections.filter((entry) => entry.id !== config.id),
        config,
      ],
    }));
  }
  async remove(id: string) {
    await this.update((current) => ({
      ...current,
      noteCollections: current.noteCollections.filter(
        (entry) => entry.id !== id,
      ),
    }));
  }
  async setCompleted(note: CollectionNote, completed: boolean) {
    const settings = get(this.host.settings);
    const config = settings.noteCollections.find(
      (item) => item.id === note.collectionId,
    );
    const mapping = config?.completion;
    if (!config || !mapping || !this.host.writeProperty)
      throw Error(
        "Enable note completion in this collection's settings first.",
      );
    const path = Object.keys(settings.noteCollectionFileIds).find(
      (path) => settings.noteCollectionFileIds[path] === note.id,
    );
    if (
      !path ||
      !this.host.paths().includes(path) ||
      !collectionIncludes(config, path)
    )
      throw Error(
        "This note moved or was removed. Refresh the collection and try again.",
      );
    if (this.pendingCompletions.has(note.id))
      throw Error("This note is still being saved.");
    const expected = note.properties[mapping.property];
    const value = completed ? mapping.checkedValue : mapping.uncheckedValue;
    const before = this.documents.get(path) ?? this.read(path);
    this.pendingCompletions.add(note.id);
    this.documents.set(path, {
      ...before,
      properties: { ...before.properties, [mapping.property]: value },
    });
    this.publish();
    try {
      await this.host.writeProperty(path, mapping.property, value, expected);
    } catch (error) {
      this.changed(path);
      throw error;
    } finally {
      this.pendingCompletions.delete(note.id);
    }
  }
  async open(note: CollectionNote) {
    const settings = get(this.host.settings);
    const path =
      Object.keys(settings.noteCollectionFileIds).find(
        (path) => settings.noteCollectionFileIds[path] === note.id,
      ) ?? note.path;
    if (!this.host.paths().includes(path))
      throw Error(
        "This note moved or was removed. Refresh the collection and try again.",
      );
    await this.host.open(path);
  }
}
