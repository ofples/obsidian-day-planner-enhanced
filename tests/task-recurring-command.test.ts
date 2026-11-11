import { get } from "svelte/store";
import { describe, expect, test, vi } from "vitest";

import type { TaskOperation } from "../src/tasks/operations";
import { TaskService } from "../src/tasks/service";
import {
  TaskReadError,
  type ProviderTask,
  type TaskProvider,
  type TaskSnapshot,
} from "../src/tasks/types";

const task: ProviderTask = {
  id: "recurring",
  title: "Water plants",
  description: "Keep this description",
  projectId: "home",
  parentId: null,
  labels: [],
  priority: 1,
  order: 1,
  completed: false,
  completionCount: 0,
  due: {
    date: "2026-11-12",
    recurring: true,
    text: "every day",
    timezone: null,
  },
};
const snapshot = (
  value: ProviderTask,
  resetRecurringSubtasks = true,
): TaskSnapshot => ({
  provider: "todoist",
  account: {
    id: "account",
    name: "Test",
    timezone: "Asia/Kolkata",
    preferences: { resetRecurringSubtasks },
    capabilities: { recurringUndo: true },
  },
  projects: [{ id: "home", name: "Home", order: 1 }],
  tasks: [value],
  fetchedAt: "2026-11-12T00:00:00Z",
});

async function setup() {
  let disk = JSON.stringify({
    version: 1,
    namespace: "a".repeat(32),
    snapshot: snapshot(task),
  });
  let state: string | null = null;
  let failStateWrite = false;
  const storage = {
    read: async () => disk,
    write: async (value: string) => {
      disk = value;
    },
    readState: async () => state,
    writeState: async (value: string) => {
      if (failStateWrite) throw new Error("State write interrupted");
      state = value;
    },
    getSecret: () => "credential",
    setSecret: vi.fn(),
  };
  let remote = structuredClone(task);
  let online = false;
  let loseResponse = false;
  let resetRecurringSubtasks = true;
  const applied = new Set<string>();
  const apply = vi.fn(async (operation: TaskOperation) => {
    if (!applied.has(operation.id)) {
      applied.add(operation.id);
      remote = operation.recurringUndo
        ? {
            ...remote,
            completionCount: operation.recurringUndo.completionCount,
            due: operation.recurringUndo.due,
            completed: false,
          }
        : {
            ...remote,
            completionCount: remote.completionCount! + 1,
            due: { ...remote.due!, date: "2026-11-13" },
          };
    }
    if (loseResponse) {
      loseResponse = false;
      throw new Error("Response lost");
    }
    return { taskId: remote.id };
  });
  const readTask = vi.fn(async () => structuredClone(remote));
  const provider: TaskProvider = {
    capabilities: { recurringUndo: true },
    read: vi.fn(async () => {
      if (!online) throw new TaskReadError("Offline");
      return snapshot(remote, resetRecurringSubtasks);
    }),
    get: readTask,
    apply,
  };
  const create = async () => {
    const service = new TaskService(storage, () => provider);
    await service.initialize();
    return service;
  };
  return {
    service: await create(),
    create,
    apply,
    applied,
    removeCachedUndoCapability() {
      const cached = JSON.parse(disk);
      delete cached.snapshot.account.capabilities.recurringUndo;
      disk = JSON.stringify(cached);
    },
    provider,
    readTask,
    remote: () => remote,
    online: () => {
      online = true;
    },
    offline: () => {
      online = false;
    },
    setRemote: (value: ProviderTask) => {
      remote = structuredClone(value);
    },
    failStateWrite: (value: boolean) => {
      failStateWrite = value;
    },
    loseResponse: () => {
      loseResponse = true;
    },
    preference: (value: boolean) => {
      resetRecurringSubtasks = value;
    },
  };
}

