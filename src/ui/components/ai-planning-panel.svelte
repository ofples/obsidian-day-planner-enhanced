<script lang="ts">
  import { Check, Copy, LoaderCircle, Sparkles, Undo2, X } from "lucide-svelte";
  import { DateTime } from "luxon";
  import { untrack } from "svelte";

  import type { PlanningAction } from "../../ai-scheduling/types";
  import { withoutDisplayedControlTags } from "../../util/task-lock";
  import type { PlanningPanelService } from "../ai-planning-panel";

  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- Svelte validates the annotated component prop.
  let { planner }: { planner: PlanningPanelService } = $props();
  const view = $derived(planner.state);
  const visible = $derived(planner.visible);
  const defaults = untrack(() => planner.getDefaults());
  const proposalId = `ai-planning-proposal-${crypto.randomUUID()}`;
  let startDate = $state(defaults.startDate);
  let dayCount = $state(defaults.dayCount);
  let request = $state(defaults.request);
  let instructions = $state(defaults.preferences.instructions);
  let startHour = $state(defaults.preferences.startHour);
  let endHour = $state(defaults.preferences.endHour);
  let duration = $state(defaults.preferences.defaultDurationMinutes);
  let preset = $state("plan");
  let shiftFrom = $state("13:00");
  let shiftMinutes = $state(30);
  let proposalText = $state("");
  let localError = $state("");
  let feedback = $state("");
  let busyLabel = $state("");
  let panel = $state<HTMLElement>();
  const busy = $derived($view.busy || Boolean(busyLabel));
  const error = $derived(localError || $view.error);
  const draft = $derived($view.draft);
  const pending = $derived(
    draft?.proposal.actions.filter(
      (action) =>
        !draft.acceptedIds.includes(action.id) &&
        !draft.rejectedIds.includes(action.id),
    ) ?? [],
  );
  const selected = $derived(
    pending.filter((action) => draft?.selectedIds.includes(action.id)),
  );
  const selectedIssues = $derived(
    $view.issues.filter(
      (issue) =>
        !issue.actionId ||
        selected.some((action) => action.id === issue.actionId),
    ),
  );
  const needsRefresh = $derived(
    $view.issues.some((issue) =>
      ["stale", "context", "source"].includes(issue.code),
    ),
  );
  const needsRecovery = $derived(
    $view.lastBatch &&
      ["prepared", "undoing", "cleanup"].includes($view.lastBatch.phase),
  );

  $effect(() => {
    if ($visible) {
      const current = planner.getDefaults();
      startDate = current.startDate;
      dayCount = current.dayCount;
      request = current.request;
      instructions = current.preferences.instructions;
      startHour = current.preferences.startHour;
      endHour = current.preferences.endHour;
      duration = current.preferences.defaultDurationMinutes;
    }
  });

  async function perform(label: string, action: () => unknown) {
    if (busy) return;
    localError = "";
    feedback = "";
    busyLabel = label;
    try {
      await action();
    } catch (cause) {
      localError =
        cause instanceof Error
          ? cause.message
          : "Could not complete this action. Try again.";
    } finally {
      busyLabel = "";
    }
  }

  function preferences() {
    if (
      !Number.isInteger(startHour) ||
      !Number.isInteger(endHour) ||
      endHour <= startHour
    )
      throw new Error("Choose a planning end time later than its start time.");
    if (!Number.isInteger(duration) || duration < 1 || duration > 1440)
      throw new Error("Choose a task duration between 1 and 1,440 minutes.");
    return {
      startHour,
      endHour,
      defaultDurationMinutes: duration,
      instructions,
    };
  }

  async function copyContext() {
    const planningRequest =
      preset === "shift"
        ? `${request}\nShift flexible work from ${shiftFrom} by about ${shiftMinutes} minutes, placing it around fixed commitments. Explain work that does not fit.`
        : request;
    const context = await planner.getContext({
      startDate,
      dayCount,
      request: planningRequest,
      preferences: preferences(),
    });
    const clipboard = panel?.ownerDocument.defaultView?.navigator.clipboard;
    if (!clipboard)
      throw new Error("Clipboard access is unavailable in this window.");
    await clipboard.writeText(JSON.stringify(context, null, 2));
    feedback =
      "Planning context copied. Give it to your assistant and import its suggestions here.";
  }

  function changePreset() {
    request =
      preset === "frames"
        ? "Fill my available frames with suitable tasks. Keep fixed commitments in place."
        : preset === "shift"
          ? "Rearrange the remaining flexible work around fixed commitments."
          : "Arrange my available tasks into a practical plan.";
  }

  function source(action: PlanningAction) {
    return (
      draft?.context.tasks.find((task) => task.ref === action.sourceRef) ??
      draft?.context.blocks.find((block) => block.ref === action.sourceRef)
    );
  }

  function interval(start: string, end: string) {
    const zone = draft?.context.timezone ?? $view.context?.timezone;
    const from = DateTime.fromISO(start).setZone(zone);
    const to = DateTime.fromISO(end).setZone(zone);
    return `${from.toFormat("ccc d LLL · HH:mm")}–${to.toFormat("HH:mm")}`;
  }

  function destination(action: PlanningAction) {
    if (action.kind !== "add-to-frame")
      return interval(action.start, action.end);
    const frame = draft?.context.blocks.find(
      (block) => block.ref === action.frameRef,
    );
    return frame
      ? `In ${withoutDisplayedControlTags(frame.title)} · ${interval(frame.start, frame.end)}`
      : "Frame unavailable";
  }

  async function importSuggestions() {
    let input: unknown;
    try {
      input = JSON.parse(proposalText);
    } catch {
      throw new Error("Paste a complete JSON proposal from your assistant.");
    }
    await planner.submitProposal(input);
    proposalText = "";
    feedback = "Suggestions loaded for review.";
  }
