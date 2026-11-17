import { get } from "svelte/store";
import { beforeEach, expect, test } from "vitest";

import { buildPlanningBatch } from "../src/ai-scheduling/markdown";
import {
  AiPlanningService,
  PlanningUndoBlockedError,
  type PlanningHost,
  type PlanningReceipt,
  type PlanningRequest,
} from "../src/ai-scheduling/service";
import { planningContextSchema } from "../src/ai-scheduling/types";
import { configureTimestampRegExps } from "../src/regexp";
import { defaultSettingsForTests } from "../src/settings";

const path = "Daily/2031-01-01.md";
const original = "# Plan\n\nPrivate journal text\n";
const preferences = {
  startHour: 6,
  endHour: 22,
  defaultDurationMinutes: 30,
  instructions: "Protect lunch",
};
const settings = {
  ...defaultSettingsForTests,
  plannerHeading: "Plan",
  plannerHeadingLevel: 1,
  timestampFormat: "HH:mm",
};
const proposal = {
  version: 1,
  contextId: "context-1",
  actions: [
    {
      id: "first",
      kind: "schedule",
      sourceRef: "one",
      start: "2031-01-01T10:00:00Z",
      end: "2031-01-01T10:30:00Z",
    },
    {
      id: "second",
      kind: "schedule",
      sourceRef: "two",
      start: "2031-01-01T11:00:00Z",
      end: "2031-01-01T11:30:00Z",
    },
  ],
};

beforeEach(() => configureTimestampRegExps("HH:mm"));

function fixture(initialSaved: string | null = null) {
  let saved: string | null = initialSaved;
  const backups: string[] = [];
  let hold = false;
  let failAppliedSave = false;
  let failCleanup = false;
  let sourceWrites = 0;
  let applyCalls = 0;
  let lastRequest: PlanningRequest | undefined;
  const files: Record<string, string | null> = { [path]: original };
  const host: PlanningHost = {
    backupState: async () => {
      if (saved !== null) backups.push(saved);
    },
    readState: async () => saved,
    writeState: async (text) => {
      if (failAppliedSave && JSON.parse(text).lastBatch?.phase === "applied") {
        failAppliedSave = false;
        throw new Error("sidecar save failed");
      }
      saved = text;
    },
    defaults: () => ({
      startDate: "2031-01-01",
      dayCount: 1,
      request: "",
      preferences,
    }),
    context: async (request) => {
      lastRequest = request;
      return planningContextSchema.parse({
        version: 1,
        id: "context-1",
        createdAt: "2031-01-01T06:00:00Z",
        timezone: "UTC",
        startDate: "2031-01-01",
        dayCount: 1,
        request: request.request ?? "",
        preferences: request.preferences,
        documents: { [path]: { date: "2031-01-01", text: files[path] } },
        tasks: [
          {
            ref: "one",
            kind: "todoist",
            title: "First",
            raw: "- [ ] First",
            provider: "todoist",
            accountId: "account",
            taskId: "one",
          },
          {
            ref: "two",
            kind: "todoist",
            title: "Second",
            raw: "- [ ] Second",
            provider: "todoist",
            accountId: "account",
            taskId: "two",
          },
        ],
        blocks: [],
        commitments: [],
        freshness: {},
      });
    },
    readDocuments: async (paths) =>
      Object.fromEntries(paths.map((name) => [name, files[name] ?? null])),
    apply: async (draft, selectedIds, prepared, onPrepared) => {
      applyCalls++;
      const batch =
        prepared?.batch ??
        buildPlanningBatch(draft.context, draft.proposal, selectedIds, {
          settings,
          currentDocuments: { ...files },
          newUids: { first: "a".repeat(32), second: "b".repeat(32) },
        });
      const receipt: PlanningReceipt = prepared ?? {
        id: `receipt-${applyCalls}`,
        phase: "prepared",
        createdAt: "2031-01-01T06:00:00Z",
        contextBefore: draft.context,
        batch,
        identityPatchBefore: {},
        createdTemplates: {},
      };
      if (!prepared) await onPrepared(receipt);
      for (const edit of batch.edits) {
        files[edit.path] = edit.after;
        sourceWrites++;
      }
      return receipt;
    },
    undo: async (receipt, onNotesRestored) => {
      if (receipt.phase !== "cleanup") {
        if (receipt.batch.edits.some((edit) => files[edit.path] !== edit.after))
          throw new PlanningUndoBlockedError("Review required");
        for (const edit of receipt.batch.edits) {
          files[edit.path] = edit.before;
          sourceWrites++;
        }
        await onNotesRestored();
      }
      if (failCleanup) throw new Error("cleanup failed");
    },
    setUndoHold: (value) => {
      hold = value;
    },
  };
  return {
    host,
    files,
    backups,
    get saved() {
      return saved;
    },
    get hold() {
      return hold;
    },
    get sourceWrites() {
      return sourceWrites;
    },
    get applyCalls() {
      return applyCalls;
    },
    get lastRequest() {
      return lastRequest;
    },
    failNextAppliedSave() {
      failAppliedSave = true;
    },
    setCleanupFailure(value: boolean) {
      failCleanup = value;
    },
  };
}