describe("exact recurring undo command", () => {
  async function completed() {
    const h = await setup();
    h.online();
    const completion = await h.service.complete(task);
    await h.service.refresh();
    expect(
      h.service.registry.snapshot().occurrences[completion.id]?.phase,
    ).toBe("complete");
    return { ...h, completion };
  }

  test("concurrent offline undo requests save one original occurrence and command across restart", async () => {
    const h = await completed();
    const before = structuredClone(
      h.service.registry.snapshot().occurrences[h.completion.id]!.before,
    );
    h.offline();
    const [first, second] = await Promise.all([
      h.service.requestOccurrenceUndo(h.completion.id),
      h.service.requestOccurrenceUndo(h.completion.id),
    ]);
    await h.service.refresh();
    expect(first.id).toBe(second.id);
    expect(first.recurringUndo).toEqual({
      occurrenceId: h.completion.id,
      completionCount: 0,
      due: task.due,
    });
    expect(h.apply).toHaveBeenCalledTimes(1);
    h.service.stop();
    h.online();
    const restored = await h.create();
    await restored.refresh();
    expect(h.remote()).toMatchObject({
      completionCount: 0,
      completed: false,
      due: task.due,
    });
    expect(h.apply.mock.calls[1]![0]).toMatchObject({
      id: first.id,
      recurringUndo: first.recurringUndo,
    });
    expect(
      restored.registry.snapshot().occurrences[h.completion.id],
    ).toMatchObject({
      phase: "complete",
      undo: {
        id: first.id,
        phase: "local-pending",
        readback: { completionCount: 0 },
      },
    });
    expect(
      restored.registry.snapshot().occurrences[h.completion.id]?.before,
    ).toEqual(before);
    restored.stop();
  });

  test("older cached accounts can queue offline undo through the provider's declared capability", async () => {
    const h = await completed();
    h.service.stop();
    h.removeCachedUndoCapability();
    h.offline();
    const restored = await h.create();
    expect(
      get(restored.state).snapshot?.account.capabilities?.recurringUndo,
    ).toBeUndefined();
    const undo = await restored.requestOccurrenceUndo(h.completion.id);
    await restored.refresh();
    expect(
      restored.registry
        .snapshot()
        .operations.find((operation) => operation.id === undo.id)?.status,
    ).toBe("pending");
    expect(h.apply).toHaveBeenCalledTimes(1);
    restored.stop();
  });

  test("a lost undo response replays the same UUID without decrementing twice", async () => {
    const h = await completed();
    h.loseResponse();
    const undo = await h.service.requestOccurrenceUndo(h.completion.id);
    await h.service.refresh();
    expect(h.remote().completionCount).toBe(0);
    expect(
      h.service.registry.snapshot().operations.find((op) => op.id === undo.id)
        ?.status,
    ).toBe("sent");
    h.service.stop();
    const restored = await h.create();
    await restored.registry.updateOperation(undo.id, { retryAt: undefined });
    await restored.refresh();
    expect(
      h.apply.mock.calls.slice(1).map(([operation]) => operation.id),
    ).toEqual([undo.id, undo.id]);
    expect(h.remote().completionCount).toBe(0);
    expect(
      restored.registry.snapshot().occurrences[h.completion.id]?.undo?.phase,
    ).toBe("local-pending");
    restored.stop();
  });

  test("failed intent persistence sends no undo command and keeps the original history", async () => {
    const h = await completed();
    const state = h.service.registry.snapshot();
    h.failStateWrite(true);
    await expect(
      h.service.requestOccurrenceUndo(h.completion.id),
    ).rejects.toThrow("State write interrupted");
    expect(h.service.registry.snapshot()).toEqual(state);
    expect(h.apply).toHaveBeenCalledTimes(1);
    expect(h.remote().completionCount).toBe(1);
    h.service.stop();
  });

  test("an unsent undo cancels atomically while provider preflight is awaiting a read", async () => {
    const h = await completed();
    h.offline();
    const undo = await h.service.requestOccurrenceUndo(h.completion.id);
    await h.service.refresh();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.readTask.mockClear();
    h.readTask.mockImplementationOnce(async () => {
      await gate;
      return h.remote();
    });
    h.online();
    const pending = h.service.refresh();
    await vi.waitUntil(() => h.readTask.mock.calls.length === 1);
    await h.service.cancelOccurrenceUndo(h.completion.id);
    release();
    await pending;
    expect(
      h.service.registry.snapshot().operations.find((op) => op.id === undo.id)
        ?.status,
    ).toBe("cancelled");
    expect(
      h.service.registry.snapshot().occurrences[h.completion.id]?.undo?.phase,
    ).toBe("cancelled");
    expect(h.apply).toHaveBeenCalledTimes(1);
    expect(h.remote().completionCount).toBe(1);
    h.service.stop();
  });

  test("a claimed undo requires verification before cancellation", async () => {
    const h = await completed();
    h.offline();
    await h.service.requestOccurrenceUndo(h.completion.id);
    await h.service.refresh();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const apply = h.apply.getMockImplementation()!;
    h.apply.mockImplementationOnce(async (op) => {
      await gate;
      return apply(op);
    });
    h.online();
    const pending = h.service.refresh();
    await vi.waitUntil(() => h.apply.mock.calls.length === 2);
    await expect(
      h.service.cancelOccurrenceUndo(h.completion.id),
    ).rejects.toThrow("has started");
    release();
    await pending;
    expect(h.remote().completionCount).toBe(0);
    expect(
      h.service.registry.snapshot().occurrences[h.completion.id]?.undo?.phase,
    ).toBe("local-pending");
    h.service.stop();
  });

  test("a newer completion or reschedule rejects the saved undo before sending", async () => {
    const h = await completed();
    h.offline();
    const undo = await h.service.requestOccurrenceUndo(h.completion.id);
    await h.service.refresh();
    h.setRemote({
      ...h.remote(),
      completionCount: 2,
      due: { ...task.due!, date: "2026-11-14" },
    });
    h.online();
    await h.service.refresh();
    expect(
      h.service.registry.snapshot().operations.find((op) => op.id === undo.id)
        ?.status,
    ).toBe("conflict");
    expect(h.apply).toHaveBeenCalledTimes(1);
    expect(h.remote().completionCount).toBe(2);
    await h.service.cancelOccurrenceUndo(h.completion.id);
    expect(
      h.service.registry.snapshot().occurrences[h.completion.id]?.undo?.phase,
    ).toBe("cancelled");
    h.service.stop();
  });

  test("provider undo already applied elsewhere is verified without another command", async () => {
    const h = await completed();
    h.offline();
    const undo = await h.service.requestOccurrenceUndo(h.completion.id);
    await h.service.refresh();
    h.setRemote({ ...h.remote(), completionCount: 0, due: task.due });
    h.online();
    await h.service.refresh();
    expect(
      h.service.registry.snapshot().operations.find((op) => op.id === undo.id)
        ?.status,
    ).toBe("complete");
    expect(h.apply).toHaveBeenCalledTimes(1);
    expect(
      h.service.registry.snapshot().occurrences[h.completion.id]?.undo?.readback
        ?.completionCount,
    ).toBe(0);
    h.service.stop();
  });

  test("narrow undo preserves unrelated remote edits and reserves the task until note recovery", async () => {
    const h = await completed();
    h.setRemote({
      ...h.remote(),
      title: "Current title",
      description: "Current description",
      labels: ["Current"],
    });
    await h.service.refresh();
    await h.service.requestOccurrenceUndo(h.completion.id);
    await h.service.refresh();
    expect(h.remote()).toMatchObject({
      completionCount: 0,
      title: "Current title",
      description: "Current description",
      labels: ["Current"],
    });
    await expect(h.service.complete(h.remote())).rejects.toThrow(
      "occurrence history",
    );
    h.service.stop();
  });

  test.each(["missing", "foreign", "changed-baseline"])(
    "a %s undo receipt blocks provider replay",
    async (mode) => {
      const h = await completed();
      h.offline();
      const undo = await h.service.requestOccurrenceUndo(h.completion.id);
      await h.service.refresh();
      await h.service.registry.change((state) => {
        const record = state.occurrences[h.completion.id]!;
        if (mode === "missing") delete record.undo;
        if (mode === "foreign") record.accountId = "other";
        if (mode === "changed-baseline")
          record.undo!.current.title = "Changed saved baseline";
      });
      h.online();
      await h.service.refresh();
      expect(
        h.service.registry
          .snapshot()
          .operations.find((op) => op.id === undo.id),
      ).toMatchObject({
        status: "failed",
        error: expect.stringContaining("undo receipt"),
      });
      expect(h.apply).toHaveBeenCalledTimes(1);
      expect(h.remote().completionCount).toBe(1);
      h.service.stop();
    },
  );

  test("a fresh review can undo the previous completion after rescheduling the current occurrence", async () => {
    const h = await completed();
    h.setRemote({ ...h.remote(), due: { ...task.due!, date: "2026-11-20" } });
    await h.service.refresh();
    const undo = await h.service.requestOccurrenceUndo(h.completion.id);
    await h.service.refresh();
    expect(undo.base?.due?.date).toBe("2026-11-20");
    expect(h.remote()).toMatchObject({ completionCount: 0, due: task.due });
    h.service.stop();
  });

  test("verified undo readback survives failure before publishing the refreshed snapshot", async () => {
    const h = await completed();
    h.offline();
    const undo = await h.service.requestOccurrenceUndo(h.completion.id);
    await h.service.refresh();
    h.online();
    vi.mocked(h.provider.read)
      .mockResolvedValueOnce(snapshot(h.remote()))
      .mockRejectedValueOnce(new TaskReadError("Snapshot interrupted"));
    await h.service.refresh();
    expect(
      h.service.registry
        .snapshot()
        .operations.find((operation) => operation.id === undo.id)?.status,
    ).toBe("verified");
    expect(
      h.service.registry.snapshot().occurrences[h.completion.id]?.undo,
    ).toMatchObject({
      phase: "local-pending",
      readback: { completionCount: 0 },
    });
    h.service.stop();
    const restored = await h.create();
    await restored.refresh();
    expect(h.apply).toHaveBeenCalledTimes(2);
    expect(
      restored.registry
        .snapshot()
        .operations.find((operation) => operation.id === undo.id)?.status,
    ).toBe("complete");
    expect(get(restored.state).snapshot?.tasks[0]?.completionCount).toBe(0);
    restored.stop();
  });

  test.each(["advanced", "rule", "account", "capability"])(
    "undo review rejects a changed %s boundary",
    async (mode) => {
      const h = await completed();
      if (mode === "advanced")
        h.setRemote({ ...h.remote(), completionCount: 2 });
      if (mode === "rule")
        h.setRemote({
          ...h.remote(),
          due: { ...task.due!, text: "every week" },
        });
      await h.service.refresh();
      if (mode === "account")
        h.service.state.update((state) => ({
          ...state,
          snapshot: {
            ...state.snapshot!,
            account: { ...state.snapshot!.account, id: "other" },
          },
        }));
      if (mode === "capability")
        h.service.state.update((state) => ({
          ...state,
          snapshot: {
            ...state.snapshot!,
            account: {
              ...state.snapshot!.account,
              capabilities: { recurringUndo: false },
            },
          },
        }));
      await expect(
        h.service.requestOccurrenceUndo(h.completion.id),
      ).rejects.toThrow();
      expect(h.apply).toHaveBeenCalledTimes(1);
      expect(
        h.service.registry.snapshot().occurrences[h.completion.id]?.undo,
      ).toBeUndefined();
      h.service.stop();
    },
  );
});

