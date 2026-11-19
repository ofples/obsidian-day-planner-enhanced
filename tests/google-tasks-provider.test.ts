import { describe, expect, test, vi } from "vitest";

import {
  GoogleTasksProvider,
  type GoogleTasksSelection,
} from "../src/tasks/google-tasks";
import type { SourceRequest } from "../src/tasks/source-http";
import { googleTaskId } from "../src/tasks/source-references";
import { TaskReadError } from "../src/tasks/types";

const account = {
  id: "google-subject",
  name: "Test",
  timezone: "Asia/Kolkata",
};
const options = (): GoogleTasksSelection => ({
  listIds: ["work", "home"],
  showAssigned: false,
  allowCompletion: false,
});
const remote = (id: string, patch: Record<string, unknown> = {}) => ({
  id,
  title: id,
  position: id,
  updated: "2026-11-19T00:00:00Z",
  ...patch,
});

describe("Google Tasks source", () => {
  test("reads selected lists with native hierarchy, notes, order and date-only scheduling", async () => {
    const request = vi.fn<SourceRequest>(async (path) => {
      const url = new URL(path, "https://tasks.googleapis.com");
      if (url.pathname.endsWith("users/@me/lists"))
        return {
          items: [
            { id: "work", title: "Work" },
            { id: "home", title: "Home" },
          ],
        };
      expect(url.searchParams.get("showCompleted")).toBe("false");
      expect(url.searchParams.get("showAssigned")).toBe("false");
      if (url.pathname.includes("lists/home/"))
        return { items: [remote("parent")] };
      return {
        items: [
          remote("child", {
            position: "002",
            parent: "parent",
            notes: "Supporting details",
          }),
          remote("parent", {
            position: "001",
            due: "2026-11-20T00:00:00Z",
            webViewLink: "https://tasks.google.com/task/opaque",
          }),
        ],
      };
    });
    const result = await new GoogleTasksProvider(
      request,
      account,
      options,
    ).read();
    expect(result.coverage.complete).toBe(true);
    expect(
      result.snapshot.tasks.map((item) => [item.id, item.parentId, item.order]),
    ).toEqual([
      [googleTaskId("work", "child"), googleTaskId("work", "parent"), 1],
      [googleTaskId("work", "parent"), null, 0],
      [googleTaskId("home", "parent"), null, 0],
    ]);
    const parent = result.snapshot.tasks.find(
      (task) => task.id === googleTaskId("work", "parent"),
    )!;
    expect(parent.due).toEqual({
      date: "2026-11-20",
      recurring: false,
      text: "2026-11-20",
      timezone: null,
    });
    expect(parent.source?.dateMeaning).toBe("scheduled");
    expect(parent.labels).toEqual([]);
    expect(result.snapshot.tasks[0]?.description).toBe("Supporting details");
    expect(result.snapshot.account.capabilities?.complete).toBe(false);
    expect(request).toHaveBeenCalledTimes(3);
  });

  test("enforces a shared page budget and continues without repeating completed streams", async () => {
    const request = vi.fn<SourceRequest>(async (path) => {
      const url = new URL(path, "https://tasks.googleapis.com");
      if (url.pathname.endsWith("users/@me/lists"))
        return { items: [{ id: "work", title: "Work" }] };
      const page = Number(url.searchParams.get("pageToken") ?? 0);
      return {
        items: [
          remote(`task-${page}`, { position: String(page).padStart(3, "0") }),
        ],
        ...(page < 21 ? { nextPageToken: String(page + 1) } : {}),
      };
    });
    const provider = new GoogleTasksProvider(request, account, () => ({
      ...options(),
      listIds: ["work"],
    }));
    const first = await provider.read();
    expect(request).toHaveBeenCalledTimes(20);
    expect(first.coverage.complete).toBe(false);
    expect(first.snapshot.tasks).toHaveLength(19);
    const second = await provider.read(first);
    expect(second.coverage.complete).toBe(true);
    expect(second.snapshot.tasks).toHaveLength(22);
    expect(request).toHaveBeenCalledTimes(23);
    expect(second.snapshot.tasks.map((task) => task.order)).toEqual(
      Array.from({ length: 22 }, (_, index) => index),
    );
  });

  test("missing selected lists are explicit partial coverage and an empty selection sends no task reads", async () => {
    const request = vi.fn<SourceRequest>(async () => ({
      items: [{ id: "work", title: "Work" }],
    }));
    const missing = await new GoogleTasksProvider(request, account, () => ({
      ...options(),
      listIds: ["missing"],
    })).read();
    expect(missing.coverage.complete).toBe(false);
    expect(missing.coverage.streams[1]?.error).toMatch(/unavailable/);
    const empty = await new GoogleTasksProvider(request, account, () => ({
      ...options(),
      listIds: [],
    })).read();
    expect(empty.snapshot.tasks).toEqual([]);
    expect(empty.coverage.complete).toBe(true);
    expect(request).toHaveBeenCalledTimes(2);
  });

  test("completion is explicit, checks freshness and never writes without an editing grant", async () => {
    let selection = { ...options(), listIds: ["work"] };
    const request = vi.fn<SourceRequest>(async (path, requestOptions) => {
      if (path.includes("users/@me/lists"))
        return { items: [{ id: "work", title: "Work" }] };
      if (path.includes("?")) return { items: [remote("item")] };
      return remote("item", {
        status: requestOptions ? "completed" : "needsAction",
      });
    });
    const provider = new GoogleTasksProvider(request, account, () => selection);
    const task = (await provider.read()).snapshot.tasks[0]!;
    await expect(provider.complete(task)).rejects.toThrow(/editing access/);
    expect(
      request.mock.calls.some(([, options]) => options?.method === "PATCH"),
    ).toBe(false);
    selection = { ...selection, allowCompletion: true };
    expect((await provider.complete(task)).completed).toBe(true);
    expect(
      request.mock.calls.filter(([, options]) => options?.method === "PATCH"),
    ).toHaveLength(1);
    expect(request.mock.calls.at(-1)?.[1]?.body).toEqual({
      status: "completed",
    });
    await expect(
      provider.complete({
        ...task,
        source: { ...task.source!, updatedAt: "old" },
      }),
    ).rejects.toThrow(/changed/);
    expect(
      request.mock.calls.filter(([, options]) => options?.method === "PATCH"),
    ).toHaveLength(1);
  });

  test("a missing task can be verified without synthesizing a mutation", async () => {
    const request = vi.fn<SourceRequest>(async (path) => {
      if (path.includes("users/@me/lists"))
        return { items: [{ id: "work", title: "Work" }] };
      if (path.includes("?")) return { items: [remote("item")] };
      throw new TaskReadError("Gone", undefined, false, 404);
    });
    const provider = new GoogleTasksProvider(request, account, () => ({
      ...options(),
      listIds: ["work"],
    }));
    const task = (await provider.read()).snapshot.tasks[0]!;
    expect(await provider.get(task)).toBeNull();
    expect(request.mock.calls.some(([, options]) => options)).toBe(false);
  });
});