async function prepare(service: AiPlanningService) {
  await service.getContext({});
  await service.submitProposal(proposal);
}

test("preparation is private, persists preferences and has no source effects", async () => {
  const fake = fixture();
  const service = new AiPlanningService(fake.host);
  await service.savePreferences({ ...preferences, instructions: "Saved rule" });
  const result = await service.getContext({ request: "Plan today" });
  expect(JSON.stringify(result)).not.toContain("Private journal text");
  expect(result.context).not.toHaveProperty("documents");
  expect(fake.lastRequest?.preferences?.instructions).toBe("Saved rule");
  await expect(
    service.submitProposal({
      ...proposal,
      actions: [proposal.actions[0], proposal.actions[0]],
    }),
  ).rejects.toThrow("unique ID");
  expect(service.getStatus().draft).toBeNull();
  await service.submitProposal(proposal);
  await service.showTaskView({
    version: 1,
    contextId: "context-1",
    buckets: [{ id: "b", title: "Tasks", taskRefs: ["one"] }],
  });
  expect(service.getStatus().taskBuckets).toHaveLength(1);
  expect(fake.sourceWrites).toBe(0);
  const reloaded = new AiPlanningService(fake.host);
  await reloaded.initialize();
  expect(reloaded.getDefaults().preferences.instructions).toBe("Saved rule");
  expect(reloaded.getStatus().draft?.selectedIds).toEqual(["first", "second"]);
});

test("subset acceptance survives reload and remaining work cannot duplicate accepted work", async () => {
  const fake = fixture();
  let service = new AiPlanningService(fake.host);
  await prepare(service);
  await service.selectAction("second", false);
  await service.applySelected();
  service = new AiPlanningService(fake.host);
  await service.initialize();
  expect(service.getStatus().draft?.acceptedIds).toEqual(["first"]);
  await service.selectAction("first", true);
  await service.selectAction("second", true);
  await service.applySelected();
  await service.applySelected();
  expect(fake.applyCalls).toBe(2);
  expect(fake.files[path]?.match(/First/g)).toHaveLength(1);
  expect(fake.files[path]?.match(/Second/g)).toHaveLength(1);
});

test("undo restores the accepted batch and protects subsequent manual edits", async () => {
  const fake = fixture();
  const service = new AiPlanningService(fake.host);
  await prepare(service);
  await service.applySelected();
  const after = fake.files[path]!;
  fake.files[path] += "\nManual edit";
  await expect(service.undo()).rejects.toThrow("Review required");
  expect(fake.files[path]).toContain("Manual edit");
  expect(service.getStatus().lastBatch?.phase).toBe("applied");
  expect(fake.hold).toBe(false);
  expect(service.getStatus().issues).toEqual([]);
  fake.files[path] = after;
  await service.undo();
  expect(fake.files[path]).toBe(original);
  expect(service.getStatus().lastBatch?.phase).toBe("undone");
});