</script>

{#if $visible}
  <section
    bind:this={panel}
    class="ai-planning-panel"
    aria-busy={busy}
    aria-label="AI planning"
  >
    <header class="planning-heading">
      <h2><Sparkles size={17} /> Plan with AI</h2>
      <button
        class="icon-button"
        aria-label="Close AI planning"
        disabled={busy}
        onclick={() => planner.hide()}
        type="button"><X size={16} /></button
      >
    </header>

    {#if error}
      <div class="planning-message is-warning" role="alert">{error}</div>
    {/if}
    {#if $view.recoveryRequired && planner.resetSavedState}
      <button
        disabled={busy}
        onclick={() =>
          perform("Resetting planning data…", () =>
            planner.resetSavedState?.(),
          )}
        type="button">Reset saved planning data</button
      >
    {/if}
    {#if feedback}<p class="planning-message" role="status">{feedback}</p>{/if}
    {#if busy}<p class="planning-progress" role="status">
        <LoaderCircle class="is-spinning" size={14} />{busyLabel ||
          "Saving changes…"}
      </p>{/if}

    {#if draft}
      <section class="planning-review" aria-label="Review suggestions">
        <div class="review-heading">
          <h3>
            {pending.length}
            {pending.length === 1 ? "suggestion" : "suggestions"}
          </h3>
          <span>{selected.length} selected</span>
        </div>
        {#if draft.proposal.summary}<p class="planning-summary">
            {draft.proposal.summary}
          </p>{/if}
        {#if needsRefresh}
          <div class="planning-message is-warning">
            <strong>Schedule changed</strong>
            <p>
              Refresh the planning context and ask your assistant to revise
              these suggestions.
            </p>
            <button
              disabled={busy}
              onclick={() => perform("Refreshing context…", copyContext)}
              type="button">Refresh context</button
            >
          </div>
        {/if}
        {#each $view.issues.filter((issue) => !issue.actionId) as issue}<p
            class="action-issue"
            role="alert"
          >
            {issue.message}
          </p>{/each}
        {#each pending as action (action.id)}
          {@const task = source(action)}
          <article
            class="planning-action"
            class:has-issue={$view.issues.some(
              (issue) => issue.actionId === action.id,
            )}
          >
            <div class="action-heading">
              <input
                aria-label={`Include ${task?.title ?? "unavailable task"}`}
                checked={draft.selectedIds.includes(action.id)}
                disabled={busy}
                onchange={(event) =>
                  perform("Saving selection…", () =>
                    planner.selectAction(
                      action.id,
                      event.currentTarget.checked,
                    ),
                  )}
                type="checkbox"
              />
              <details>
                <summary
                  ><span class="action-title"
                    >{task?.title ?? "Unavailable task"}</span
                  ><span class="action-kind"
                    >{action.kind === "move"
                      ? "Move"
                      : action.kind === "add-to-frame"
                        ? "Add to frame"
                        : "Schedule"}</span
                  ><span class="action-destination">{destination(action)}</span
                  ></summary
                >
                <div class="action-detail">
                  {#if action.kind === "move" && task && "start" in task}<p>
                      <strong>From</strong>
                      {interval(task.start, task.end)}
                    </p>{/if}
                  {#if task?.path}<p class="action-source">{task.path}</p>{/if}
                  {#if action.reason}<p>{action.reason}</p>{/if}
                </div>
              </details>
              <button
                class="icon-button"
                aria-label={`Dismiss ${task?.title ?? "suggestion"}`}
                disabled={busy}
                onclick={() =>
                  perform("Dismissing suggestion…", () =>
                    planner.dismissAction(action.id),
                  )}
                type="button"><X size={14} /></button
              >
            </div>
            {#each $view.issues.filter((issue) => issue.actionId === action.id) as issue}<p
                class="action-issue"
              >
                {issue.message}
              </p>{/each}
          </article>
        {/each}
        {#if !draft.proposal.actions.length}<p class="planning-summary">
            Your assistant returned no schedule changes. You can adjust the
            request below.
          </p>{/if}
        {#if draft.acceptedIds.length || draft.rejectedIds.length}<p
            class="review-resolved"
          >
            {draft.acceptedIds.length} applied · {draft.rejectedIds.length} dismissed
          </p>{/if}
        {#if draft.proposal.unplaced.length}<details class="planning-unplaced">
            <summary>Unscheduled ({draft.proposal.unplaced.length})</summary
            >{#each draft.proposal.unplaced as item}<p>
                <strong
                  >{draft.context.tasks.find(
                    (task) => task.ref === item.sourceRef,
                  )?.title ?? "Task"}</strong
                ><br />{item.reason}
              </p>{/each}
          </details>{/if}
        <div class="planning-actions review-buttons">
          <button
            class="primary-button"
            disabled={busy ||
              !selected.length ||
              selectedIssues.length > 0 ||
              Boolean(needsRecovery)}
            onclick={() =>
              perform("Applying suggestions…", () => planner.applySelected())}
            type="button">Apply selected</button
          >
          <button
            disabled={busy || Boolean(needsRecovery)}
            onclick={() =>
              perform("Dismissing draft…", () => planner.dismissDraft())}
            type="button">Dismiss</button
          >
        </div>
      </section>
    {/if}

    {#if $view.lastBatch?.phase === "applied"}
      <div class="planning-result" role="status">
        <span
          ><Check size={15} />
          {$view.lastBatch.batch.actionIds.length} changes applied</span
        ><button
          disabled={busy}
          onclick={() => perform("Undoing changes…", () => planner.undo())}
          type="button"><Undo2 size={14} /> Undo</button
        >
      </div>
    {:else if needsRecovery}
      <div class="planning-message is-warning">
        <strong
          >{$view.lastBatch?.phase === "cleanup"
            ? "Undo is waiting for calendar cleanup"
            : "A saved operation needs to finish"}</strong
        >
        <p>Retry the saved operation to continue.</p>
        <button
          disabled={busy}
          onclick={() =>
            perform("Retrying saved operation…", () => planner.retry())}
          type="button">Retry</button
        >
      </div>
    {:else if $view.lastBatch?.phase === "undone"}<p
        class="planning-message"
        role="status"
      >
        Last AI batch undone.
      </p>{/if}

    {#if $view.taskView}
      <div class="planning-task-view">
        <span>AI task view · {$view.taskView.buckets.length} buckets</span
        ><button disabled={busy} onclick={() => planner.hide()} type="button"
          >Browse buckets</button
        ><button
          disabled={busy}
          onclick={() =>
            perform("Clearing task view…", () => planner.clearTaskView())}
          type="button">Clear view</button
        >
      </div>
    {/if}

    <details class="planning-request" open={!draft}>
      <summary>{draft ? "Prepare another request" : "Planning request"}</summary
      >
      <fieldset disabled={busy || !$view.ready}>
        <div class="planning-fields">
          <label
            >From<input
              aria-label="Planning start date"
              type="date"
              bind:value={startDate}
            /></label
          >
          <label
            >Days<select aria-label="Planning days" bind:value={dayCount}
              >{#each [1, 2, 3, 4, 5, 6, 7] as count}<option value={count}
                  >{count} {count === 1 ? "day" : "days"}</option
                >{/each}</select
            ></label
          >
        </div>
        <label
          >Request<select
            aria-label="Planning request preset"
            onchange={changePreset}
            bind:value={preset}
            ><option value="plan">Plan my tasks</option><option value="frames"
              >Fill my frames</option
            ><option value="shift">Shift remaining work</option></select
          ></label
        >
        {#if preset === "shift"}<div class="planning-fields">
            <label
              >Starting at<input
                aria-label="Shift from time"
                type="time"
                bind:value={shiftFrom}
              /></label
            ><label
              >Shift by, minutes<input
                aria-label="Shift by minutes"
                max="720"
                min="1"
                type="number"
                bind:value={shiftMinutes}
              /></label
            >
          </div>{/if}
        <textarea
          aria-label="Scheduling request"
          placeholder="What should your assistant arrange?"
          rows="3"
          bind:value={request}></textarea>
        <details class="planning-rules">
          <summary>Rules and planning hours</summary>
          <label
            >Saved instructions<textarea rows="3" bind:value={instructions}
            ></textarea></label
          >
          <div class="planning-fields">
            <label
              >Day starts<select
                aria-label="Planning day starts"
                bind:value={startHour}
                >{#each Array.from({ length: 24 }, (_, index) => index) as hour}<option
                    value={hour}>{String(hour).padStart(2, "0")}:00</option
                  >{/each}</select
              ></label
            ><label
              >Day ends<select
                aria-label="Planning day ends"
                bind:value={endHour}
                >{#each Array.from({ length: 24 }, (_, index) => index + 1) as hour}<option
                    value={hour}>{String(hour).padStart(2, "0")}:00</option
                  >{/each}</select
              ></label
            >
          </div>
          <label
            >Default task duration, minutes<input
              max="1440"
              min="1"
              type="number"
              bind:value={duration}
            /></label
          >
          <p class="planning-hint">
            Locks, occupied timed commitments and explicit frame-label
            mismatches are checked before applying.
          </p>
          <button
            onclick={() =>
              perform("Saving rules…", async () => {
                await planner.savePreferences(preferences());
                feedback = "Planning rules saved.";
              })}
            type="button">Save rules</button
          >
        </details>
        <div class="planning-actions">
          <button
            class="primary-button"
            onclick={() => perform("Preparing context…", copyContext)}
            type="button"><Copy size={14} /> Copy planning context</button
          >
        </div>
      </fieldset>
      <p class="planning-hint">
        Use your existing assistant. Local tools are available while desktop
        Obsidian is open.
      </p>
      {#if $view.context?.freshness.tasksUpdatedAt}<p class="planning-hint">
          Task cache · {DateTime.fromISO(
            $view.context.freshness.tasksUpdatedAt,
          ).toFormat("d LLL HH:mm")}
        </p>{/if}
      {#if $view.context?.freshness.truncated}<p class="planning-hint">
          The context contains the first 500 available tasks. Narrow the task
          sources for a smaller shortlist.
        </p>{/if}
    </details>

    <details class="planning-import">
      <summary>Import suggestions</summary><label for={proposalId}
        >Proposal JSON</label
      ><textarea
        id={proposalId}
        disabled={busy}
        placeholder="Paste your assistant’s proposal"
        rows="5"
        spellcheck="false"
        bind:value={proposalText}></textarea><button
        disabled={busy || !proposalText.trim()}
        onclick={() => perform("Loading suggestions…", importSuggestions)}
        type="button">Load suggestions</button
      >
    </details>
  </section>
{/if}

<style>
  .ai-planning-panel {
    container-type: inline-size;
    overflow: auto;
    flex-shrink: 0;

    width: 100%;
    min-width: 0;
    max-height: 80vh;
    padding: 14px 16px;

    font:
      13px/1.45 Inter,
      var(--font-interface, system-ui),
      sans-serif;
    color: var(--tp-text, var(--text-normal));

    background: var(--tp-bg, var(--background-primary));
    border-bottom: 1px solid var(--tp-border, var(--background-modifier-border));
  }

  .ai-planning-panel,
  .ai-planning-panel * {
    box-sizing: border-box;
  }

  h2,
  h3,
  p {
    margin: 0;
  }

  h2 {
    display: flex;
    gap: 7px;
    align-items: center;
    font-size: 15px;
  }

  h3 {
    font-size: 13px;
  }

  button,
  input,
  textarea,
  select {
    font: inherit;
  }

  button {
    cursor: pointer;

    display: inline-flex;
    gap: 6px;
    align-items: center;
    justify-content: center;

    min-width: 0;
    height: auto;
    padding: 7px 10px;

    color: inherit;
    white-space: normal;

    background: var(--tp-surface, var(--background-secondary));
    border: 1px solid var(--tp-border, var(--background-modifier-border));
    border-radius: 6px;
    box-shadow: none;
  }

  button:hover {
    background: var(--tp-hover, var(--background-modifier-hover));
  }

  button:disabled {
    cursor: default;
    opacity: 0.5;
  }

  .primary-button {
    color: var(--text-on-accent);
    background: var(--interactive-accent);
    border-color: var(--interactive-accent);
  }

  .primary-button:hover {
    background: var(--interactive-accent-hover);
  }

  .icon-button {
    padding: 5px;
    background: transparent;
    border-color: transparent;
  }

  .planning-heading,
  .review-heading,
  .planning-result,
  .planning-task-view {
    display: flex;
    gap: 8px;
    align-items: center;
    justify-content: space-between;

    min-width: 0;
  }

  .planning-heading {
    margin-bottom: 12px;
  }

  .review-heading > span,
  .planning-hint,
  .review-resolved,
  .action-source,
  .action-kind {
    font-size: 11px;
    color: var(--tp-muted, var(--text-muted));
  }

  .planning-summary {
    margin-block: 8px;
    color: var(--tp-muted, var(--text-muted));
  }

  .planning-message,
  .planning-result,
  .planning-task-view {
    margin-block: 10px;
    padding: 10px;

    background: var(--tp-surface, var(--background-secondary));
    border: 1px solid var(--tp-border, var(--background-modifier-border));
    border-radius: 7px;
  }

  .planning-message {
    overflow-wrap: anywhere;
  }

  .planning-message p {
    margin-block: 5px 8px;
  }

  .is-warning {
    border-color: var(--tp-warning, var(--text-warning));
  }

  .planning-progress,
  .planning-result > span {
    display: flex;
    gap: 6px;
    align-items: center;
  }

  .planning-progress {
    margin-bottom: 8px;
    color: var(--tp-muted, var(--text-muted));
  }

  .planning-action {
    margin-block: 7px;
    padding: 10px;

    background: var(--tp-surface, var(--background-secondary));
    border: 1px solid var(--tp-border, var(--background-modifier-border));
    border-radius: 7px;
  }

  .planning-action.has-issue {
    border-color: var(--tp-warning, var(--text-warning));
  }

  .action-heading {
    display: grid;
    grid-template-columns: 18px minmax(0, 1fr) 24px;
    gap: 7px;
    align-items: start;
  }

  .action-heading > input {
    width: 15px;
    height: 15px;
    margin: 3px 0 0;
    border-radius: 3px;
  }

  .action-heading details {
    min-width: 0;
  }

  summary {
    cursor: pointer;
  }

  .action-heading summary {
    display: grid;
    gap: 2px;
  }

  .action-title {
    font-weight: 550;
    overflow-wrap: anywhere;
  }

  .action-destination {
    font-size: 11px;
    color: var(--tp-accent, var(--text-accent));
  }

  .action-detail {
    display: grid;
    gap: 6px;
    margin-top: 9px;
    overflow-wrap: anywhere;
  }

  .action-issue {
    margin-top: 8px;
    font-size: 12px;
    color: var(--tp-warning, var(--text-warning));
  }

  .planning-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 7px;
    margin-top: 10px;
  }

  .review-buttons {
    margin-bottom: 14px;
  }

  .review-resolved {
    margin-block: 8px;
  }

  .planning-unplaced p {
    margin-top: 8px;
  }

  .planning-request,
  .planning-import {
    margin-top: 13px;
  }

  .planning-request > summary,
  .planning-import > summary {
    padding-block: 5px;
    font-weight: 550;
  }

  fieldset {
    display: grid;
    gap: 10px;

    min-width: 0;
    margin: 0;
    padding: 9px 0 0;

    border: 0;
  }

  label {
    display: grid;
    gap: 5px;

    min-width: 0;

    font-size: 12px;
    color: var(--tp-muted, var(--text-muted));
  }

  input:not([type="checkbox"]),
  select,
  textarea {
    width: 100%;
    min-width: 0;
    padding: 7px 8px;

    color: var(--tp-text, var(--text-normal));

    background: var(--tp-surface, var(--background-secondary));
    border: 1px solid var(--tp-border, var(--background-modifier-border));
    border-radius: 6px;
  }

  textarea {
    resize: vertical;
    min-height: 70px;
  }

  .planning-fields {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    gap: 9px;
  }

  .planning-rules[open] {
    display: grid;
    gap: 10px;
  }

  .planning-rules > summary {
    margin-bottom: 3px;
  }

  .planning-hint {
    margin-top: 8px;
  }

  .planning-import label {
    margin-top: 8px;
  }

  .planning-import button {
    margin-top: 7px;
  }

  :focus-visible {
    outline: 2px solid var(--tp-accent, var(--interactive-accent));
    outline-offset: 2px;
  }

  @container (width < 260px) {
    .planning-fields {
      grid-template-columns: minmax(0, 1fr);
    }

    .planning-result,
    .planning-task-view {
      flex-wrap: wrap;
    }
  }
</style>
