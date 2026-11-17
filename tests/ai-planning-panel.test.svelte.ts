import { flushSync, mount, unmount } from "svelte";
import { get, writable } from "svelte/store";
import { afterEach, expect, test, vi } from "vitest";

import {
  planningContextSchema,
  planningProposalSchema,
} from "../src/ai-scheduling/types";
import type {
  PlanningPanelService,
  PlanningPanelState,
} from "../src/ui/ai-planning-panel";
import AiPlanningPanel from "../src/ui/components/ai-planning-panel.svelte";

const components: ReturnType<typeof mount>[] = [];
const originalClipboard = Object.getOwnPropertyDescriptor(
  window.navigator,
  "clipboard",
);

afterEach(async () => {
  for (const component of components.splice(0)) await unmount(component);
  document.body.replaceChildren();
  if (originalClipboard)
    Object.defineProperty(window.navigator, "clipboard", originalClipboard);
  else Reflect.deleteProperty(window.navigator, "clipboard");
});

function context() {
  return planningContextSchema.parse({
    version: 1,
    id: "context",
    createdAt: "2031-01-01T07:00:00Z",
    timezone: "UTC",
    startDate: "2031-01-01",
    dayCount: 1,
    request: "Prepare a plan",
    preferences: {},
    documents: {},
    commitments: [],
    tasks: [
      {
        ref: "task",
        kind: "todoist",
        title: "Prepare outline",
        raw: "- [ ] Prepare outline",
      },
    ],
    blocks: [
      {
        ref: "block",
        uid: "a".repeat(32),
        path: "Daily/2031-01-01.md",
        from: 0,
        raw: "- [ ] 14:00 - 14:30 Review draft",
        title: "Review draft",
        start: "2031-01-01T14:00:00Z",
        end: "2031-01-01T14:30:00Z",
      },
    ],
  });
}

function render(review = false) {
  const planningContext = context();
  const state = writable<PlanningPanelState>({
    ready: true,
    busy: false,
    error: "",
    context: planningContext,
    taskView: null,
    lastBatch: null,
    issues: [],
    draft: review
      ? {
          context: planningContext,
          proposal: planningProposalSchema.parse({
            version: 1,
            contextId: planningContext.id,
            summary: "Keep the morning open.",
            actions: [
              {
                id: "schedule",
                kind: "schedule",
                sourceRef: "task",
                start: "2031-01-01T10:00:00Z",
                end: "2031-01-01T10:30:00Z",
                reason: "Fits the free work slot.",
              },
              {
                id: "move",
                kind: "move",
                sourceRef: "block",
                start: "2031-01-01T15:00:00Z",
                end: "2031-01-01T15:30:00Z",
                reason: "Leaves the previous hour free.",
              },
            ],
          }),
          selectedIds: ["schedule", "move"],
          acceptedIds: [],
          rejectedIds: [],
        }
      : null,
  });
  const clipboard = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(window.navigator, "clipboard", {
    configurable: true,
    value: { writeText: clipboard },
  });
  const planner = {
    state,
    visible: writable(true),
    getDefaults: () => ({
      startDate: "2031-01-01",
      dayCount: 1,
      request: "Plan my day",
      preferences: planningContext.preferences,
    }),
    getContext: vi.fn().mockResolvedValue({
      context: { id: "new-context" },
      proposalSchema: { type: "object" },
    }),
    submitProposal: vi.fn().mockResolvedValue({ pending: 2 }),
    selectAction: vi.fn((id: string, selected: boolean) =>
      state.update((value) => ({
        ...value,
        draft: value.draft
          ? {
              ...value.draft,
              selectedIds: selected
                ? [...value.draft.selectedIds, id]
                : value.draft.selectedIds.filter((item) => item !== id),
            }
          : null,
      })),
    ),
    dismissAction: vi.fn().mockResolvedValue(undefined),
    dismissDraft: vi.fn().mockResolvedValue(undefined),
    applySelected: vi.fn().mockResolvedValue(undefined),
    undo: vi.fn().mockResolvedValue(undefined),
    retry: vi.fn().mockResolvedValue(undefined),
    resetSavedState: vi.fn().mockResolvedValue(undefined),
    clearTaskView: vi.fn().mockResolvedValue(undefined),
    savePreferences: vi.fn().mockResolvedValue(undefined),
    show: vi.fn(),
    hide: vi.fn(),
  } satisfies PlanningPanelService;
  const target = document.createElement("div");
  document.body.append(target);
  components.push(mount(AiPlanningPanel, { target, props: { planner } }));
  flushSync();
  const button = (label: string) =>
    Array.from(target.querySelectorAll<HTMLButtonElement>("button")).find(
      (element) => element.textContent?.trim() === label,
    )!;
  return { target, state, planner, clipboard, button };
}

