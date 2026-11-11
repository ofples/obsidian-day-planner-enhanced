import { describe, expect, test, vi } from "vitest";

import {
  reviewTaskConflict,
  taskConflictMutations,
} from "../src/tasks/conflict";
import {
  mutationFields,
  resolvedTaskOperation,
  type TaskOperation,
} from "../src/tasks/operations";
import { TaskService } from "../src/tasks/service";
import type { ProviderTask, TaskSnapshot } from "../src/tasks/types";

const base: ProviderTask = {
  id: "task",
  title: "Original",
  description: "Description",
  projectId: "work",
  parentId: null,
  labels: ["Keep"],
  priority: 1,
  completed: false,
  order: 1,
  due: null,
};
function conflict(patch: Partial<TaskOperation> = {}): TaskOperation {
  return {
    id: crypto.randomUUID(),
    tempId: crypto.randomUUID(),
    provider: "todoist",
    accountId: "account",
    base,
    mutation: {
      kind: "update",
      taskId: base.id,
      changes: { title: "Local", description: "Local description" },
    },
    status: "conflict",
    attempts: 0,
    createdAt: new Date().toISOString(),
    ...patch,
  };
}
async function setup(operation = conflict()) {
  let cache: string | null = null,
    disk: string | null = null,
    secret = "",
    failWrite = false;
  let remote: ProviderTask | null = {
    ...base,
    title: "Remote",
    description: "Remote description",
    priority: 4,
  };
  const snapshot = (): TaskSnapshot => ({
    provider: "todoist",
    account: { id: "account", name: "Test", timezone: "UTC" },
    projects: [{ id: "work", name: "Work", order: 1 }],
    tasks: remote ? [structuredClone(remote)] : [],
    fetchedAt: new Date().toISOString(),
  });
  const read = vi.fn(async () => snapshot());
  const apply = vi.fn(async (operation: TaskOperation) => {
    if (!remote) throw Error("Task missing");
    remote = { ...remote, ...mutationFields(operation.mutation) };
    return { taskId: base.id };
  });
  const storage = {
    read: async () => cache,
    write: async (value: string) => {
      cache = value;
    },
    readState: async () => disk,
    writeState: async (value: string) => {
      if (failWrite) throw Error("Registry offline");
      disk = value;
    },
    getSecret: () => secret,
    setSecret: (_key: string, value: string) => {
      secret = value;
    },
  };
  const provider = () => ({
    read,
    get: async () => structuredClone(remote),
    apply,
  });
  const service = new TaskService(storage, provider);
  await service.initialize();
  await service.connect("token");
  await service.registry.change((state) => {
    state.operations.push(operation);
  });
  await service.refresh();
  return {
    service,
    storage,
    provider,
    operation,
    read,
    apply,
    remote: () => remote,
    changeRemote: (value: ProviderTask | null) => {
      remote = value;
    },
    failWrite: () => {
      failWrite = true;
    },
  };
}

