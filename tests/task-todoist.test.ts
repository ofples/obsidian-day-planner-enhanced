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
    return Promise.resolve(response(taskPage(url))) as ReturnType<
      typeof requestUrl
    >;
  });
}

describe("Todoist complete snapshots", () => {
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
    });
    expect(JSON.stringify(snapshot)).not.toContain("must-not-cache");
    expect(requestUrl).toHaveBeenCalledTimes(4);
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
