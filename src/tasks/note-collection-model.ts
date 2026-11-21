import { z } from "zod";

const vaultPath = (value: string) =>
  !!value &&
  !/^[\\/]|^[a-z]:|\\|\p{Cc}/iu.test(value) &&
  value.split("/").every((part) => !!part && part !== "." && part !== "..");
export const noteScalarSchema = z.union([
  z.string(),
  z.number().finite(),
  z.boolean(),
]);
export type NoteScalar = z.infer<typeof noteScalarSchema>;
export type NoteProperty = NoteScalar | null | NoteProperty[];
export const noteCollectionFilterSchema = z
  .object({
    property: z.string().min(1).max(200),
    operator: z.enum(["is", "is-not", "contains", "is-empty", "is-set"]),
    values: z.array(noteScalarSchema).max(100).default([]),
    text: z.string().max(1000).default(""),
  })
  .refine(
    (filter) =>
      !["is", "is-not"].includes(filter.operator) || filter.values.length > 0,
    "Choose at least one filter value.",
  )
  .refine(
    (filter) => filter.operator !== "contains" || !!filter.text.trim(),
    "Enter filter text.",
  );
export type NoteCollectionFilter = z.infer<typeof noteCollectionFilterSchema>;
export const noteCollectionSchema = z.object({
  id: z.string().min(1).max(100),
  name: z.string().trim().min(1).max(100),
  folder: z.string().refine(vaultPath, "Choose a folder inside this vault."),
  recursive: z.boolean().default(false),
  completion: z
    .object({
      property: z
        .string()
        .trim()
        .min(1)
        .max(200)
        .refine(
          (name) =>
            !["__proto__", "constructor", "prototype", "position"].includes(
              name,
            ),
          "Choose a writable note property.",
        ),
      checkedValue: noteScalarSchema,
      uncheckedValue: noteScalarSchema,
    })
    .refine(
      (value) => value.checkedValue !== value.uncheckedValue,
      "Checked and reverted values must differ.",
    )
    .optional(),
  titleProperty: z.string().max(200).default(""),
  statusProperty: z.string().max(200).default(""),
  groupProperty: z.string().max(200).default(""),
  durationProperty: z.string().max(200).default(""),
  visibleProperties: z.array(z.string().min(1).max(200)).max(12).default([]),
  sortProperty: z.string().max(200).default(""),
  sortDirection: z.enum(["asc", "desc"]).default("asc"),
  filters: z.array(noteCollectionFilterSchema).max(20).default([]),
});
export type NoteCollectionConfig = z.infer<typeof noteCollectionSchema>;
export const noteCollectionsSchema = z
  .array(noteCollectionSchema)
  .max(100)
  .refine(
    (items) => new Set(items.map((item) => item.id)).size === items.length,
    "Collection identities must be unique.",
  );
export const noteCollectionIdsSchema = z
  .record(z.string().refine(vaultPath), z.string().min(1).max(100))
  .refine(
    (items) =>
      new Set(Object.values(items)).size === Object.values(items).length,
    "Note identities must be unique.",
  );
export interface CollectionDocument {
  path: string;
  properties: Record<string, NoteProperty>;
}
export interface CollectionNote {
  kind: "note";
  id: string;
  collectionId: string;
  path: string;
  title: string;
  properties: Record<string, NoteProperty>;
  durationMinutes?: number;
}
export interface CollectionGroup {
  name: string;
  items: CollectionNote[];
}
export interface NoteCollectionView {
  config: NoteCollectionConfig;
  items: CollectionNote[];
  groups: CollectionGroup[];
  total: number;
  issue?: string;
}
export function collectionIncludes(
  config: Pick<NoteCollectionConfig, "folder" | "recursive">,
  path: string,
) {
  if (
    !path.toLowerCase().endsWith(".md") ||
    !path.startsWith(config.folder + "/")
  )
    return false;
  return (
    config.recursive || !path.slice(config.folder.length + 1).includes("/")
  );
}
export function normalizeNoteProperty(value: unknown, depth = 0): NoteProperty {
  if (
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  )
    return value;
  if (value instanceof Date && Number.isFinite(value.getTime()))
    return value.toISOString();
  if (Array.isArray(value) && depth < 4)
    return value
      .slice(0, 100)
      .map((entry: unknown) => normalizeNoteProperty(entry, depth + 1));
  return null;
}
export function notePropertyValues(
  value: NoteProperty | undefined,
): NoteScalar[] {
  if (Array.isArray(value)) return value.flatMap(notePropertyValues);
  return value === null || value === undefined || value === "" ? [] : [value];
}
export const notePropertyText = (value: NoteProperty | undefined) =>
  notePropertyValues(value).map(String).join(", ");
