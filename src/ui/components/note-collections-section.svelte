<script lang="ts">
  import {
    CalendarClock,
    ChevronDown,
    ChevronRight,
    Folder,
    Plus,
    Settings,
    Trash2,
    X,
  } from "lucide-svelte";

  import {
    projectNoteCollection,
    isCollectionNoteCompleted,
    notePropertyText,
    noteCollectionFilterSchema,
    collectionNoteLink,
    type CollectionNote,
    type NoteCollectionConfig,
    type NoteScalar,
  } from "../../tasks/note-collection-model";
  import type { NoteCollectionsPort } from "../../tasks/note-collections";
  import type { NoteTaskDrag } from "../../tasks/note-drag";

  import NotePropertyValue from "./note-property-value.svelte";

  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- Svelte validates annotated component props.
  let {
    port,
    noteDrag,
    query = "",
    availableHeight = 600,
  }: {
    port: NoteCollectionsPort;
    noteDrag?: NoteTaskDrag;
    query?: string;
    availableHeight?: number;
  } = $props();
  const source = $derived(port.state);
  let draft = $state<NoteCollectionConfig | null>(null);
  let action = $state<"folder" | "save" | "remove" | null>(null);
  const busy = $derived(action !== null);
  let issue = $state("");
  let collapsed = $state<string[]>([]);
  let collapsedGroups = $state<string[]>([]);
  let completing = $state<string[]>([]);
  let limits = $state<Record<string, number>>({});
  let statusFilters = $state<Record<string, string>>({});
  const inspection = $derived(
    draft?.folder
      ? port.inspect(draft.folder, draft.recursive)
      : { properties: [], values: {} },
  );
  const views = $derived(
    $source.configs.map((config) =>
      projectNoteCollection(
        statusFilters[config.id] && config.statusProperty
          ? {
              ...config,
              filters: [
                ...config.filters,
                noteCollectionFilterSchema.parse({
                  property: config.statusProperty,
                  operator: "is",
                  values: [JSON.parse(statusFilters[config.id]!) as NoteScalar],
                }),
              ],
            }
          : config,
        $source.documents,
        $source.identities,
        query,
      ),
    ),
  );
  function edit(config?: NoteCollectionConfig) {
    issue = "";
    draft = config
      ? structuredClone(config)
      : {
          id: crypto.randomUUID(),
          name: "",
          folder: "",
          recursive: false,
          titleProperty: "",
          statusProperty: "",
          groupProperty: "",
          durationProperty: "",
          visibleProperties: [],
          sortProperty: "",
          sortDirection: "asc",
          filters: [],
        };
  }
  async function chooseFolder() {
    if (!draft) return;
    action = "folder";
    issue = "";
    try {
      const folder = await port.chooseFolder();
      if (folder) {
        draft = {
          ...draft,
          folder,
          name: draft.name || folder.split("/").at(-1)!,
        };
      }
    } catch (error) {
      issue =
        error instanceof Error
          ? error.message
          : "Could not open the folder picker.";
    } finally {
      action = null;
    }
  }
  async function save() {
    if (!draft) return;
    if (!draft.name.trim()) {
      issue = "Enter a collection name.";
      return;
    }
    if (!draft.folder) {
      issue = "Choose a notes folder.";
      return;
    }
    if (
      draft.completion &&
      (!draft.completion.property.trim() ||
        draft.completion.checkedValue === draft.completion.uncheckedValue)
    ) {
      issue =
        "Choose a completion property and different checked/reverted values.";
      return;
    }
    if (
      draft.filters.some(
        (filter) =>
          !filter.property ||
          (["is", "is-not"].includes(filter.operator) &&
            !filter.values.length) ||
          (filter.operator === "contains" && !filter.text.trim()),
      )
    ) {
      issue = "Choose values for each filter, or remove unused filters.";
      return;
    }
    action = "save";
    issue = "";
    try {
      await port.save($state.snapshot(draft));
      delete statusFilters[draft.id];
      draft = null;
    } catch (error) {
      issue =
        error instanceof Error
          ? error.message
          : "Could not save this collection.";
    } finally {
      action = null;
    }
  }
  async function remove() {
    if (!draft) return;
    action = "remove";
    issue = "";
    try {
      await port.remove(draft.id);
      draft = null;
    } catch (error) {
      issue =
        error instanceof Error
          ? error.message
          : "Could not remove this collection.";
    } finally {
      action = null;
    }
  }
  function run(action: () => Promise<void>) {
    void action().catch((error: unknown) => {
      issue =
        error instanceof Error ? error.message : "The note action failed.";
    });
  }
  function startDrag(event: DragEvent, note: CollectionNote) {
    if (!noteDrag || !event.dataTransfer) {
      event.preventDefault();
      return;
    }
    noteDrag.start(
      {
        kind: "note",
        noteId: note.id,
        path: note.path,
        text: collectionNoteLink(note),
        title: note.title,
        durationMinutes: note.durationMinutes,
      },
      event.dataTransfer,
    );
  }
  function cardMetadata(
    note: CollectionNote,
    config: NoteCollectionConfig,
    group: string,
  ) {
    const seen = new Set<string>([group]);
    return [
      ...new Set([config.statusProperty, ...config.visibleProperties]),
    ].flatMap((property) => {
      const text = notePropertyText(note.properties[property]);
      if (
        !property ||
        property === config.groupProperty ||
        !text ||
        seen.has(text)
      )
        return [];
      seen.add(text);
      return [{ property, text }];
    });
  }
  async function complete(note: CollectionNote, checked: boolean) {
    if (!port.setCompleted || completing.includes(note.id)) return;
    completing = [...completing, note.id];
    issue = "";
    try {
      await port.setCompleted(note, checked);
    } catch (error) {
      issue =
        error instanceof Error
          ? error.message
          : "Could not update the note property.";
    } finally {
      completing = completing.filter((id) => id !== note.id);
    }
  }
  function availableProperties(current: string) {
    return [
      ...new Set([...inspection.properties, ...(current ? [current] : [])]),
    ];
  }
  function toggleValue(index: number, value: NoteScalar, checked: boolean) {
    if (!draft) return;
    const filter = draft.filters[index]!;
    filter.values = checked
      ? [...filter.values.filter((item) => item !== value), value]
      : filter.values.filter((item) => item !== value);
  }
