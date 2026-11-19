<script lang="ts">
  import { CircleDot, ListTodo } from "lucide-svelte";
  import { untrack } from "svelte";

  import { githubRepository } from "../../tasks/github-config";
  import type { TaskSourceCollection } from "../../tasks/source-collection";

  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- Svelte validates annotated component props.
  const { sources }: { sources: TaskSourceCollection } = $props();
  const settings = untrack(() => sources.settings);
  const google = untrack(() => sources.googleBrowser);
  const github = untrack(() => sources.githubBrowser);
  const device = untrack(() => sources.githubBackend.auth.device);
  let error = $state("");
  let busy = $state(false);
  let repo = $state("");
  let projectUrl = $state("");
  let projectChoices = $state<
    Array<{ id: string; title: string; url: string }>
  >([]);
  let lists = $state<string[] | null>(null);
  let assigned = $state<boolean | null>(null);
  const selectedLists = $derived(
    lists ??
      $settings.taskSources.googleTasks.listIds ??
      $google.snapshot?.projects.slice(0, 1).map((project) => project.id) ??
      [],
  );
  async function run(action: () => Promise<unknown>) {
    if (busy) return;
    busy = true;
    error = "";
    try {
      await action();
    } catch (value) {
      error =
        value instanceof Error
          ? value.message
          : "Could not update this connection.";
    } finally {
      busy = false;
    }
  }
  function allowCompletion(enabled: boolean) {
    $settings = {
      ...$settings,
      taskSources: {
        ...$settings.taskSources,
        googleTasks: {
          ...$settings.taskSources.googleTasks,
          allowCompletion: enabled,
        },
      },
    };
    if (enabled && $google.connected) void sources.googleTasks.connect();
  }
  function toggleList(id: string, checked: boolean) {
    lists = checked
      ? [...new Set([...selectedLists, id])]
      : selectedLists.filter((value) => value !== id);
  }
  async function applyLists() {
    $settings = {
      ...$settings,
      taskSources: {
        ...$settings.taskSources,
        googleTasks: {
          ...$settings.taskSources.googleTasks,
          listIds: [...selectedLists],
          showAssigned:
            assigned ?? $settings.taskSources.googleTasks.showAssigned,
        },
      },
    };
    await sources.googleTasks.refresh(true);
  }
  async function addRepo() {
    const name = githubRepository(repo);
    if (!name) {
      error = "Enter owner/repository or its github.com URL.";
      return;
    }
    $settings = {
      ...$settings,
      taskSources: {
        ...$settings.taskSources,
        github: {
          ...$settings.taskSources.github,
          repositories: [
            ...new Set([...$settings.taskSources.github.repositories, name]),
          ],
        },
      },
    };
    repo = "";
    await sources.github.refresh(true);
  }
  async function addProject(project: {
    id: string;
    title: string;
    url: string;
  }) {
    const current = $settings.taskSources.github;
    if (!current.projects.some((item) => item.id === project.id))
      $settings = {
        ...$settings,
        taskSources: {
          ...$settings.taskSources,
          github: { ...current, projects: [...current.projects, project] },
        },
      };
    projectUrl = "";
    await sources.github.refresh(true);
  }
  async function mapField(
    id: string,
    field: "statusFieldId" | "dateFieldId",
    value: string,
  ) {
    const current = $settings.taskSources.github;
    $settings = {
      ...$settings,
      taskSources: {
        ...$settings.taskSources,
        github: {
          ...current,
          projects: current.projects.map((project) =>
            project.id === id
              ? { ...project, [field]: value || undefined }
              : project,
          ),
        },
      },
    };
    await sources.github.refresh(true);
  }
  async function remove(kind: "repository" | "project", id: string) {
    const current = $settings.taskSources.github;
    $settings = {
      ...$settings,
      taskSources: {
        ...$settings.taskSources,
        github: {
          ...current,
          repositories:
            kind === "repository"
              ? current.repositories.filter((repo) => repo !== id)
              : current.repositories,
          projects:
            kind === "project"
              ? current.projects.filter((project) => project.id !== id)
              : current.projects,
        },
      },
    };
    await sources.github.refresh(true);
  }
  function privateAccess(enabled: boolean) {
    $settings = {
      ...$settings,
      taskSources: {
        ...$settings.taskSources,
        github: { ...$settings.taskSources.github, includePrivate: enabled },
      },
    };
    if (enabled && $github.connected) void sources.github.connect();
    else if ($github.connected) void sources.github.refresh(true);
  }
</script>

