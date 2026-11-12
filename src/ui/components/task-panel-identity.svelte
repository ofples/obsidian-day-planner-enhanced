<script lang="ts">
  import { onMount, untrack } from "svelte";

  import type {
    TaskIdentityRepairController,
    TaskIdentityReview,
  } from "../../tasks/identity-repair";
  import type { TaskIdentityDecisionView } from "../../tasks/identity-types";
  import { identitySourceKey } from "../../tasks/source";

  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- Svelte validates annotated component props.
  let {
    controller,
    linkUid,
    decision,
    writable = true,
    saved,
    cancel,
    openNote,
    setBusy,
    reviewLinks,
  }: {
    controller: TaskIdentityRepairController;
    linkUid?: string;
    decision?: TaskIdentityDecisionView;
    writable?: boolean;
    saved: (id: string) => void;
    cancel: () => void;
    openNote?: (path: string) => void;
    setBusy?: (value: boolean) => void;
    reviewLinks?: (uid: string) => void;
  } = $props();
  const opened = untrack(() => ({ controller, linkUid, saved }));
  let review: TaskIdentityReview | null = $state(null),
    loading = $state(false),
    busy = $state(false),
    error = $state("");
  let mode: "keep" | "move" | "create" = $state("keep"),
    linked: Record<string, string> = $state({}),
    create: string[] = $state([]);
  let closed = false;
  const canCancel = $derived(Boolean(decision?.cancellable));
  async function load() {
    if (!opened.linkUid) return;
    loading = true;
    error = "";
    try {
      const value = await opened.controller.review(opened.linkUid);
      if (!closed) review = value;
    } catch (failure) {
      if (!closed)
        error =
          failure instanceof Error
            ? failure.message
            : "Could not load the current note identities.";
    } finally {
      if (!closed) loading = false;
    }
  }
  onMount(() => {
    void load();
    return () => {
      closed = true;
    };
  });
  function choose(uid: string, key: string) {
    if (!review) return;
    const changes = key
      ? opened.controller.suggestTree(review, uid, key)
      : { [uid]: "" };
    linked = { ...linked, ...changes };
    create = create.filter((key) => !Object.values(linked).includes(key));
  }
  function selectMode(value: typeof mode) {
    mode = value;
    if (!review) return;
    if (value !== "move") {
      linked = Object.fromEntries(
        Object.entries(review.before.links).map(([uid, link]) => [
          uid,
          review!.candidates.find(
            (source) =>
              identitySourceKey(source) === identitySourceKey(link.source),
          )
            ? identitySourceKey(link.source)
            : "",
        ]),
      );
    }
    if (value !== "create") create = [];
  }
  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (!review || busy || !writable) return;
    busy = true;
    setBusy?.(true);
    error = "";
    try {
      const result = await opened.controller.confirm(review, {
        linked,
        create: mode === "create" ? create : [],
      });
      if (closed) return;
      if (result.kind === "changed") {
        review = result.review;
        linked = {};
        create = [];
        error =
          "The sources changed. Review the current blocks and confirm again.";
      } else opened.saved(result.id);
    } catch (failure) {
      if (!closed)
        error =
          failure instanceof Error
            ? failure.message
            : "Could not save this source decision.";
    } finally {
      if (!closed) busy = false;
      setBusy?.(false);
    }
  }
  async function recover(kind: "retry" | "cancel") {
    if (!decision || busy || !writable) return;
    busy = true;
    setBusy?.(true);
    error = "";
    try {
      if (kind === "retry") await controller.retry(decision.id);
      else await controller.cancel(decision.id);
    } catch (failure) {
      if (!closed)
        error =
          failure instanceof Error
            ? failure.message
            : "Could not recover this source decision.";
    } finally {
      if (!closed) busy = false;
      setBusy?.(false);
    }
  }
</script>

