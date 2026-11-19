import { describe, expect, test } from "vitest";

import {
  googleTaskId,
  resolveSourceTask,
  taskSourceKey,
  taskSourceReference,
} from "../src/tasks/source-references";
import {
  taskCacheSchema,
  taskSnapshotSchema,
  type ProviderTask,
  type TaskSnapshot,
} from "../src/tasks/types";

const task = (id: string): ProviderTask => ({
  id,
  title: "Prepare review",
  description: "Keep supporting notes",
  projectId: "work",
  parentId: null,
  labels: [],
  priority: 1,
  completed: false,
  order: 1,
  due: null,
});
const snapshot = (
  provider: string,
  accountId: string,
  tasks: ProviderTask[],
): TaskSnapshot => ({
  provider,
  account: { id: accountId, name: "Test", timezone: "Asia/Kolkata" },
  projects: [{ id: "work", name: "Work", order: 1 }],
  tasks,
  fetchedAt: "2026-11-19T00:00:00Z",
});

describe("external task references", () => {
  test("same native IDs cannot cross source, account or Google list boundaries", () => {
    const snapshots = [
      snapshot("todoist", "account", [task("same")]),
      snapshot("github", "account", [task("same")]),
      snapshot("github", "other", [task("same")]),
    ];
    const refs = snapshots.map((item) =>
      taskSourceReference(item, item.tasks[0]!),
    );
    expect(new Set(refs.map(taskSourceKey)).size).toBe(3);
    for (const [index, ref] of refs.entries()) {
      expect(resolveSourceTask(snapshots, ref)?.snapshot).toBe(
        snapshots[index],
      );
    }
    expect(
      resolveSourceTask(snapshots, { ...refs[0]!, accountId: "signed-out" }),
    ).toBeNull();
    expect(googleTaskId("one", "same")).not.toBe(googleTaskId("two", "same"));
    expect(googleTaskId("one:two", "three")).not.toBe(
      googleTaskId("one", "two:three"),
    );
  });

  test("a converted draft resolves through current membership without changing issue identity", () => {
    const issue = task("issue-node");
    issue.source = {
      kind: "issue",
      nativeId: "issue-node",
      memberships: [
        { containerId: "project-one", itemId: "former-draft-item", order: 1 },
        { containerId: "project-two", itemId: "second-item", order: 3 },
      ],
    };
    const data = snapshot("github", "account", [issue]);
    for (const itemId of ["issue-node", "former-draft-item", "second-item"]) {
      expect(
        resolveSourceTask([data], {
          provider: "github",
          accountId: "account",
          itemId,
        })?.task,
      ).toBe(issue);
    }
    expect(data.tasks).toHaveLength(1);
    expect(
      resolveSourceTask([], {
        provider: "github",
        accountId: "account",
        itemId: "former-draft-item",
      }),
    ).toBeNull();
  });

  test("old caches still parse and new memberships survive persistence", () => {
    const old = snapshot("todoist", "account", [task("old")]);
    expect(
      taskCacheSchema.parse({
        version: 1,
        namespace: "a".repeat(32),
        snapshot: old,
      }).snapshot,
    ).toEqual(old);
    const issue = task("issue");
    issue.source = {
      kind: "issue",
      nativeId: "issue",
      dateMeaning: "target",
      memberships: [
        {
          containerId: "project",
          itemId: "item",
          order: 1,
          status: { fieldId: "status", optionId: "ready", name: "Ready" },
          date: { fieldId: "target", value: "2026-11-20" },
        },
      ],
    };
    const data = snapshot("github", "account", [issue]);
    expect(taskSnapshotSchema.parse(JSON.parse(JSON.stringify(data)))).toEqual(
      data,
    );
  });
});