test("planning request copies context, supports shift guidance and saves reusable rules", async () => {
  const t = render();
  const preset = t.target.querySelector<HTMLSelectElement>(
    '[aria-label="Planning request preset"]',
  )!;
  preset.value = "shift";
  preset.dispatchEvent(new Event("change", { bubbles: true }));
  flushSync();
  expect(
    t.target.querySelector('[aria-label="Shift from time"]'),
  ).not.toBeNull();
  t.button("Copy planning context").click();
  await vi.waitFor(() => expect(t.clipboard).toHaveBeenCalledOnce());
  expect(t.planner.getContext).toHaveBeenCalledWith(
    expect.objectContaining({
      startDate: "2031-01-01",
      dayCount: 1,
      request: expect.stringContaining("from 13:00 by about 30 minutes"),
    }),
  );
  expect(t.clipboard.mock.calls[0]?.[0]).toContain("proposalSchema");
  await vi.waitFor(() => expect(t.button("Save rules").disabled).toBe(false));
  t.button("Save rules").click();
  await vi.waitFor(() =>
    expect(t.planner.savePreferences).toHaveBeenCalledWith(
      get(t.state).context!.preferences,
    ),
  );
  expect(t.target.textContent).toContain("Planning rules saved.");
});

test("JSON import reports malformed input and submits a valid document for review", async () => {
  const t = render();
  const input = t.target.querySelector<HTMLTextAreaElement>(
    '[placeholder="Paste your assistant’s proposal"]',
  )!;
  input.value = "broken";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  flushSync();
  t.button("Load suggestions").click();
  await vi.waitFor(() =>
    expect(t.target.textContent).toContain("Paste a complete JSON proposal"),
  );
  expect(t.planner.submitProposal).not.toHaveBeenCalled();
  input.value = '{"version":1,"contextId":"context","actions":[]}';
  input.dispatchEvent(new Event("input", { bubbles: true }));
  flushSync();
  t.button("Load suggestions").click();
  await vi.waitFor(() =>
    expect(t.planner.submitProposal).toHaveBeenCalledWith({
      version: 1,
      contextId: "context",
      actions: [],
    }),
  );
  expect(input.value).toBe("");
});

test("review shows move comparisons and changes only selected suggestions", async () => {
  const t = render(true);
  expect(t.target.textContent).toContain("2 selected");
  expect(t.target.textContent).toContain("14:00–14:30");
  expect(t.target.textContent).toContain("15:00–15:30");
  expect(t.target.textContent).toContain("Leaves the previous hour free.");
  t.target
    .querySelector<HTMLInputElement>('[aria-label="Include Review draft"]')!
    .click();
  await vi.waitFor(() => expect(t.target.textContent).toContain("1 selected"));
  await vi.waitFor(() =>
    expect(t.button("Apply selected").disabled).toBe(false),
  );
  t.button("Apply selected").click();
  await vi.waitFor(() =>
    expect(t.planner.applySelected).toHaveBeenCalledOnce(),
  );
  await vi.waitFor(() => expect(t.button("Dismiss").disabled).toBe(false));
  t.target
    .querySelector<HTMLButtonElement>('[aria-label="Dismiss Prepare outline"]')!
    .click();
  await vi.waitFor(() =>
    expect(t.planner.dismissAction).toHaveBeenCalledWith("schedule"),
  );
});

test("stale review disables apply and exposes refresh, checked Undo and recovery retry", async () => {
  const t = render(true);
  t.state.update((value) => ({
    ...value,
    issues: [
      {
        actionId: "move",
        code: "stale",
        message: "The destination note changed.",
      },
    ],
  }));
  flushSync();
  expect(t.button("Apply selected").disabled).toBe(true);
  expect(t.target.textContent).toContain("Schedule changed");
  t.button("Refresh context").click();
  await vi.waitFor(() => expect(t.planner.getContext).toHaveBeenCalledOnce());
  const batch = {
    actionIds: ["schedule"],
    edits: [],
    identities: {},
    createdUids: [],
    consumedRefs: [],
  };
  t.state.update((value) => ({
    ...value,
    issues: [],
    lastBatch: { phase: "applied", batch },
  }));
  flushSync();
  t.planner.undo.mockRejectedValueOnce(
    new Error("The note has changed. Review before undoing."),
  );
  await vi.waitFor(() => expect(t.button("Undo").disabled).toBe(false));
  t.button("Undo").click();
  await vi.waitFor(() =>
    expect(t.target.textContent).toContain("Review before undoing."),
  );
  t.state.update((value) => ({
    ...value,
    lastBatch: { phase: "cleanup", batch },
  }));
  flushSync();
  expect(t.target.textContent).toContain("waiting for calendar cleanup");
  expect(t.button("Apply selected").disabled).toBe(true);
  await vi.waitFor(() => expect(t.button("Retry").disabled).toBe(false));
  t.button("Retry").click();
  await vi.waitFor(() => expect(t.planner.retry).toHaveBeenCalledOnce());
});

test("saved-state recovery has an explicit reset action", async () => {
  const t = render();
  t.state.update((state) => ({
    ...state,
    recoveryRequired: true,
    ready: false,
    error: "Saved planning data needs recovery.",
  }));
  flushSync();
  t.button("Reset saved planning data").click();
  await vi.waitFor(() =>
    expect(t.planner.resetSavedState).toHaveBeenCalledOnce(),
  );
});