export function noteMatchesFilter(
  document: CollectionDocument,
  filter: NoteCollectionFilter,
) {
  const values = notePropertyValues(document.properties[filter.property]);
  switch (filter.operator) {
    case "is-empty":
      return !values.length;
    case "is-set":
      return !!values.length;
    case "contains":
      return values.some((value) =>
        String(value)
          .toLocaleLowerCase()
          .includes(filter.text.toLocaleLowerCase()),
      );
    case "is":
      return (
        filter.values.length > 0 &&
        values.some((value) => filter.values.some((wanted) => value === wanted))
      );
    case "is-not":
      return !values.some((value) =>
        filter.values.some((wanted) => value === wanted),
      );
  }
}
export function projectNoteCollection(
  config: NoteCollectionConfig,
  documents: Iterable<CollectionDocument>,
  identities: Record<string, string>,
  query = "",
): NoteCollectionView {
  const all = [...documents].filter((document) =>
    collectionIncludes(config, document.path),
  );
  const search = query.trim().toLocaleLowerCase();
  const items = all
    .filter((document) =>
      config.filters.every((filter) => noteMatchesFilter(document, filter)),
    )
    .map((document): CollectionNote => {
      const duration = document.properties[config.durationProperty];
      return {
        kind: "note",
        id: identities[document.path] ?? document.path,
        collectionId: config.id,
        path: document.path,
        title:
          notePropertyText(document.properties[config.titleProperty]).trim() ||
          document.path.split("/").at(-1)!.slice(0, -3),
        properties: document.properties,
        ...(typeof duration === "number" &&
        Number.isFinite(duration) &&
        duration >= 1 &&
        duration <= 1440
          ? { durationMinutes: duration }
          : {}),
      };
    })
    .filter(
      (item) =>
        !search ||
        [
          item.title,
          item.path,
          ...Object.values(item.properties).map(notePropertyText),
        ].some((value) => value.toLocaleLowerCase().includes(search)),
    );
  const collator = new Intl.Collator(undefined, {
    numeric: true,
    sensitivity: "base",
  });
  items.sort((a, b) => {
    const av = config.sortProperty
      ? a.properties[config.sortProperty]
      : a.title;
    const bv = config.sortProperty
      ? b.properties[config.sortProperty]
      : b.title;
    const emptyA = !notePropertyValues(av).length,
      emptyB = !notePropertyValues(bv).length;
    if (emptyA !== emptyB) return emptyA ? 1 : -1;
    const order =
      typeof av === "number" && typeof bv === "number"
        ? av - bv
        : collator.compare(notePropertyText(av), notePropertyText(bv));
    return (
      order * (config.sortDirection === "desc" ? -1 : 1) ||
      collator.compare(a.title, b.title) ||
      a.path.localeCompare(b.path)
    );
  });
  const groups = new Map<string, CollectionNote[]>();
  for (const item of items) {
    const names = config.groupProperty
      ? [
          ...new Set(
            notePropertyValues(item.properties[config.groupProperty]).map(
              String,
            ),
          ),
        ]
      : [""];
    for (const name of names.length ? names : ["No " + config.groupProperty])
      groups.set(name, [...(groups.get(name) ?? []), item]);
  }
  return {
    config,
    items,
    total: all.length,
    groups: [...groups]
      .sort(([a], [b]) => collator.compare(a, b))
      .map(([name, rows]) => ({ name, items: rows })),
  };
}

/** Markdown link destinations are encoded so filenames/titles cannot introduce note syntax or tasks. */
export function collectionNoteLink(
  note: Pick<CollectionNote, "path" | "title">,
) {
  if (!vaultPath(note.path) || !note.path.toLowerCase().endsWith(".md"))
    throw Error("The source note path is invalid.");
  const label = note.title
    .replace(/\p{Cc}/gu, " ")
    .replace(/([\\[\]*_`<>#])/g, "\\$1");
  const path = note.path
    .split("/")
    .map((part) =>
      encodeURIComponent(part).replace(
        /[!'()*]/g,
        (char) => "%" + char.charCodeAt(0).toString(16),
      ),
    )
    .join("/");
  return "[" + label + "](" + path + ")";
}

/** Completion is opt-in and preserves scalar types, including false and zero. */
export function isCollectionNoteCompleted(
  note: CollectionNote,
  config: NoteCollectionConfig,
) {
  return Boolean(
    config.completion &&
      note.properties[config.completion.property] ===
        config.completion.checkedValue,
  );
}