describe("recurring completion intent", () => {
  test("an older sent command recovers an occurrence journal and reuses its original payload", async () => {
    const h = await setup();
    h.online();
    h.loseResponse();
    const saved = await h.service.complete(task);
    await h.service.refresh();
    await h.service.registry.change((state) => {
      delete state.occurrences[saved.id];
    });
    h.service.stop();
    const restored = await h.create();
    await restored.registry.updateOperation(saved.id, { retryAt: undefined });
    await restored.refresh();
    expect(restored.registry.snapshot().occurrences[saved.id]).toMatchObject({
      recovered: true,
      phase: "complete",
      before: { task: { completionCount: 0 } },
      next: { completionCount: 1 },
    });
    expect(h.apply.mock.calls.map(([operation]) => operation.id)).toEqual([
      saved.id,
      saved.id,
    ]);
    expect(h.remote().completionCount).toBe(1);
    restored.stop();
  });
  test("concurrent offline clicks retain one occurrence and one frozen preference across restart", async () => {
    const h = await setup();
    const [first, second] = await Promise.all([
      h.service.complete(task),
      h.service.complete(task),
    ]);
    await h.service.refresh();
    expect(second.id).toBe(first.id);
    expect(h.service.registry.snapshot().operations).toHaveLength(1);
    expect(first.recurringCompletion).toEqual({ resetSubtasks: true });
    expect(h.apply).not.toHaveBeenCalled();
    h.service.stop();
    h.online();
    h.preference(false);
    const restored = await h.create();
    await restored.refresh();
    expect(h.apply).toHaveBeenCalledTimes(1);
    expect(h.apply.mock.calls[0]![0].recurringCompletion).toEqual({
      resetSubtasks: true,
    });
    expect(restored.registry.snapshot().operations[0]).toMatchObject({
      status: "complete",
      base: { completionCount: 0 },
      readback: { completionCount: 1 },
    });
    expect(get(restored.state).snapshot?.tasks).toHaveLength(1);
    expect(get(restored.state).snapshot?.tasks[0]).toMatchObject({
      completed: false,
      completionCount: 1,
    });
    expect(
      get(restored.state).snapshot?.account.preferences?.resetRecurringSubtasks,
    ).toBe(false);
    restored.stop();
  });

  test("a lost response replays the immutable UUID and advances the occurrence once", async () => {
    const h = await setup();
    h.online();
    h.loseResponse();
    const saved = await h.service.complete(task);
    await h.service.refresh();
    expect(h.service.registry.snapshot().operations[0]?.status).toBe("sent");
    expect(h.remote().completionCount).toBe(1);
    h.service.stop();
    h.preference(false);
    const restored = await h.create();
    await restored.registry.updateOperation(saved.id, { retryAt: undefined });
    await restored.refresh();
    expect(h.apply.mock.calls.map(([operation]) => operation.id)).toEqual([
      saved.id,
      saved.id,
    ]);
    expect(h.apply.mock.calls[0]![0].recurringCompletion).toEqual(
      h.apply.mock.calls[1]![0].recurringCompletion,
    );
    expect(h.applied.size).toBe(1);
    expect(h.remote().completionCount).toBe(1);
    expect(restored.registry.snapshot().operations[0]?.status).toBe("complete");
    restored.stop();
  });

  test("a stale task row keeps its original occurrence and cannot complete the next one", async () => {
    const h = await setup();
    h.online();
    await h.service.complete(task);
    await h.service.refresh();
    expect(h.remote().completionCount).toBe(1);
    const stale = await h.service.complete(task);
    await h.service.refresh();
    expect(
      h.service.registry
        .snapshot()
        .operations.find((item) => item.id === stale.id)?.status,
    ).toBe("conflict");
    expect(h.apply).toHaveBeenCalledTimes(1);
    expect(h.remote().completionCount).toBe(1);
    h.service.stop();
  });

  test("another occurrence cannot replace the saved completion while it is offline", async () => {
    const h = await setup();
    await h.service.complete(task);
    await expect(
      h.service.complete({ ...task, completionCount: 1 }),
    ).rejects.toThrow("saved recurring completion");
    expect(h.service.registry.snapshot().operations).toHaveLength(1);
    h.service.stop();
  });

  test("legacy recurring data requires a refreshed occurrence counter", async () => {
    const h = await setup();
    await expect(
      h.service.complete({ ...task, completionCount: undefined }),
    ).rejects.toThrow("load its occurrence");
    expect(h.service.registry.snapshot().operations).toHaveLength(0);
    h.service.stop();
  });
  test("a schedule-owned command keeps its reserved identity when another completion is pending", async () => {
    const h = await setup();
    await h.service.complete(task);
    const id = crypto.randomUUID();
    await expect(
      h.service.mutate({ kind: "complete", taskId: task.id }, undefined, {
        id,
        base: task,
        provider: "todoist",
        accountId: "account",
      }),
    ).rejects.toThrow("saved recurring completion");
    expect(h.service.registry.snapshot().operations).toHaveLength(1);
    expect(h.service.registry.snapshot().operations[0]?.id).not.toBe(id);
    h.service.stop();
  });
});
