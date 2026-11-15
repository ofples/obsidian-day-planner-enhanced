<script lang="ts">
  import { get } from "svelte/store";

  import { getDateRangeContext } from "../../context/date-range-context";
  import { getObsidianContext } from "../../context/obsidian-context";

  const context = getObsidianContext();
  const range = getDateRangeContext();
  let control: HTMLSelectElement;

  function editable(target: EventTarget | null) {
    const node = target as Node | null;
    return Boolean(
      node?.nodeType === 1 &&
        (node as Element).closest(
          'input, textarea, select, [contenteditable="true"]',
        ),
    );
  }
  function focusPlanner(event: PointerEvent) {
    const root = control.closest<HTMLElement>(".workspace-leaf-content");
    if (
      !root ||
      (event.target as Node | null)?.nodeType !== 1 ||
      !root.contains(event.target as Node) ||
      editable(event.target)
    )
      return;
    if ((event.target as Element).closest("button, a")) return;
    root.tabIndex = 0;
    root.focus({ preventScroll: true });
  }
  function change(count: number) {
    void context.showPlannerDays?.(count, range.first, control);
  }
  function shortcut(event: KeyboardEvent) {
    const root = control.closest(".workspace-leaf-content");
    if (
      !root ||
      (event.target as Node | null)?.nodeType !== 1 ||
      !root.contains(event.target as Node) ||
      editable(event.target) ||
      event.ctrlKey ||
      event.metaKey ||
      event.altKey ||
      event.repeat
    )
      return;
    if (get(context.editContext.editOperation)) return;
    const key = event.key.toLowerCase();
    const count =
      key === "d"
        ? 1
        : key === "w"
          ? 7
          : /^[1-7]$/.test(key)
            ? Number(key)
            : undefined;
    if (!count) return;
    event.preventDefault();
    change(count);
  }
  function listen(node: HTMLSelectElement) {
    const doc = node.ownerDocument;
    doc.addEventListener("keydown", shortcut);
    doc.addEventListener("pointerdown", focusPlanner);
    return {
      destroy() {
        doc.removeEventListener("keydown", shortcut);
        doc.removeEventListener("pointerdown", focusPlanner);
      },
    };
  }
</script>

<select
  bind:this={control}
  aria-label="Days shown"
  onchange={(event) => change(Number(event.currentTarget.value))}
  title="Days shown · 1–7, D for day, W for week"
  value={range.current.length}
  use:listen
>
  {#each [1, 2, 3, 4, 5, 6, 7] as count}
    <option value={count}>{count} {count === 1 ? "day" : "days"}</option>
  {/each}
</select>

<style>
  select {
    max-width: 85px;
    height: 26px;
    padding: 0 5px;

    font-size: var(--font-ui-small);

    background: var(--background-primary);
    border: 1px solid var(--background-modifier-border);
    border-radius: 4px;
  }
</style>