describe("saved task conflict resolution", () => {
  test("a lost resolution response resumes the saved replacement UUID after restart", async () => {
    const h = await setup();
    const review = await h.service.inspectConflict(h.operation.id);
    h.apply.mockImplementationOnce(async (operation) => {
      h.changeRemote({ ...h.remote()!, ...mutationFields(operation.mutation) });
      throw Error("Lost response");
    });
    await h.service.resolveConflict(review, {
      title: "local",
      description: "remote",
    });
    await h.service.refresh();
    await vi.waitUntil(
      () => h.service.registry.snapshot().operations[1]?.status === "sent",
    );
    const replacementId = h.service.registry.snapshot().operations[1]!.id;
    h.service.stop();
    const restarted = new TaskService(h.storage, h.provider);
    await restarted.initialize();
    await restarted.registry.updateOperation(replacementId, {
      retryAt: undefined,
    });
    await restarted.refresh();
    expect(h.apply.mock.calls.map(([operation]) => operation.id)).toEqual([
      replacementId,
      replacementId,
    ]);
    expect(restarted.registry.snapshot().operations[0]?.resolutionIds).toEqual([
      replacementId,
    ]);
    expect(restarted.registry.snapshot().operations[1]?.status).toBe(
      "complete",
    );
    restarted.stop();
  });

  test("resolving a command preserves the note's common field baseline until reconciliation", async () => {
    const h = await setup(conflict({ sourceUid: "source" }));
    await h.service.registry.change((state) => {
      state.links.source = {
        provider: "todoist",
        accountId: "account",
        taskId: base.id,
        base,
        source: {
          path: "Tasks.md",
          from: 0,
          raw: "- [ ] Original #todoist",
          title: base.title,
        },
      };
    });
    const review = await h.service.inspectConflict(h.operation.id);
    await h.service.resolveConflict(review, {
      title: "local",
      description: "remote",
    });
    await h.service.refresh();
    await vi.waitUntil(
      () => h.service.registry.snapshot().operations[1]?.status === "complete",
    );
    expect(h.service.registry.snapshot().links.source?.base).toEqual(base);
    h.service.stop();
  });

  test("replacement recovery rejects cycles, missing commands and another account", () => {
    const first = conflict({ status: "cancelled", readback: base });
    const second = conflict({
      status: "complete",
      readback: { ...base, title: "Resolved" },
    });
    first.resolutionIds = [second.id];
    expect(resolvedTaskOperation([first, second], first.id)).toMatchObject({
      status: "complete",
      task: { title: "Resolved" },
    });
    expect(resolvedTaskOperation([first], first.id)).toEqual({
      status: "conflict",
    });
    expect(
      resolvedTaskOperation(
        [first, { ...second, accountId: "other" }],
        first.id,
      ),
    ).toEqual({ status: "conflict" });
    expect(
      resolvedTaskOperation(
        [first, { ...second, status: "cancelled", resolutionIds: [first.id] }],
        first.id,
      ),
    ).toEqual({ status: "conflict" });
    expect(
      resolvedTaskOperation(
        [first, { ...second, status: "pending" }],
        first.id,
      ),
    ).toEqual({ status: "pending" });
  });

  test("field choices create narrow fresh commands and preserve the original intent", async () => {
    const h = await setup();
    const review = await h.service.inspectConflict(h.operation.id);
    expect(review.fields.map((field) => field.conflict)).toEqual([true, true]);
    const result = await h.service.resolveConflict(review, {
      title: "local",
      description: "remote",
    });
    expect(result.kind).toBe("saved");
    await h.service.refresh();
    await vi.waitUntil(
      () => h.service.registry.snapshot().operations[1]?.status === "complete",
    );
    expect(h.remote()).toMatchObject({
      title: "Local",
      description: "Remote description",
      priority: 4,
      labels: ["Keep"],
    });
    const [original, replacement] = h.service.registry.snapshot().operations;
    expect(original).toMatchObject({
      id: h.operation.id,
      mutation: h.operation.mutation,
      status: "cancelled",
      resolutionIds: [replacement!.id],
    });
    expect(replacement!.id).not.toBe(h.operation.id);
    expect(replacement!.mutation).toEqual({
      kind: "update",
      taskId: base.id,
      changes: { title: "Local" },
    });
    expect(h.apply).toHaveBeenCalledTimes(1);
    h.service.stop();
  });

  test("an edit while the dialog is open returns a new comparison without writing", async () => {
    const h = await setup();
    const review = await h.service.inspectConflict(h.operation.id);
    h.changeRemote({ ...h.remote()!, description: "Edited again" });
    const result = await h.service.resolveConflict(review, {
      title: "local",
      description: "remote",
    });
    expect(result.kind).toBe("changed");
    expect(h.apply).not.toHaveBeenCalled();
    expect(h.service.registry.snapshot().operations).toHaveLength(1);
    expect(h.service.registry.snapshot().operations[0]?.status).toBe(
      "conflict",
    );
    h.service.stop();
  });

  test("failed resolution persistence keeps the conflict and sends no command", async () => {
    const h = await setup();
    const review = await h.service.inspectConflict(h.operation.id);
    h.failWrite();
    await expect(
      h.service.resolveConflict(review, {
        title: "local",
        description: "remote",
      }),
    ).rejects.toThrow("Registry offline");
    expect(h.apply).not.toHaveBeenCalled();
    expect(h.service.registry.snapshot().operations[0]?.status).toBe(
      "conflict",
    );
    h.service.stop();
  });

  test("concurrent submissions save one replacement command", async () => {
    const h = await setup();
    const review = await h.service.inspectConflict(h.operation.id);
    const results = await Promise.allSettled([
      h.service.resolveConflict(review, {
        title: "local",
        description: "remote",
      }),
      h.service.resolveConflict(review, {
        title: "local",
        description: "remote",
      }),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    await h.service.refresh();
    await vi.waitUntil(() => h.apply.mock.calls.length === 1);
    expect(h.service.registry.snapshot().operations).toHaveLength(2);
    h.service.stop();
  });

  test("disconnect during the comparison prevents a resolution", async () => {
    const h = await setup();
    let finish!: (value: TaskSnapshot) => void;
    h.read.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const promise = h.service.inspectConflict(h.operation.id);
    await vi.waitUntil(() => Boolean(finish));
    h.service.disconnect();
    finish({
      provider: "todoist",
      account: { id: "account", name: "Test", timezone: "UTC" },
      projects: [],
      tasks: [base],
      fetchedAt: new Date().toISOString(),
    });
    await expect(promise).rejects.toThrow("account changed");
    expect(h.apply).not.toHaveBeenCalled();
    h.service.stop();
  });

  test("keeping a missing task cancels only its saved change", async () => {
    const h = await setup();
    h.changeRemote(null);
    const review = await h.service.inspectConflict(h.operation.id);
    expect(review.fields.every((field) => !field.localAllowed)).toBe(true);
    await h.service.resolveConflict(review, {
      title: "remote",
      description: "remote",
    });
    expect(h.service.registry.snapshot().operations[0]).toMatchObject({
      status: "cancelled",
      resolutionIds: [],
    });
    expect(h.apply).not.toHaveBeenCalled();
    h.service.stop();
  });

  test("an acknowledged create resolves by editing the same task", async () => {
    const operation = conflict({
      base: null,
      remoteId: base.id,
      mutation: {
        kind: "create",
        task: {
          title: "Local",
          description: base.description,
          projectId: base.projectId,
          parentId: null,
          labels: base.labels,
          priority: base.priority,
          due: null,
        },
      },
    });
    const h = await setup(operation);
    const review = await h.service.inspectConflict(operation.id);
    const choices = Object.fromEntries(
      review.fields.map((field) => [
        field.key,
        field.key === "title" ? ("local" as const) : ("remote" as const),
      ]),
    );
    await h.service.resolveConflict(review, choices);
    await h.service.refresh();
    await vi.waitUntil(() => h.apply.mock.calls.length === 1);
    expect(h.apply.mock.calls[0]![0].mutation).toEqual({
      kind: "update",
      taskId: base.id,
      changes: { title: "Local" },
    });
    h.service.stop();
  });

  test("recurring completion cannot be redirected into a newer occurrence", () => {
    const original = {
      ...base,
      due: {
        date: "2026-11-11",
        text: "every day",
        timezone: null,
        recurring: true,
      },
    };
    const operation = conflict({
      base: original,
      mutation: { kind: "complete", taskId: base.id },
    });
    const review = reviewTaskConflict(operation, {
      ...original,
      due: { ...original.due, date: "2026-11-12" },
    });
    expect(review.fields[0]?.localAllowed).toBe(false);
    expect(() => taskConflictMutations(review, { completed: "local" })).toThrow(
      "occurrence changed",
    );
    expect(taskConflictMutations(review, { completed: "remote" })).toEqual([]);
  });

  test("coupled schedule and placement choices stay together and reject omitted fields", () => {
    const operation = conflict({
      mutation: {
        kind: "create",
        task: {
          title: base.title,
          description: "",
          projectId: "other",
          parentId: "parent",
          labels: [],
          priority: 1,
          due: {
            date: "2026-11-12",
            text: "",
            recurring: false,
            timezone: null,
          },
          duration: { amount: 45, unit: "minute" },
        },
      },
    });
    const review = reviewTaskConflict(operation, base);
    expect(
      review.fields.find((field) => field.key === "placement")?.fields,
    ).toEqual(["projectId", "parentId"]);
    expect(
      review.fields.find((field) => field.key === "schedule")?.fields,
    ).toEqual(["due", "duration"]);
    expect(() => taskConflictMutations(review, {})).toThrow(
      "every saved field",
    );
    const choices = Object.fromEntries(
      review.fields.map((field) => [field.key, "local" as const]),
    );
    const planned = taskConflictMutations(review, choices);
    expect(planned.map((item) => item.mutation.kind)).toEqual([
      "moveProject",
      "moveParent",
      "update",
    ]);
    expect(planned[1]?.base).toMatchObject({
      projectId: "other",
      parentId: null,
    });
    expect(planned[2]?.base).toMatchObject({
      projectId: "other",
      parentId: "parent",
    });
  });
});