</script>

<section class="note-collections" aria-label="Note collections">
  <div class="collections-toolbar">
    <span>Collections</span><button onclick={() => edit()} type="button"
      ><Plus size={14} /> Add collection</button
    >
  </div>
  {#if issue}<p class="collection-error" role="alert">{issue}</p>{/if}
  {#if $source.error}<p class="collection-error" role="alert">
      {$source.error}
    </p>{/if}
  {#if draft}
    <form
      style:max-height={Math.max(100, availableHeight - 64) + "px"}
      class="collection-editor"
      aria-label="Collection settings"
      onsubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <div class="editor-heading">
        <strong
          >{$source.configs.some((entry) => entry.id === draft!.id)
            ? "Edit collection"
            : "Add collection"}</strong
        >
        {#if $source.configs.some((entry) => entry.id === draft!.id)}<button
            class="icon-button remove-collection"
            aria-label="Remove collection"
            disabled={busy}
            onclick={() => void remove()}
            title="Remove collection"
            type="button"><Trash2 size={14} /></button
          >{/if}
      </div>
      <div class="editor-scroll">
        <fieldset class="editor-fields" disabled={busy}>
          <label
            >Name<input
              aria-label="Collection name"
              maxlength="100"
              placeholder="Collection name"
              bind:value={draft.name}
            /></label
          >
          <div class="folder-field">
            <span>Folder</span><button
              onclick={() => void chooseFolder()}
              type="button"
              ><Folder size={14} /><span>{draft.folder || "Choose folder"}</span
              ></button
            >
          </div>
          <label class="check-row"
            ><input type="checkbox" bind:checked={draft.recursive} />Include
            subfolders</label
          >
          <label class="check-row"
            ><input
              aria-label="Allow note completion"
              checked={Boolean(draft.completion)}
              onchange={(event) => {
                if (!draft) return;
                draft.completion = event.currentTarget.checked
                  ? {
                      property: "completed",
                      checkedValue: true,
                      uncheckedValue: false,
                    }
                  : undefined;
              }}
              type="checkbox"
            />Allow notes to be ticked off</label
          >
          {#if draft.completion}
            <div class="completion-settings">
              <label
                >Property to update<input
                  aria-label="Completion property"
                  list="collection-completion-properties"
                  maxlength="200"
                  placeholder="completed"
                  bind:value={draft.completion.property}
                /></label
              >
              <datalist id="collection-completion-properties"
                >{#each availableProperties(draft.completion.property) as property}<option
                    value={property}
                  ></option>{/each}</datalist
              >
              <NotePropertyValue
                label="When checked"
                bind:value={draft.completion.checkedValue}
              />
              <NotePropertyValue
                label="When reverted"
                bind:value={draft.completion.uncheckedValue}
              />
              <small
                >Updates only this property in the source note. Existing filters
                and grouping still apply.</small
              >
            </div>
          {/if}
          <details>
            <summary>Customize display</summary>
            {#each ["titleProperty", "statusProperty", "groupProperty", "sortProperty", "durationProperty"] as key}
              {@const field = key as
                | "titleProperty"
                | "statusProperty"
                | "groupProperty"
                | "sortProperty"
                | "durationProperty"}
              {@const labels = {
                titleProperty: "Title",
                statusProperty: "Status",
                groupProperty: "Group by",
                sortProperty: "Sort by",
                durationProperty: "Duration (minutes)",
              }}
              <label
                >{labels[field]}<select
                  aria-label={labels[field]}
                  bind:value={draft[field]}
                >
                  <option value=""
                    >{field === "titleProperty"
                      ? "File name"
                      : field === "sortProperty"
                        ? "Title"
                        : "None"}</option
                  >
                  {#each availableProperties(draft[field]) as name}<option
                      value={name}>{name}</option
                    >{/each}
                </select></label
              >
            {/each}
            <label
              >Sort order<select
                aria-label="Sort order"
                bind:value={draft.sortDirection}
                ><option value="asc">Ascending</option><option value="desc"
                  >Descending</option
                ></select
              ></label
            >
            <div class="property-selection">
              <span>Show properties</span>
              {#if !inspection.properties.length}<small
                  >Choose a folder with note properties to see available fields.</small
                >{/if}
              {#each [...new Set( [...inspection.properties, ...draft.visibleProperties], )] as property}
                <label class="check-row"
                  ><input
                    type="checkbox"
                    value={property}
                    bind:group={draft.visibleProperties}
                  />{property}</label
                >
              {/each}
            </div>
            <div class="filters-heading">
              <span>Filters</span><button
                onclick={() =>
                  draft &&
                  draft.filters.push({
                    property: inspection.properties[0] || "Property",
                    operator: "is",
                    values: [],
                    text: "",
                  })}
                type="button">Add filter</button
              >
            </div>
            {#each draft.filters as filter, index}
              <div class="collection-filter">
                <div class="filter-controls">
                  <select
                    aria-label={"Filter property " + (index + 1)}
                    bind:value={filter.property}
                  >
                    {#each availableProperties(filter.property) as property}<option
                        value={property}>{property}</option
                      >{/each}
                  </select><select
                    aria-label={"Filter match " + (index + 1)}
                    bind:value={filter.operator}
                  >
                    <option value="is">Is any of</option><option value="is-not"
                      >Is none of</option
                    ><option value="contains">Contains</option><option
                      value="is-empty">Is empty</option
                    ><option value="is-set">Is set</option>
                  </select><button
                    class="icon-button"
                    aria-label={"Remove filter " + (index + 1)}
                    onclick={() => draft?.filters.splice(index, 1)}
                    type="button"><X size={14} /></button
                  >
                </div>
                {#if filter.operator === "contains"}<input
                    aria-label={"Filter text " + (index + 1)}
                    bind:value={filter.text}
                  />
                {:else if filter.operator === "is" || filter.operator === "is-not"}
                  <div class="filter-values">
                    {#each [...new Map([...(inspection.values[filter.property] ?? []), ...filter.values].map( (value) => [JSON.stringify(value), value], )).values()] as value}
                      <label class="check-row"
                        ><input
                          checked={filter.values.some(
                            (entry) => entry === value,
                          )}
                          onchange={(event) =>
                            toggleValue(
                              index,
                              value,
                              event.currentTarget.checked,
                            )}
                          type="checkbox"
                        />{String(value)}{typeof value !== "string"
                          ? " (" + typeof value + ")"
                          : ""}</label
                      >
                    {/each}
                    {#if !inspection.values[filter.property]?.length && !filter.values.length}<small
                        >No values found for this property.</small
                      >{/if}
                  </div>
                {/if}
              </div>
            {/each}
          </details>
        </fieldset>
      </div>
      <div class="editor-footer">
        <button
          disabled={busy}
          onclick={() => {
            draft = null;
            issue = "";
          }}
          type="button">Cancel</button
        >
        <button class="mod-cta" disabled={busy} type="submit"
          >{action === "save" ? "Saving…" : "Save"}</button
        >
      </div>
    </form>
  {/if}
  {#each views as view (view.config.id)}
    {@const expanded = !collapsed.includes(view.config.id)}
    {@const visible = new Set(
      view.items.slice(0, limits[view.config.id] ?? 50).map((item) => item.id),
    )}
    <section class="note-collection" aria-label={view.config.name}>
      <div class="collection-heading">
        <button
          class="collection-toggle"
          aria-expanded={expanded}
          onclick={() => {
            collapsed = expanded
              ? [...collapsed, view.config.id]
              : collapsed.filter((id) => id !== view.config.id);
          }}
          type="button"
        >
          {#if expanded}<ChevronDown size={14} />{:else}<ChevronRight
              size={14}
            />{/if}<Folder size={14} /><strong>{view.config.name}</strong><span
            class="collection-count">{view.items.length}</span
          >
        </button><button
          class="icon-button"
          aria-label={"Configure " + view.config.name}
          onclick={() => edit(view.config)}
          type="button"><Settings size={14} /></button
        >
      </div>
      {#if expanded}
        {#if $source.missingFolders.includes(view.config.id)}<p
            class="collection-error"
          >
            Folder unavailable: {view.config.folder}. Choose its new location in
            collection settings.
          </p>
        {:else}
          {#if view.config.statusProperty}
            <select
              class="collection-status"
              aria-label={view.config.name + " status"}
              onchange={(event) => {
                statusFilters = {
                  ...statusFilters,
                  [view.config.id]: event.currentTarget.value,
                };
              }}
              value={statusFilters[view.config.id] ?? ""}
            >
              <option value="">All statuses</option
              >{#each port.inspect(view.config.folder, view.config.recursive).values[view.config.statusProperty] ?? [] as status}<option
                  value={JSON.stringify(status)}>{String(status)}</option
                >{/each}
            </select>
          {/if}
          {#if !view.items.length}<p class="collection-empty">
              {view.total
                ? "No notes match these filters."
                : "No Markdown notes in this folder."}
            </p>{/if}
          {#each view.groups as group (group.name)}
            {#if group.items.some((item) => visible.has(item.id))}
              {@const groupKey = JSON.stringify([view.config.id, group.name])}
              {@const groupExpanded = !collapsedGroups.includes(groupKey)}
              {#if group.name}<h4 class="collection-group-title">
                  <button
                    class="collection-group-toggle"
                    aria-expanded={groupExpanded}
                    aria-label={"Toggle " + group.name}
                    onclick={() =>
                      (collapsedGroups = groupExpanded
                        ? [...collapsedGroups, groupKey]
                        : collapsedGroups.filter((key) => key !== groupKey))}
                    type="button"
                  >
                    {#if groupExpanded}<ChevronDown
                        size={13}
                      />{:else}<ChevronRight size={13} />{/if}
                    <span class="collection-group-name">{group.name}</span><span
                      class="collection-count">{group.items.length}</span
                    >
                  </button>
                </h4>{/if}
              {#if !group.name || groupExpanded}<div
                  class="collection-notes"
                  role="list"
                >
                  {#each group.items.filter( (item) => visible.has(item.id), ) as note (note.id)}
                    {@const completed = isCollectionNoteCompleted(
                      note,
                      view.config,
                    )}
                    {@const metadata = cardMetadata(
                      note,
                      view.config,
                      group.name,
                    )}
                    <div
                      class="collection-note"
                      class:is-completed={completed}
                      role="listitem"
                    >
                      {#if view.config.completion && port.setCompleted}<input
                          class="collection-note-complete"
                          aria-label={(completed ? "Revert " : "Complete ") +
                            note.title}
                          checked={completed}
                          disabled={completing.includes(note.id)}
                          onchange={(event) =>
                            void complete(note, event.currentTarget.checked)}
                          type="checkbox"
                        />{/if}
                      <button
                        class="collection-note-open"
                        draggable={Boolean(noteDrag)}
                        onclick={() => run(() => port.open(note))}
                        ondragend={() => noteDrag?.cancel()}
                        ondragstart={(event) => startDrag(event, note)}
                        title={note.path}
                        type="button"
                      >
                        <span class="collection-note-title">{note.title}</span>
                        {#if metadata.length}<span class="collection-metadata">
                            {#each metadata as item}<span title={item.property}
                                >{item.text}</span
                              >{/each}
                          </span>{/if}
                      </button>
                      {#if port.schedule}<button
                          class="icon-button schedule-note"
                          aria-label={"Schedule " + note.title}
                          onclick={() => run(() => port.schedule!(note))}
                          title="Schedule a linked session"
                          type="button"><CalendarClock size={15} /></button
                        >{/if}
                    </div>
                  {/each}
                </div>{/if}
            {/if}
          {/each}
          {#if visible.size < view.items.length}<button
              class="show-more"
              onclick={() => {
                limits = {
                  ...limits,
                  [view.config.id]: (limits[view.config.id] ?? 50) + 50,
                };
              }}
              type="button">Show more notes</button
            >{/if}
        {/if}
      {/if}
    </section>
  {/each}
</section>

<style>
  .note-collections {
    min-width: 0;
    padding: 10px 12px;
    color: var(--text-normal);
  }

  .collections-toolbar,
  .collection-heading,
  .filters-heading,
  .editor-footer,
  .filter-controls {
    display: flex;
    gap: 8px;
    align-items: center;
  }

  .collections-toolbar,
  .filters-heading {
    justify-content: space-between;
    margin-bottom: 8px;
  }

  .collections-toolbar > span,
  .filters-heading > span {
    font-size: 12px;
    font-weight: 600;
    color: var(--text-muted);
  }

  button {
    display: inline-flex;
    gap: 6px;
    align-items: center;
    justify-content: center;

    max-width: 100%;
    min-height: 30px;

    font: inherit;
    font-size: 12px;
    white-space: nowrap;
  }

  .icon-button {
    flex: none;
    width: 30px;
    height: 30px;
    padding: 0;
  }

  .note-collection {
    margin-top: 6px;
    padding-bottom: 8px;
    border-bottom: 1px solid var(--background-modifier-border);
  }

  .collection-heading {
    min-width: 0;
  }

  .collection-toggle {
    flex: 1;
    justify-content: flex-start;

    min-width: 0;
    padding: 6px 0;

    color: var(--text-normal);

    background: none;
    border: 0;
    box-shadow: none;
  }

  .collection-toggle strong {
    font-size: 13px;
    text-align: left;
    overflow-wrap: anywhere;
    white-space: normal;
  }

  .collection-toggle :global(svg) {
    flex: none;
  }

  .collection-count {
    margin-left: auto;
    padding: 0 5px;
    font-size: 11px;
    color: var(--text-muted);
  }

  .collection-status {
    width: 100%;
    max-width: 240px;
    margin: 4px 0 8px;
  }

  .collection-notes {
    display: grid;
    gap: 4px;
  }

  .collection-note {
    display: flex;
    gap: 4px;
    align-items: flex-start;

    background: var(--background-primary-alt);
    border-radius: 6px;
  }

  .collection-note:hover {
    background: var(--background-modifier-hover);
  }

  .collection-note-open {
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: 4px;
    align-items: stretch;

    min-width: 0;
    padding: 8px;

    color: var(--text-normal);
    text-align: left;
    white-space: normal;

    background: none;
    border: 0;
    box-shadow: none;
  }

  .collection-note-title {
    font-size: 14px;
    line-height: 1.4;
    overflow-wrap: anywhere;
  }

  .collection-metadata {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 10px;

    font-size: 11px;
    line-height: 1.4;
    color: var(--text-muted);
    overflow-wrap: anywhere;
  }

  .schedule-note {
    margin-top: 5px;
    background: none;
    border: 0;
    box-shadow: none;
  }

  .collection-group-toggle {
    display: flex;
    gap: 6px;
    align-items: center;

    width: 100%;
    padding: 3px 0;

    font: inherit;
    color: inherit;

    background: none;
    border: 0;
    box-shadow: none;
  }

  .collection-group-name {
    text-align: left;
    overflow-wrap: anywhere;
  }

  .collection-group-toggle :global(svg) {
    flex: none;
  }

  .collection-note-complete {
    flex: none;

    width: 16px;
    height: 16px;
    margin: 11px 0 0 8px;

    border-radius: 50%;
  }

  .collection-note.is-completed .collection-note-title {
    color: var(--text-muted);
    text-decoration: line-through;
  }

  .completion-settings {
    display: grid;
    gap: 12px;

    padding: 10px;

    border: 1px solid var(--background-modifier-border);
    border-radius: 6px;
  }

  .collection-group-title {
    margin: 12px 0 6px;
    font-size: 12px;
    font-weight: 600;
    color: var(--text-muted);
  }

  .collection-error {
    font-size: 12px;
    color: var(--text-error);
    overflow-wrap: anywhere;
  }

  .collection-empty {
    margin: 8px 0;
    font-size: 12px;
    color: var(--text-muted);
  }

  .collection-editor {
    overflow: hidden;
    display: flex;
    flex-direction: column;

    max-height: min(650px, 75vh);
    margin-bottom: 12px;

    background: var(--background-primary);
    border: 1px solid var(--background-modifier-border);
    border-radius: 8px;
  }

  .editor-heading {
    display: flex;
    flex: none;
    gap: 8px;
    align-items: center;
    justify-content: space-between;

    padding: 12px;

    font-size: 14px;

    border-bottom: 1px solid var(--background-modifier-border);
  }

  .editor-fields {
    display: grid;
    gap: 12px;

    min-width: 0;
    margin: 0;
    padding: 12px;

    border: 0;
  }

  .editor-scroll {
    overflow: auto;
    min-height: 0;
  }

  .property-selection,
  .filter-values {
    overflow: auto;
    display: grid;
    gap: 2px;
    max-height: 160px;
  }

  .property-selection > span {
    margin-bottom: 5px;
    font-size: 12px;
  }

  details > label,
  details > .property-selection {
    margin-bottom: 12px;
  }

  .editor-fields label:not(.check-row),
  .folder-field {
    display: grid;
    gap: 5px;
    min-width: 0;
    font-size: 12px;
  }

  input:not([type="checkbox"]),
  select {
    box-sizing: border-box;
    width: 100%;
    min-width: 0;
    min-height: 32px;

    font-size: 13px;
  }

  .folder-field button {
    justify-content: flex-start;
    min-height: 34px;
  }

  .folder-field button span {
    text-align: left;
    overflow-wrap: anywhere;
    white-space: normal;
  }

  .check-row {
    display: flex;
    gap: 8px;
    align-items: center;

    min-height: 28px;
    margin: 0;

    font-size: 12px;
  }

  .check-row input {
    flex: none;
    margin: 0;
  }

  details {
    min-width: 0;
  }

  summary {
    cursor: pointer;
    margin: 4px 0 10px;
    font-size: 13px;
  }

  small {
    font-size: 11px;
    line-height: 1.4;
    color: var(--text-muted);
  }

  .collection-filter {
    display: grid;
    gap: 6px;

    margin-bottom: 8px;
    padding: 8px;

    border: 1px solid var(--background-modifier-border);
    border-radius: 6px;
  }

  .filter-controls select {
    flex: 1;
  }

  .editor-footer {
    flex: none;
    flex-wrap: wrap;
    justify-content: flex-end;

    padding: 10px 12px;

    border-top: 1px solid var(--background-modifier-border);
  }

  .remove-collection {
    color: var(--text-muted);
    background: none;
    box-shadow: none;
  }

  .editor-footer button {
    min-width: 72px;
    color: var(--text-normal);
    background: var(--interactive-normal);
  }

  .editor-footer .mod-cta {
    color: var(--text-on-accent);
    background: var(--interactive-accent);
  }

  .show-more {
    margin: 8px 0;
  }
</style>