test("undoing an earlier batch preserves a newer draft", async () => {
  const fake = fixture();
  const service = new AiPlanningService(fake.host);
  await prepare(service);
  await service.applySelected();
  const originalContext = fake.host.context;
  fake.host.context = async (request) => ({
    ...(await originalContext(request)),
    id: "context-2",
  });
  await service.getContext({ request: "A new plan" });
  await service.submitProposal({ ...proposal, contextId: "context-2" });
  await service.undo();
  const draft = service.getStatus().draft!;
  expect(draft.proposal.contextId).toBe("context-2");
  expect(draft.selectedIds).toEqual(["first", "second"]);
  expect(draft.acceptedIds).toEqual([]);
  expect(draft.rejectedIds).toEqual([]);
  expect(fake.files[path]).toBe(original);
});

test("reload recognizes a prepared receipt whose note write completed before save failed", async () => {
  const fake = fixture();
  let service = new AiPlanningService(fake.host);
  await prepare(service);
  fake.failNextAppliedSave();
  await expect(service.applySelected()).rejects.toThrow("sidecar save failed");
  expect(JSON.parse(fake.saved!).lastBatch.phase).toBe("prepared");
  service = new AiPlanningService(fake.host);
  await service.initialize();
  expect(service.getStatus().lastBatch?.phase).toBe("applied");
  expect(service.getStatus().draft?.acceptedIds).toEqual(["first", "second"]);
  expect(fake.applyCalls).toBe(1);
  expect(fake.files[path]?.match(/First/g)).toHaveLength(1);
});

test("failed cleanup survives reload, blocks another apply and can be retried", async () => {
  const fake = fixture();
  let service = new AiPlanningService(fake.host);
  await prepare(service);
  await service.selectAction("second", false);
  await service.applySelected();
  fake.setCleanupFailure(true);
  await expect(service.undo()).rejects.toThrow("cleanup failed");
  expect(fake.hold).toBe(true);
  expect(service.getStatus().lastBatch?.phase).toBe("cleanup");
  service = new AiPlanningService(fake.host);
  await service.initialize();
  expect(fake.hold).toBe(true);
  await service.selectAction("second", true);
  await expect(service.applySelected()).rejects.toThrow("pending AI operation");
  expect(service.getStatus().lastBatch?.phase).toBe("cleanup");
  fake.setCleanupFailure(false);
  await service.retry();
  expect(service.getStatus().lastBatch?.phase).toBe("undone");
  expect(fake.hold).toBe(false);
  expect(get(service.state).error).toBe("");
});

test("corrupt saved state is backed up and reset without changing notes or cached tasks", async () => {
  const corrupt = "{unfinished saved draft";
  const fake = fixture(corrupt);
  const originalFiles = structuredClone(fake.files);
  const cachedTasks = (await fake.host.context({ preferences })).tasks;
  let service = new AiPlanningService(fake.host);
  await expect(service.initialize()).rejects.toThrow();
  expect(get(service.state).recoveryRequired).toBe(true);
  await service.resetSavedState();
  expect(fake.backups).toEqual([corrupt]);
  expect(get(service.state).recoveryRequired).toBe(false);
  expect(fake.files).toEqual(originalFiles);
  expect(fake.sourceWrites).toBe(0);
  expect(fake.applyCalls).toBe(0);
  const prepared = await service.getContext({ request: "Resume planning" });
  expect(prepared.context.tasks).toEqual(cachedTasks);
  expect(prepared.context.request).toBe("Resume planning");

  await service.submitProposal({
    ...proposal,
    actions: [{ ...proposal.actions[0]!, sourceRef: "unavailable" }],
  });
  expect(service.getStatus().issues).toHaveLength(1);
  service = new AiPlanningService(fake.host);
  await service.initialize();
  expect(service.getStatus().issues).toHaveLength(1);
  expect(fake.sourceWrites).toBe(0);
});
