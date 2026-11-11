<script lang="ts">
  import { onMount, untrack } from "svelte";
  import { get, type Writable } from "svelte/store";

  import type { DayPlannerSettings } from "../../settings";
  import type { TaskCapture } from "../../tasks/capture";
  import {
    taskAccountKey,
    taskAccountSettings,
    taskCaptureSettingsSchema,
  } from "../../tasks/capture-settings";
  import type { TaskService } from "../../tasks/service";

  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- Svelte validates annotated component props.
  let {
    service,
    capture,
    settings,
    saved,
    cancel,
    calendarSettings,
  }: {
    service: TaskService;
    capture: TaskCapture;
    settings: Writable<DayPlannerSettings>;
    saved: () => void;
    cancel: () => void;
    calendarSettings?: () => void;
  } = $props();
  const opened = untrack(() => ({
    snapshot: get(service.state).snapshot,
    config: structuredClone(get(settings).taskCapture),
  }));
  const account = opened.snapshot
    ? taskAccountSettings(opened.config, opened.snapshot)
    : null;
  let enabled = $state(opened.config.enabled);
  let roots = $state(opened.config.roots.join("\n"));
  let defaultProjectId = $state(account?.defaultProjectId ?? "");
  let projectTags = $state<Record<string, string>>(
    Object.fromEntries(
      (opened.snapshot?.projects ?? []).map((project) => [
        project.id,
        Object.entries(account?.projectMappings ?? {})
          .filter(([, id]) => id === project.id)
          .map(([tag]) => tag)
          .join(", "),
      ]),
    ),
  );
  let labels = $state(
    Object.entries(account?.labelMappings ?? {})
      .map(([tag, label]) => `${tag} = ${label}`)
      .join("\n"),
  );
  let error = $state("");
  let form: HTMLFormElement;
  onMount(() => form.querySelector<HTMLElement>("input, textarea")?.focus());
  function submit(event: SubmitEvent) {
    event.preventDefault();
    error = "";
    try {
      const snapshot = opened.snapshot;
      const current = get(service.state).snapshot;
      if (
        snapshot &&
        (current?.provider !== snapshot.provider ||
          current.account.id !== snapshot.account.id)
      )
        throw new Error(
          "Reopen capture settings for the current task account.",
        );
      const projectMappings = Object.entries(projectTags).flatMap(
        ([id, tags]) =>
          tags
            .split(",")
            .map((tag) => tag.trim().replace(/^#/, "").toLowerCase())
            .filter(Boolean)
            .map((tag) => [tag, id] as const),
      );
      if (
        new Set(projectMappings.map(([tag]) => tag)).size !==
        projectMappings.length
      )
        throw new Error(
          "Map each tag to one project. Use different tags to request a routing choice.",
        );
      const labelMappings = labels
        .split(/\r?\n/)
        .filter((line) => line.trim())
        .map((line): [string, string] => {
          const match = line.match(
            /^\s*#?([\p{L}\p{M}\p{N}_/-]+)\s*=\s*(\S.*?)\s*$/u,
          );
          if (!match)
            throw new Error("Enter each label mapping as tag = Todoist label.");
          return [match[1]!.toLowerCase(), match[2]!.trim()];
        });
      settings.update((value) => {
        const config = {
          ...value.taskCapture,
          enabled,
          roots: roots
            .split(/\r?\n/)
            .map((root) =>
              root
                .trim()
                .replace(/\\/g, "/")
                .replace(/^\/+|\/+$/g, ""),
            )
            .filter(Boolean),
          accounts: snapshot
            ? {
                ...value.taskCapture.accounts,
                [taskAccountKey(snapshot)]: {
                  ...taskAccountSettings(value.taskCapture, snapshot),
                  defaultProjectId,
                  projectMappings: Object.fromEntries(projectMappings),
                  labelMappings: Object.fromEntries(labelMappings),
                },
              }
            : value.taskCapture.accounts,
        };
        const valid = Object.values(config.accounts).every((account) =>
          [
            ...Object.keys(account.projectMappings),
            ...Object.keys(account.labelMappings),
          ].every(
            (tag) => tag !== "todoist" && /^[\p{L}\p{M}\p{N}_/-]+$/u.test(tag),
          ),
        );
        if (!valid)
          throw new Error(
            "Use valid Obsidian tags for routing. Reserve #todoist for capture.",
          );
        return {
          ...value,
          taskCapture: taskCaptureSettingsSchema.parse(config),
        };
      });
      void capture.scan();
      saved();
    } catch (failure) {
      error =
        failure instanceof Error
          ? failure.message
          : "Could not save capture settings. Check the fields.";
    }
  }
</script>

<form
  bind:this={form}
  class="task-panel-form"
  aria-label="Capture and routing settings"
  onsubmit={submit}
>
  <h3>Capture and routing</h3>
  {#if calendarSettings}<button
      class="task-text-button"
      onclick={calendarSettings}
      type="button">Task calendar feeds</button
    >{/if}
  <label class="task-check-label"
    ><input
      class="task-toggle"
      role="switch"
      type="checkbox"
      bind:checked={enabled}
    />Capture #todoist tasks</label
  >
  <p class="task-form-context">Tagged tasks sync after you leave their line.</p>
  <label
    >Capture folders<textarea
      aria-label="Capture folders"
      placeholder="Planning"
      rows="2"
      bind:value={roots}></textarea></label
  >
  <p class="task-form-context">
    One folder per line. An empty list includes all indexed notes.
  </p>
  {#if opened.snapshot}<label
      >Default project<select
        aria-label="Default task project"
        bind:value={defaultProjectId}
        ><option value="">Choose a project</option
        >{#each opened.snapshot.projects as project (project.id)}<option
            value={project.id}>{project.name}</option
          >{/each}</select
      ></label
    >
    <fieldset class="task-routing-projects">
      <legend>Project tags</legend>
      <p class="task-form-context">Comma-separated tags for each project.</p>
      {#each opened.snapshot.projects as project (project.id)}<label
          class="task-field"
          >{project.name}<input
            aria-label={`Tags for ${project.name}`}
            placeholder="work, haven"
            bind:value={projectTags[project.id]}
          /></label
        >{/each}
    </fieldset>
    <label
      >Label tags<textarea
        aria-label="Label tag mappings"
        placeholder="errands = errands"
        rows="3"
        bind:value={labels}></textarea></label
    >
    <p class="task-form-context">One tag = Todoist label per line.</p>
  {/if}
  {#if error}<p class="task-form-error" role="status">{error}</p>{/if}
  <div class="task-form-actions">
    <button class="task-primary" type="submit">Save settings</button><button
      class="task-text-button"
      onclick={cancel}
      type="button">Cancel</button
    >
  </div>
</form>
