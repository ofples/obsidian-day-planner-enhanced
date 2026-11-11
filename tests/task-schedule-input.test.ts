import { get } from "svelte/store";
import { describe, expect, test, vi } from "vitest";

import { TaskDrag, taskDragMime } from "../src/tasks/drag";
import {
  parseCaptureCandidates,
  captureTitle,
} from "../src/tasks/capture-parser";
import {
  taskInlineMarkdown,
  taskDropAllowed,
  taskDropUsesPlanner,
} from "../src/tasks/schedule-markdown";
import { resolveScheduleInput } from "../src/tasks/schedule-types";
import { TaskService } from "../src/tasks/service";
import type { TaskSnapshot } from "../src/tasks/types";

const snapshot: TaskSnapshot = {
  provider: "todoist",
  account: { id: "account", name: "Test", timezone: "UTC" },
  projects: [],
  tasks: [
    {
      id: "task",
      title: "Task",
      description: "",
      projectId: "work",
      parentId: null,
      labels: [],
      priority: 1,
      completed: false,
      order: 1,
      due: null,
    },
  ],
  fetchedAt: "2026-11-11T00:00:00Z",
};

async function dragFixture() {
  let cache: string | null = null,
    state: string | null = null,
    secret = "";
  const service = new TaskService(
    {
      read: async () => cache,
      write: async (text) => {
        cache = text;
      },
      readState: async () => state,
      writeState: async (text) => {
        state = text;
      },
      getSecret: () => secret,
      setSecret: (_key, value) => {
        secret = value;
      },
    },
    () => ({
      read: async () => structuredClone(snapshot),
      apply: async () => ({ taskId: "task" }),
    }),
  );
  await service.initialize();
  await service.connect("token");
  const values = new Map<string, string>();
  const transfer = {
    setData: (key: string, value: string) => {
      values.set(key, value);
    },
    getData: (key: string) => values.get(key) ?? "",
  } as DataTransfer;
  return { service, transfer, drag: new TaskDrag(service) };
}

describe("task scheduling input", () => {
  test("local dates resolve to timezone-aware overnight intervals", () => {
    expect(
      resolveScheduleInput("2026-11-11", "23:45", 30, "Asia/Kolkata"),
    ).toEqual({
      start: "2026-11-11T18:15:00.000Z",
      end: "2026-11-11T18:45:00.000Z",
    });
    expect(() =>
      resolveScheduleInput("2026-11-11", "09:00", 0, "UTC"),
    ).toThrow();
    expect(() =>
      resolveScheduleInput("2026-11-11", "09:00", 1441, "UTC"),
    ).toThrow();
  });

  test("DST gaps are refused and repeated clock times require their offset", () => {
    expect(() =>
      resolveScheduleInput("2026-03-08", "02:30", 30, "America/New_York"),
    ).toThrow("valid date and time");
    expect(() =>
      resolveScheduleInput("2026-11-01", "01:30", 30, "America/New_York"),
    ).toThrow("time offset");
    expect(
      resolveScheduleInput("2026-11-01", "01:30", 30, "America/New_York", -240)
        .start,
    ).toBe("2026-11-01T05:30:00.000Z");
    expect(
      resolveScheduleInput("2026-11-01", "01:30", 30, "America/New_York", -300)
        .start,
    ).toBe("2026-11-01T06:30:00.000Z");
  });

  test("remote literal tags, native-ID-like text and clock titles retain their text", () => {
    const title = "09:00 Review #work ^literal";
    const raw = `- [ ] ${taskInlineMarkdown(title)} #todoist #karma`;
    const candidate = parseCaptureCandidates("Tasks.md", raw)[0]!;
    expect(candidate.tags.map((tag) => tag.name)).toEqual(["todoist", "karma"]);
    expect(captureTitle(candidate, new Set(["todoist", "karma"]))).toBe(title);
  });

  test("Markdown drops exclude protected regions and preserve nested planner headings", () => {
    const text =
      "---\ntitle: Test\n---\n# Day planner\n## Afternoon\n\nPlain\n```md\ncode\n```\n%% hidden %%\n# Journal\n\n";
    expect(taskDropAllowed(text, 5)).toBe(false);
    expect(taskDropAllowed(text, text.indexOf("code"))).toBe(false);
    expect(taskDropAllowed(text, text.indexOf("hidden"))).toBe(false);
    expect(taskDropAllowed(text, text.indexOf("Plain"))).toBe(true);
    expect(
      taskDropUsesPlanner(text, text.indexOf("Plain"), "Day planner"),
    ).toBe(true);
    expect(taskDropUsesPlanner(text, text.length, "Day planner")).toBe(false);
  });

  test("drag payloads resolve through the current vault session and account", async () => {
    const h = await dragFixture();
    h.drag.start(snapshot.tasks[0]!, h.transfer);
    expect(h.drag.accept(h.transfer).task.id).toBe("task");
    expect(h.transfer.getData("text/plain")).toBe("Task");
    const original = h.transfer.getData(taskDragMime),
      payload = JSON.parse(original);
    h.transfer.setData(
      taskDragMime,
      JSON.stringify({ ...payload, namespace: "another-vault" }),
    );
    expect(() => h.drag.accept(h.transfer)).toThrow("another vault");
    h.transfer.setData(taskDragMime, original);
    expect(() => new TaskDrag(h.service).accept(h.transfer)).toThrow(
      "another vault",
    );
    h.service.disconnect();
    expect(() => h.drag.accept(h.transfer)).toThrow();
    h.drag.cancel();
    expect(get(h.drag.state)).toBeNull();
    h.service.stop();
  });

  test("expired drag tokens cannot schedule a cached task", async () => {
    const h = await dragFixture();
    h.drag.start(snapshot.tasks[0]!, h.transfer);
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 121_000);
    expect(() => h.drag.accept(h.transfer)).toThrow();
    clock.mockRestore();
    h.service.stop();
  });
});