{#if decision}<section
    class="task-panel-form"
    aria-label="Saved task link decision"
  >
    <h3>
      {decision.phase === "complete"
        ? "Task links saved"
        : decision.phase === "cancelled"
          ? "Source decision cancelled"
          : "Finishing task links"}
    </h3>
    {#each decision.assignments as assignment (assignment.uid)}<div
        class="task-form-context"
      >
        <strong>{assignment.source.title}</strong>
        <p>
          {assignment.kind === "linked"
            ? "Existing task"
            : assignment.kind === "create"
              ? "Separate task"
              : "Local checklist"} · {assignment.source.path}
        </p>
        <button
          class="task-text-button"
          disabled={!openNote}
          onclick={() => openNote?.(assignment.source.path)}>Open note</button
        >
      </div>{/each}
    {#if decision.error || error}<p class="task-form-error" role="status">
        {error || decision.error}
      </p>{/if}
    {#if decision.phase === "complete" && reviewLinks}<button
        class="task-text-button"
        disabled={busy || !writable}
        onclick={() => reviewLinks(Object.keys(decision!.before.links)[0]!)}
        >Review source choices</button
      >{/if}
    {#if decision.phase === "creating"}<div class="task-form-actions">
        <button
          class="task-primary"
          disabled={busy || !writable}
          onclick={() => void recover("retry")}>Retry source recovery</button
        >
        {#if canCancel}<button
            class="task-text-button"
            disabled={busy || !writable}
            onclick={() => void recover("cancel")}
            >Cancel queued decision</button
          >{/if}
      </div>{/if}
  </section>
{:else}<form
    class="task-panel-form"
    aria-label="Repair task note links"
    onsubmit={submit}
  >
    <h3>Choose task note links</h3>
    {#if loading}<p class="task-form-context" role="status">
        Reading current note blocks…
      </p>
    {:else if review}
      <div class="task-form-actions" aria-label="Source decision action">
        <button
          class="task-text-button"
          aria-pressed={mode === "keep"}
          disabled={busy}
          onclick={() => selectMode("keep")}
          type="button">Keep one linked</button
        >
        <button
          class="task-text-button"
          aria-pressed={mode === "move"}
          disabled={busy}
          onclick={() => selectMode("move")}
          type="button">Move link</button
        >
        <button
          class="task-text-button"
          aria-pressed={mode === "create"}
          disabled={busy}
          onclick={() => selectMode("create")}
          type="button">Create separate task</button
        >
      </div>
      <p class="task-form-context">
        Choose a source for each existing task. Other copies are saved as local
        checklists. Task identities are stored in plugin state.
      </p>
      {#each Object.entries(review.before.links) as [uid, link] (uid)}<label
          >{link.base?.title ?? link.source.title}
          <select
            aria-label={`Note source for ${link.base?.title ?? link.source.title}`}
            disabled={busy}
            onchange={(event) => choose(uid, event.currentTarget.value)}
            required
            value={linked[uid] ?? ""}
          >
            <option value="">Choose a note block</option>
            {#each review.candidates as source (identitySourceKey(source))}<option
                value={identitySourceKey(source)}
                >{source.path} · line {source.line + 1} · {source.title}</option
              >{/each}
          </select></label
        >{/each}
      {#if mode === "create"}<fieldset>
          <legend>Create separate tasks from these copies</legend>
          {#each review.sources as source (identitySourceKey(source))}<label
              ><input
                disabled={busy ||
                  Object.values(linked).includes(identitySourceKey(source))}
                type="checkbox"
                value={identitySourceKey(source)}
                bind:group={create}
              />{source.path} · line {source.line + 1} · {source.title}</label
            >{/each}
          <p class="task-form-context">
            Selected copies include their nested checklist items.
          </p>
        </fieldset>{/if}
      {#if review.cached}<p class="task-form-context">
          Using cached task details. Provider commands are verified when the
          connection resumes.
        </p>{/if}
    {/if}
    {#if error}<p class="task-form-error" role="status">{error}</p>{/if}
    <div class="task-form-actions">
      {#if review}<button
          class="task-primary"
          disabled={busy || !writable || (mode === "create" && !create.length)}
          type="submit"
          >{busy ? "Saving source choices…" : "Save source choices"}</button
        >
      {:else if !loading}<button
          class="task-text-button"
          onclick={load}
          type="button">Retry loading sources</button
        >{/if}
      <button
        class="task-text-button"
        disabled={busy}
        onclick={cancel}
        type="button">Cancel</button
      >
    </div>
  </form>{/if}
