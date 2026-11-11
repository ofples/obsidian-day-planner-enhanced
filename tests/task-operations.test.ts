import { describe, expect, test } from "vitest";

import {
  preflightOperation,
  type TaskOperation,
} from "../src/tasks/operations";
import { pendingSnapshot } from "../src/tasks/queue";
import type { ProviderTask, TaskSnapshot } from "../src/tasks/types";

const base: ProviderTask = {
  id: "task",
  title: "Original",
  description: "Keep",
  projectId: "work",
  parentId: null,
  labels: ["one", "two"],
  priority: 1,
  completed: false,
  order: 1,
  due: null,
};
const operation: TaskOperation = {
  id: crypto.randomUUID(),
  tempId: crypto.randomUUID(),
  provider: "todoist",
  accountId: "account",
  base,
  mutation: { kind: "update", taskId: "task", changes: { title: "Edited" } },
  status: "pending",
  attempts: 0,
  createdAt: new Date().toISOString(),
};

describe("task write comparisons", () => {
  test("independent remote edits survive and conflicting edits stop", () => {
    expect(
      preflightOperation(operation, {
        ...base,
        description: "Remote description",
      }),
    ).toBe("ready");
    expect(
      preflightOperation(operation, { ...base, title: "Remote title" }),
    ).toBe("conflict");
    expect(preflightOperation(operation, { ...base, title: "Edited" })).toBe(
      "already-applied",
    );
    expect(preflightOperation(operation, null)).toBe("conflict");
  });
  test("label order and nonrecurring human date wording do not introduce conflicts", () => {
    const op = {
      ...operation,
      mutation: {
        kind: "update" as const,
        taskId: "task",
        changes: { labels: ["two", "one"] },
      },
    };
    expect(preflightOperation(op, base)).toBe("already-applied");
  });
  test("a recurring completion stops if the next occurrence is already active", () => {
    const recurring = {
      ...base,
      due: {
        date: "2026-11-11",
        recurring: true,
        text: "every day",
        timezone: null,
      },
    };
    const op = {
      ...operation,
      base: recurring,
      mutation: { kind: "complete" as const, taskId: "task" },
    };
    expect(
      preflightOperation(op, {
        ...recurring,
        due: { ...recurring.due, date: "2026-11-12" },
      }),
    ).toBe("conflict");
  });
  test("pending changes are projected without mutating the acknowledged cache", () => {
    const snapshot: TaskSnapshot = {
      provider: "todoist",
      account: { id: "account", name: "Test", timezone: "UTC" },
      projects: [],
      tasks: [base],
      fetchedAt: new Date().toISOString(),
    };
    expect(pendingSnapshot(snapshot, [operation])?.tasks[0]?.title).toBe(
      "Edited",
    );
    expect(snapshot.tasks[0]?.title).toBe("Original");
    expect(
      pendingSnapshot(snapshot, [{ ...operation, status: "conflict" }])
        ?.tasks[0]?.title,
    ).toBe("Original");
  });
});
