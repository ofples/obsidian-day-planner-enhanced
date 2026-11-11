import { requestUrl } from "obsidian";
import { beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("obsidian", () => ({ requestUrl: vi.fn() }));

import type { TaskMutation, TaskOperation } from "../src/tasks/operations";
import { TodoistProvider } from "../src/tasks/todoist";

const operation = (mutation: TaskMutation): TaskOperation => ({
  id: crypto.randomUUID(),
  tempId: crypto.randomUUID(),
  provider: "todoist",
  accountId: "account",
  mutation,
  base: null,
  status: "sent",
  createdAt: new Date().toISOString(),
  attempts: 1,
});
const response = (json: unknown, status = 200) => ({
  status,
  json,
  headers: {},
  text: "",
  arrayBuffer: new ArrayBuffer(0),
});
beforeEach(() => vi.clearAllMocks());

describe("Todoist UUID write commands", () => {
  test("create reuses command and temporary IDs with only the supported task fields", async () => {
    const op = operation({
      kind: "create",
      task: {
        title: "New",
        description: "Description",
        projectId: "project",
        parentId: "parent",
        priority: 4,
        labels: ["label"],
        due: null,
      },
    });
    vi.mocked(requestUrl).mockResolvedValue(
      response({
        sync_status: { [op.id]: "ok" },
        temp_id_mapping: { [op.tempId]: "created" },
      }),
    );
    const api = new TodoistProvider("credential");
    expect(await api.apply(op)).toEqual({ taskId: "created" });
    await api.apply(op);
    const bodies = vi
      .mocked(requestUrl)
      .mock.calls.map(([arg]) =>
        JSON.parse(
          new URLSearchParams((arg as { body: string }).body).get("commands")!,
        ),
      );
    expect(bodies[0]).toEqual([
      {
        type: "item_add",
        uuid: op.id,
        temp_id: op.tempId,
        args: {
          content: "New",
          description: "Description",
          project_id: "project",
          parent_id: "parent",
          priority: 4,
          labels: ["label"],
          due: null,
        },
      },
    ]);
    expect(bodies[1]).toEqual(bodies[0]);
  });
  test("a narrow update preserves unmentioned descriptions, dates, duration and deadline", async () => {
    const op = operation({
      kind: "update",
      taskId: "task",
      changes: { title: "Updated" },
    });
    vi.mocked(requestUrl).mockResolvedValue(
      response({ sync_status: { [op.id]: "ok" } }),
    );
    await new TodoistProvider("credential").apply(op);
    const body = new URLSearchParams(
      (vi.mocked(requestUrl).mock.calls[0]![0] as { body: string }).body,
    );
    expect(JSON.parse(body.get("commands")!)[0].args).toEqual({
      id: "task",
      content: "Updated",
    });
  });
  test("rescheduling retains an existing recurrence rule", async () => {
    const op = operation({
      kind: "update",
      taskId: "task",
      changes: {
        due: {
          date: "2026-11-12",
          text: "every day",
          recurring: true,
          timezone: "Asia/Kolkata",
        },
      },
    });
    vi.mocked(requestUrl).mockResolvedValue(
      response({ sync_status: { [op.id]: "ok" } }),
    );
    await new TodoistProvider("credential").apply(op);
    const body = new URLSearchParams(
      (vi.mocked(requestUrl).mock.calls[0]![0] as { body: string }).body,
    );
    expect(JSON.parse(body.get("commands")!)[0].args.due).toEqual({
      date: "2026-11-12",
      string: "every day",
      is_recurring: true,
      timezone: "Asia/Kolkata",
    });
  });
  test.each([
    [
      { kind: "moveProject", taskId: "task", projectId: "destination" },
      "item_move",
      { id: "task", project_id: "destination" },
    ],
    [
      { kind: "moveParent", taskId: "task", parentId: "parent" },
      "item_move",
      { id: "task", parent_id: "parent" },
    ],
    [{ kind: "complete", taskId: "task" }, "item_close", { id: "task" }],
    [{ kind: "reopen", taskId: "task" }, "item_uncomplete", { id: "task" }],
  ] as const)(
    "maps %j to the provider command",
    async (mutation, type, args) => {
      const op = operation(mutation);
      vi.mocked(requestUrl).mockResolvedValue(
        response({ sync_status: { [op.id]: "ok" } }),
      );
      await new TodoistProvider("credential").apply(op);
      const body = new URLSearchParams(
        (vi.mocked(requestUrl).mock.calls[0]![0] as { body: string }).body,
      );
      expect(JSON.parse(body.get("commands")!)[0]).toEqual({
        uuid: op.id,
        type,
        args,
      });
    },
  );
  test("rejected and unacknowledged writes retain a safe error classification", async () => {
    const op = operation({ kind: "complete", taskId: "task" });
    vi.mocked(requestUrl).mockResolvedValueOnce(
      response({
        sync_status: {
          [op.id]: { error_code: 12, error: "private upstream detail" },
        },
      }),
    );
    await expect(
      new TodoistProvider("credential").apply(op),
    ).rejects.toMatchObject({
      permanent: true,
      message: expect.not.stringContaining("private upstream"),
    });
    vi.mocked(requestUrl).mockResolvedValueOnce(response({ sync_status: {} }));
    await expect(
      new TodoistProvider("credential").apply(op),
    ).rejects.toMatchObject({ permanent: false });
  });
});