<div class="source-connection-card" aria-label="Google Tasks connection">
  <div class="source-card-header">
    <ListTodo size={19} />
    <div>
      <h3>Google Tasks</h3>
      <p>
        {$google.connected
          ? `Connected${$google.snapshot?.account.name ? ` as ${$google.snapshot.account.name}` : ""}`
          : "Not connected"}
      </p>
    </div>
    {#if $google.loading}<button
        onclick={() => sources.googleTasks.cancel()}
        type="button">Cancel</button
      >{:else}<button
        onclick={() =>
          $google.connected
            ? sources.googleTasks.disconnect()
            : sources.googleTasks.connect()}
        type="button"
        >{$google.connected ? "Sign out" : "Sign in with Google"}</button
      >{/if}
  </div>
  {#if $google.error}<p class="source-error" role="alert">
      {$google.error}
    </p>{/if}
  <p>Browse lists and drag tasks into your notes or schedule.</p>
  <label class="source-toggle"
    ><input
      checked={$settings.taskSources.googleTasks.allowCompletion}
      disabled={$google.loading}
      onchange={(event) => allowCompletion(event.currentTarget.checked)}
      type="checkbox"
    />Allow completing tasks here</label
  >
  {#if $google.connected && $settings.taskSources.googleTasks.allowCompletion && !$google.snapshot?.account.capabilities?.complete}<button
      disabled={$google.loading}
      onclick={() => sources.googleTasks.connect()}
      type="button">Grant completion access</button
    >{/if}
  {#if $google.connected}<details>
      <summary>Task lists</summary>
      <div class="source-options">
        <label class="source-toggle"
          ><input
            checked={assigned ?? $settings.taskSources.googleTasks.showAssigned}
            disabled={$google.loading}
            onchange={(event) => {
              assigned = event.currentTarget.checked;
            }}
            type="checkbox"
          />Include tasks assigned to me</label
        >
        {#each $google.snapshot?.projects ?? [] as project}<label
            class="source-toggle"
            ><input
              aria-label={`Include ${project.name} list`}
              checked={selectedLists.includes(project.id)}
              disabled={$google.loading}
              onchange={(event) =>
                toggleList(project.id, event.currentTarget.checked)}
              type="checkbox"
            />{project.name}</label
          >{/each}
        <button
          disabled={$google.loading}
          onclick={() => applyLists()}
          type="button">Apply selection</button
        >
      </div>
    </details>{/if}
</div>

<div class="source-connection-card" aria-label="GitHub connection">
  <div class="source-card-header">
    <CircleDot size={19} />
    <div>
      <h3>GitHub</h3>
      <p>
        {$github.connected
          ? `Connected${$github.snapshot?.account.name ? ` as ${$github.snapshot.account.name}` : ""}`
          : "Not connected"}
      </p>
    </div>
    {#if $github.loading}<button
        onclick={() => sources.github.cancel()}
        type="button">Cancel</button
      >{:else}<button
        onclick={() =>
          $github.connected
            ? sources.github.disconnect()
            : sources.github.connect()}
        type="button"
        >{$github.connected ? "Sign out" : "Sign in with GitHub"}</button
      >{/if}
  </div>
  {#if $github.error}<p class="source-error" role="alert">
      {$github.error}
    </p>{/if}
  {#if $device}<div class="device-code" role="status">
      <p>Enter this code on GitHub</p>
      <strong>{$device.code}</strong>
      <div class="source-inline">
        <button
          onclick={() => navigator.clipboard.writeText($device!.code)}
          type="button">Copy code</button
        ><a href={$device.url} rel="noopener noreferrer" target="_blank"
          >Open GitHub</a
        >
      </div>
      <p>Waiting for approval…</p>
    </div>{/if}
  <p>
    Bring issues and Projects into your schedule. Changes here stay in your
    notes.
  </p>
  <label class="source-toggle"
    ><input
      checked={$settings.taskSources.github.includePrivate}
      disabled={$github.loading || busy}
      onchange={(event) => privateAccess(event.currentTarget.checked)}
      type="checkbox"
    />Include private repositories</label
  >
  <p class="source-hint">
    Private access requests GitHub’s broader repository permission, which
    includes writes. This integration reads GitHub work.
  </p>
  {#if $github.connected && $settings.taskSources.github.includePrivate && !sources.githubBackend.auth
      .grantedScopes()
      .includes("repo")}<button
      disabled={$github.loading}
      onclick={() => sources.github.connect()}
      type="button">Grant private access</button
    >{/if}
  {#if $github.connected}
    <details>
      <summary>Issues and repositories</summary>
      <div class="source-options">
        <label class="source-toggle"
          ><input
            checked={$settings.taskSources.github.assigned}
            disabled={$github.loading || busy}
            onchange={(event) => {
              $settings = {
                ...$settings,
                taskSources: {
                  ...$settings.taskSources,
                  github: {
                    ...$settings.taskSources.github,
                    assigned: event.currentTarget.checked,
                  },
                },
              };
              void sources.github.refresh(true);
            }}
            type="checkbox"
          />Assigned to me</label
        >
        {#each $settings.taskSources.github.repositories as name}<div
            class="source-inline"
          >
            <span>{name}</span><button
              disabled={$github.loading || busy}
              onclick={() => run(() => remove("repository", name))}
              type="button">Remove</button
            >
          </div>{/each}
        <div class="source-inline">
          <input
            aria-label="GitHub repository to add"
            disabled={$github.loading || busy}
            placeholder="owner/repository"
            bind:value={repo}
          /><button
            disabled={$github.loading || busy || !repo.trim()}
            onclick={() => run(addRepo)}
            type="button">Add</button
          >
        </div>
      </div>
    </details>
    <details>
      <summary>Projects</summary>
      <div class="source-options">
        <button
          disabled={$github.loading || busy}
          onclick={() =>
            run(async () => {
              projectChoices = (await sources.githubBackend.discoverProjects())
                .items;
            })}
          type="button">Find my Projects</button
        >
        {#each projectChoices.filter((project) => !$settings.taskSources.github.projects.some((saved) => saved.id === project.id)) as project}<div
            class="source-inline"
          >
            <span>{project.title}</span><button
              disabled={$github.loading || busy}
              onclick={() => run(() => addProject(project))}
              type="button">Add</button
            >
          </div>{/each}
        <div class="source-inline">
          <input
            aria-label="GitHub Project URL"
            disabled={$github.loading || busy}
            placeholder="User or organization Project URL"
            bind:value={projectUrl}
          /><button
            disabled={$github.loading || busy || !projectUrl.trim()}
            onclick={() =>
              run(async () =>
                addProject(
                  await sources.githubBackend.lookupProject(projectUrl),
                ),
              )}
            type="button">Add</button
          >
        </div>
        {#each $settings.taskSources.github.projects as project}
          {@const fields =
            $github.snapshot?.projects.find((item) => item.id === project.id)
              ?.source?.fields ?? []}
          <div class="project-options">
            <div class="source-inline">
              <strong>{project.title}</strong><button
                disabled={$github.loading || busy}
                onclick={() => run(() => remove("project", project.id))}
                type="button">Remove</button
              >
            </div>
            <label
              >Status field<select
                aria-label={`Status field for ${project.title}`}
                disabled={$github.loading || busy}
                onchange={(event) =>
                  run(() =>
                    mapField(
                      project.id,
                      "statusFieldId",
                      event.currentTarget.value,
                    ),
                  )}
                value={project.statusFieldId ?? ""}
                ><option value="">None</option
                >{#each fields.filter((field) => field.type === "single-select") as field}<option
                    value={field.id}>{field.name}</option
                  >{/each}</select
              ></label
            >
            <label
              >Target date field<select
                aria-label={`Target date field for ${project.title}`}
                disabled={$github.loading || busy}
                onchange={(event) =>
                  run(() =>
                    mapField(
                      project.id,
                      "dateFieldId",
                      event.currentTarget.value,
                    ),
                  )}
                value={project.dateFieldId ?? ""}
                ><option value="">None</option
                >{#each fields.filter((field) => field.type === "date") as field}<option
                    value={field.id}>{field.name}</option
                  >{/each}</select
              ></label
            >
          </div>
        {/each}
      </div>
    </details>
  {/if}
  <details>
    <summary>Advanced</summary>
    <div class="source-options">
      <label class="source-toggle"
        ><input
          checked={$settings.taskSources.github.useCustomClient}
          disabled={$github.loading}
          onchange={(event) => {
            $settings = {
              ...$settings,
              taskSources: {
                ...$settings.taskSources,
                github: {
                  ...$settings.taskSources.github,
                  useCustomClient: event.currentTarget.checked,
                },
              },
            };
          }}
          type="checkbox"
        />Use a custom GitHub app</label
      >{#if $settings.taskSources.github.useCustomClient}<label
          >Public client ID<input
            aria-label="Custom GitHub client ID"
            disabled={$github.loading}
            onchange={(event) => {
              $settings = {
                ...$settings,
                taskSources: {
                  ...$settings.taskSources,
                  github: {
                    ...$settings.taskSources.github,
                    clientId: event.currentTarget.value.trim(),
                  },
                },
              };
            }}
            value={$settings.taskSources.github.clientId}
          /></label
        >
        <p class="source-hint">
          Use an OAuth app with device flow enabled. No client secret is needed.
        </p>{/if}
    </div>
  </details>
  {#if error}<p class="source-error" role="alert">{error}</p>{/if}
</div>

<style>
  .source-connection-card {
    display: grid;
    gap: 10px;

    padding: 12px;

    border: 1px solid var(--tp-border);
    border-radius: var(--radius-m);
  }

  .source-card-header {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    gap: 10px;
    align-items: center;
  }

  h3,
  p {
    margin: 0;
  }

  h3 {
    font-size: 13px;
  }

  p {
    font-size: 12px;
    color: var(--text-muted);
  }

  .source-error {
    color: var(--text-error);
  }

  .source-hint {
    font-size: 11px;
  }

  .source-toggle {
    display: flex;
    gap: 8px;
    align-items: center;
  }

  .source-options {
    display: grid;
    gap: 10px;
    margin-top: 10px;
  }

  .source-inline {
    display: flex;
    gap: 8px;
    align-items: center;
  }

  .source-inline > input,
  .source-inline > span,
  .source-inline > strong {
    flex: 1;
    min-width: 0;
  }

  .project-options,
  .device-code {
    display: grid;
    gap: 8px;

    padding: 10px;

    border: 1px solid var(--tp-border);
    border-radius: var(--radius-s);
  }

  .project-options > label {
    display: grid;
    gap: 5px;
  }

  .device-code > strong {
    font-size: 22px;
    letter-spacing: 2px;
  }
</style>
