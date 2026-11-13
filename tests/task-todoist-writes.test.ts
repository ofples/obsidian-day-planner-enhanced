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
  test("exact undo restores the selected due date with one immutable UUID and preserves child statuses", async () => {
    const op = operation({ kind: "reopen", taskId: "task" });
    op.recurringUndo = {
      occurrenceId: crypto.randomUUID(),
      completionCount: 2,
      due: {
        date: "2026-11-12T09:00:00",
        text: "every day",
        recurring: true,
        timezone: "Asia/Kolkata",
      },
    };
    vi.mocked(requestUrl).mockResolvedValue(
      response({ sync_status: { [op.id]: "ok" } }),
    );
    const api = new TodoistProvider("credential");
    await api.apply(op);
    await api.apply(op);
    const commands = vi
      .mocked(requestUrl)
      .mock.calls.map(([arg]) =>
        JSON.parse(
          new URLSearchParams((arg as { body: string }).body).get("commands")!,
        ),
      );
    expect(commands[0]).toEqual([
      {
        uuid: op.id,
        type: "item_update_date_complete",
        args: {
          id: "task",
          is_forward: 0,
          reset_subtasks: 0,
          due: {
            date: "2026-11-12T09:00:00",
            string: "every day",
            is_recurring: true,
            timezone: "Asia/Kolkata",
          },
        },
      },
    ]);
    expect(commands[1]).toEqual(commands[0]);
  });
  test.each([true, false])(
    "recurring completion freezes reset-subtasks %j across replay",
    async (resetSubtasks) => {
      const op = operation({ kind: "complete", taskId: "task" });
      op.recurringCompletion = { resetSubtasks };
      vi.mocked(requestUrl).mockResolvedValue(
        response({ sync_status: { [op.id]: "ok" } }),
      );
      const api = new TodoistProvider("credential");
      await api.apply(op);
      await api.apply(op);
      const commands = vi
        .mocked(requestUrl)
        .mock.calls.map(([arg]) =>
          JSON.parse(
            new URLSearchParams((arg as { body: string }).body).get(
              "commands",
            )!,
          ),
        );
      expect(commands[0]).toEqual([
        {
          uuid: op.id,
          type: "item_update_date_complete",
          args: {
            id: "task",
            is_forward: 1,
            reset_subtasks: Number(resetSubtasks),
          },
        },
      ]);
      expect(commands[1]).toEqual(commands[0]);
    },
  );
  test("deletion uses item_delete with the same durable UUID on retry", async () => {
    const op = operation({ kind: "delete", taskId: "task" });
    vi.mocked(requestUrl).mockResolvedValue(
      response({ sync_status: { [op.id]: "ok" } }),
    );
    const api = new TodoistProvider("credential");
    await api.apply(op);
    await api.apply(op);
    const commands = vi
      .mocked(requestUrl)
      .mock.calls.map(([arg]) =>
        JSON.parse(
          new URLSearchParams((arg as { body: string }).body).get("commands")!,
        ),
      );
    expect(commands[0]).toEqual([
      { type: "item_delete", uuid: op.id, args: { id: "task" } },
    ]);
    expect(commands[1]).toEqual(commands[0]);
  });
  test("schedule patches send the Sync duration object and can clear it explicitly", async () => {
    const api = new TodoistProvider("credential");
    const op = operation({
      kind: "update",
      taskId: "task",
      changes: {
        duration: { amount: 45, unit: "minute" },
        due: {
          date: "2026-11-12T09:00:00Z",
          text: "",
          recurring: false,
          timezone: null,
        },
      },
    });
    vi.mocked(requestUrl).mockResolvedValue(
      response({ sync_status: { [op.id]: "ok" } }),
    );
    await api.apply(op);
    const args = JSON.parse(
      new URLSearchParams(
        (vi.mocked(requestUrl).mock.calls[0]![0] as { body: string }).body,
      ).get("commands")!,
    )[0].args;
    expect(args.duration).toEqual({ amount: 45, unit: "minute" });
    expect(args.due.date).toBe("2026-11-12T09:00:00Z");
    const clear = operation({
      kind: "update",
      taskId: "task",
      changes: { duration: null },
    });
    vi.mocked(requestUrl).mockResolvedValue(
      response({ sync_status: { [clear.id]: "ok" } }),
    );
    await api.apply(clear);
    expect(
      JSON.parse(
        new URLSearchParams(
          (vi.mocked(requestUrl).mock.calls[1]![0] as { body: string }).body,
        ).get("commands")!,
      )[0].args,
    ).toEqual({ id: "task", duration: null });
  });
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

// Adapter contracts exercise HTTP shape; timing is covered by request-gate tests.
vi.mock("../src/service/request-gate", async (load) => {
  const actual = await load<typeof import("../src/service/request-gate")>();
  const gate = {
    run: async <T extends { status: number; headers: Record<string, string> }>(
      send: () => Promise<T>,
    ) => {
      const response = await send();
      return {
        response,
        retryAt: actual.retryAfterAt(
          response.headers["retry-after"],
          Date.now(),
        ),
      };
    },
  };
  return {
    ...actual,
    todoistRequestGate: () => gate,
    googleRequestGate: () => gate,
  };
});
