import { requestUrl } from "obsidian";
import { beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("obsidian", () => ({ requestUrl: vi.fn() }));

import { TodoistProvider } from "../src/tasks/todoist";

const user = {
  id: "user",
  full_name: "Test",
  tz_info: { timezone: "UTC" },
  token: "must-not-cache",
};
const task = {
  id: "task",
  project_id: "project",
  parent_id: null,
  content: "Task",
  description: "",
  labels: [],
  priority: 1,
  checked: false,
  child_order: 1,
  due: null,
};
const project = { id: "project", name: "Work", child_order: 1 };
const response = (json: unknown, status = 200, headers = {}) => ({
  status,
  json,
  headers,
  text: "",
  arrayBuffer: new ArrayBuffer(0),
});
beforeEach(() => vi.clearAllMocks());

function pages(taskPage: (url: URL) => unknown) {
  vi.mocked(requestUrl).mockImplementation((arg) => {
    const url = new URL(typeof arg === "string" ? arg : arg.url);
    if (url.pathname.endsWith("/user"))
      return Promise.resolve(response(user)) as ReturnType<typeof requestUrl>;
    if (url.pathname.endsWith("/projects"))
      return Promise.resolve(
        response({ results: [project], next_cursor: null }),
      ) as ReturnType<typeof requestUrl>;
    if (url.pathname.endsWith("/sync"))
      return Promise.resolve(
        response({ user_settings: { reset_recurring_subtasks: true } }),
      ) as ReturnType<typeof requestUrl>;
    return Promise.resolve(response(taskPage(url))) as ReturnType<
      typeof requestUrl
    >;
  });
}

describe("Todoist complete snapshots", () => {
  test("reports provider duration capability without storing other user fields", async () => {
    pages(() => ({ results: [task], next_cursor: null }));
    const request = vi.mocked(requestUrl).getMockImplementation()!;
    vi.mocked(requestUrl).mockImplementation((arg) =>
      (typeof arg === "string" ? arg : arg.url).endsWith("/user")
        ? (Promise.resolve(
            response({ ...user, is_premium: false }),
          ) as ReturnType<typeof requestUrl>)
        : request(arg),
    );
    const snapshot = await new TodoistProvider("credential").read();
    expect(snapshot.account.capabilities).toEqual({
      duration: false,
      delete: true,
      recurringUndo: true,
    });
    expect(JSON.stringify(snapshot)).not.toContain("must-not-cache");
  });
  test("normalizes duration data while accepting older cached task shapes", async () => {
    pages(() => ({
      results: [
        { ...task, duration: { amount: 45, unit: "minute" } },
        { ...task, id: "older" },
      ],
      next_cursor: null,
    }));
    const snapshot = await new TodoistProvider("credential").read();
    expect(snapshot.tasks[0]?.duration).toEqual({ amount: 45, unit: "minute" });
    expect(snapshot.tasks[1]?.duration).toBeUndefined();
  });
  test("retains recurring completion counters and the subtask reset preference", async () => {
    pages(() => ({
      results: [{ ...task, completed_count: 3 }],
      next_cursor: null,
    }));
    const snapshot = await new TodoistProvider("credential").read();
    expect(snapshot.tasks[0]?.completionCount).toBe(3);
    expect(snapshot.account.preferences).toEqual({
      resetRecurringSubtasks: true,
    });
    const settings = vi
      .mocked(requestUrl)
      .mock.calls.find(
        ([arg]) => typeof arg !== "string" && arg.url.endsWith("/sync"),
      )![0] as { body: string };
    expect(new URLSearchParams(settings.body).get("resource_types")).toBe(
      '["user_settings"]',
    );
    expect(JSON.stringify(snapshot)).not.toContain("must-not-cache");
  });
  test.each([null, -1, 0.5, "3"])(
    "rejects an invalid completion counter %j",
    async (count) => {
      pages(() => ({
        results: [{ ...task, completed_count: count }],
        next_cursor: null,
      }));
      await expect(new TodoistProvider("credential").read()).rejects.toThrow();
    },
  );
  test("a missing reset preference fails the fresh snapshot before publishing partial data", async () => {
    pages(() => ({ results: [task], next_cursor: null }));
    const request = vi.mocked(requestUrl).getMockImplementation()!;
    vi.mocked(requestUrl).mockImplementation((arg) =>
      (typeof arg === "string" ? arg : arg.url).endsWith("/sync")
        ? (Promise.resolve(response({ user_settings: {} })) as ReturnType<
            typeof requestUrl
          >)
        : request(arg),
    );
    await expect(new TodoistProvider("credential").read()).rejects.toThrow();
  });
  test("reads all cursor pages and excludes unexpected account fields including token", async () => {
    pages((url) =>
      url.searchParams.has("cursor")
        ? { results: [{ ...task, id: "second" }], next_cursor: null }
        : { results: [task], next_cursor: "page-two" },
    );
    const snapshot = await new TodoistProvider("credential").read();
    expect(snapshot.tasks.map((item) => item.id)).toEqual(["task", "second"]);
    expect(snapshot.account).toEqual({
      id: "user",
      name: "Test",
      timezone: "UTC",
      preferences: { resetRecurringSubtasks: true },
      capabilities: { delete: true, recurringUndo: true },
    });
    expect(JSON.stringify(snapshot)).not.toContain("must-not-cache");
    expect(requestUrl).toHaveBeenCalledTimes(5);
  });
  test("partial pages and malformed resources fail the entire snapshot", async () => {
    pages((url) =>
      url.searchParams.has("cursor")
        ? { results: [{ ...task, id: "" }], next_cursor: null }
        : { results: [task], next_cursor: "next" },
    );
    await expect(new TodoistProvider("credential").read()).rejects.toThrow();
  });
  test("repeated cursors and duplicate resource IDs are rejected", async () => {
    pages(() => ({ results: [task], next_cursor: "repeat" }));
    await expect(new TodoistProvider("credential").read()).rejects.toThrow(
      "repeated page",
    );
    pages((url) => ({
      results: [task],
      next_cursor: url.searchParams.has("cursor") ? null : "next",
    }));
    await expect(new TodoistProvider("credential").read()).rejects.toThrow(
      "duplicate resources",
    );
  });
  test("reports safe authorization and retry messages without response bodies", async () => {
    vi.mocked(requestUrl).mockResolvedValueOnce(
      response({ secret: "response-body" }, 401),
    );
    await expect(new TodoistProvider("credential").read()).rejects.toThrow(
      "Reconnect Todoist",
    );
    vi.mocked(requestUrl).mockResolvedValueOnce(
      response({}, 429, { "retry-after": "120" }),
    );
    await expect(
      new TodoistProvider("credential").read(),
    ).rejects.toMatchObject({ retryAt: expect.any(Number) });
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
