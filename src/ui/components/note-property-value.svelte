<script lang="ts">
  import type { NoteScalar } from "../../tasks/note-collection-model";
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- Svelte validates the annotated component props.
  let { label, value = $bindable() }: { label: string; value: NoteScalar } =
    $props();
</script>

<div class="property-value">
  <label
    >{label}
    <select
      aria-label={label + " type"}
      onchange={(event) => {
        value =
          event.currentTarget.value === "boolean"
            ? true
            : event.currentTarget.value === "number"
              ? 0
              : "";
      }}
      value={typeof value}
    >
      <option value="string">Text</option><option value="boolean"
        >Checkbox</option
      ><option value="number">Number</option>
    </select>
  </label>
  {#if typeof value === "boolean"}
    <select
      aria-label={label}
      onchange={(event) => (value = event.currentTarget.value === "true")}
      value={String(value)}
    >
      <option value="true">True / checked</option><option value="false"
        >False / unchecked</option
      >
    </select>
  {:else if typeof value === "number"}
    <input
      aria-label={label}
      oninput={(event) => {
        if (Number.isFinite(event.currentTarget.valueAsNumber))
          value = event.currentTarget.valueAsNumber;
      }}
      type="number"
      {value}
    />
  {:else}
    <input
      aria-label={label}
      oninput={(event) => (value = event.currentTarget.value)}
      type="text"
      {value}
    />
  {/if}
</div>

<style>
  .property-value {
    display: grid;
    gap: 5px;
    min-width: 0;
  }

  label {
    display: grid;
    gap: 5px;
    font-size: 12px;
  }

  input,
  select {
    box-sizing: border-box;
    width: 100%;
    min-width: 0;
    min-height: 32px;

    font-size: 13px;
  }
</style>
