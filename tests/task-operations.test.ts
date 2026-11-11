import { describe, expect, test } from "vitest";

import {
  preflightOperation,
  matchesOperationResult,
  taskOperationSchema,
  type TaskOperation,
} from "../src/tasks/operations";
import { pendingSnapshot } from "../src/tasks/queue";
import { taskOccurrenceKey } from "../src/tasks/schedule-types";
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
  test("exact recurring undo couples its previous date and counter while preserving unrelated fields", () => {
    const previousDue = {
      date: "2026-11-12T03:30:00Z",
      recurring: true,
      text: "every day",
      timezone: "Asia/Kolkata",
    };
    const current = {
      ...base,
      completionCount: 4,
      due: { ...previousDue, date: "2026-11-13T03:30:00Z" },
    };
    const undo = taskOperationSchema.parse({
      ...operation,
      mutation: { kind: "reopen", taskId: base.id },
      base: current,
      recurringUndo: {
        occurrenceId: crypto.randomUUID(),
        completionCount: 3,
        due: previousDue,
      },
    });
    expect(
      preflightOperation(
        undo,
        {
          ...current,
          title: "Changed",
          due: { ...current.due, date: "2026-11-13T09:00:00" },
        },
        "Asia/Kolkata",
      ),
    ).toBe("ready");
    for (const changed of [
      { ...current, completionCount: 5 },
      { ...current, due: { ...current.due, date: "2026-11-14T09:00:00" } },
    ])
      expect(preflightOperation(undo, changed, "Asia/Kolkata")).toBe(
        "conflict",
      );
    const restored = {
      ...current,
      completionCount: 3,
      due: { ...previousDue, date: "2026-11-12T09:00:00" },
    };
    expect(matchesOperationResult(undo, restored, "Asia/Kolkata")).toBe(true);
    expect(preflightOperation(undo, restored, "Asia/Kolkata")).toBe(
      "already-applied",
    );
    expect(
      matchesOperationResult(
        undo,
        { ...restored, completionCount: 2 },
        "Asia/Kolkata",
      ),
    ).toBe(false);
    expect(
      matchesOperationResult(
        undo,
        { ...restored, completed: true },
        "Asia/Kolkata",
      ),
    ).toBe(false);
    expect(
      taskOperationSchema.safeParse({
        ...undo,
        recurringUndo: { ...undo.recurringUndo!, completionCount: 1 },
      }).success,
    ).toBe(false);
    expect(
      taskOperationSchema.safeParse({
        ...undo,
        mutation: { kind: "complete", taskId: base.id },
      }).success,
    ).toBe(false);
  });
  test("recurring completion accepts provider-normalized instants and keeps timezone/rule conflicts", () => {
    const due = {
      date: "2026-11-12T03:30:00.000Z",
      recurring: true,
      text: "every day",
      timezone: "Asia/Kolkata",
    };
    const recurring = { ...base, completionCount: 3, due };
    const op: TaskOperation = {
      ...operation,
      base: recurring,
      mutation: { kind: "complete", taskId: base.id },
    };
    const normalized = {
      ...recurring,
      due: { ...due, date: "2026-11-12T09:00:00" },
    };
    expect(preflightOperation(op, normalized, "Asia/Kolkata")).toBe("ready");
    expect(
      preflightOperation(
        op,
        { ...normalized, due: { ...normalized.due, timezone: "UTC" } },
        "Asia/Kolkata",
      ),
    ).toBe("conflict");
    expect(
      preflightOperation(
        op,
        { ...normalized, due: { ...normalized.due, text: "every week" } },
        "Asia/Kolkata",
      ),
    ).toBe("conflict");
    expect(
      preflightOperation(
        op,
        { ...normalized, completionCount: 4 },
        "Asia/Kolkata",
      ),
    ).toBe("conflict");
  });
  test("recurring completion requires one verified counter increment and preserves the rule", () => {
    const recurring: ProviderTask = {
      ...base,
      completionCount: 3,
      due: {
        date: "2026-11-12",
        recurring: true,
        text: "every day",
        timezone: null,
      },
    };
    const op: TaskOperation = {
      ...operation,
      base: recurring,
      mutation: { kind: "complete", taskId: base.id },
    };
    const moved = {
      ...recurring,
      due: { ...recurring.due!, date: "2026-11-13" },
    };
    expect(preflightOperation(op, recurring)).toBe("ready");
    expect(preflightOperation(op, { ...recurring, completed: true })).toBe(
      "conflict",
    );
    expect(preflightOperation({ ...op, base }, recurring)).toBe("conflict");
    expect(preflightOperation(op, { ...recurring, completionCount: 4 })).toBe(
      "conflict",
    );
    expect(
      preflightOperation(
        { ...op, base: { ...recurring, completionCount: undefined } },
        recurring,
      ),
    ).toBe("conflict");
    expect(matchesOperationResult(op, moved, "UTC")).toBe(false);
    expect(
      matchesOperationResult(op, { ...moved, completionCount: 4 }, "UTC"),
    ).toBe(true);
    expect(
      matchesOperationResult(op, { ...recurring, completionCount: 4 }, "UTC"),
    ).toBe(true);
    expect(
      matchesOperationResult(op, { ...moved, completionCount: 5 }, "UTC"),
    ).toBe(false);
    expect(
      matchesOperationResult(
        op,
        {
          ...moved,
          completionCount: 4,
          due: { ...moved.due, text: "every week" },
        },
        "UTC",
      ),
    ).toBe(false);
    expect(
      matchesOperationResult(
        op,
        {
          ...moved,
          completionCount: 4,
          due: { ...moved.due, timezone: "Asia/Kolkata" },
        },
        "UTC",
      ),
    ).toBe(false);
    expect(
      matchesOperationResult(
        op,
        { ...recurring, completionCount: 4, completed: true },
        "UTC",
      ),
    ).toBe(true);
  });
  test("a recurring reschedule stays in the same occurrence and cannot move an advanced occurrence", () => {
    const recurring: ProviderTask = {
      ...base,
      completionCount: 2,
      due: {
        date: "2026-11-12",
        recurring: true,
        text: "every day",
        timezone: "UTC",
      },
    };
    const moved = {
      ...recurring,
      due: { ...recurring.due!, date: "2026-11-13" },
    };
    const op: TaskOperation = {
      ...operation,
      base: recurring,
      mutation: {
        kind: "update",
        taskId: base.id,
        changes: { due: moved.due },
      },
    };
    expect(taskOccurrenceKey(recurring)).toBe(taskOccurrenceKey(moved));
    expect(taskOccurrenceKey(recurring)).not.toBe(
      taskOccurrenceKey({ ...recurring, completionCount: 3 }),
    );
    expect(preflightOperation(op, recurring)).toBe("ready");
    expect(preflightOperation(op, { ...recurring, completionCount: 3 })).toBe(
      "conflict",
    );
    expect(
      preflightOperation(
        { ...op, mutation: { kind: "reopen", taskId: base.id } },
        recurring,
      ),
    ).toBe("conflict");
  });
  test("readback accepts equivalent provider timezones and flags ignored durations", () => {
    const op: TaskOperation = {
      ...operation,
      mutation: {
        kind: "update",
        taskId: "task",
        changes: {
          due: {
            date: "2026-11-12T09:30:00Z",
            text: "",
            recurring: false,
            timezone: null,
          },
          duration: { amount: 45, unit: "minute" },
        },
      },
    };
    const remote: ProviderTask = {
      ...base,
      due: {
        date: "2026-11-12T09:30:00Z",
        text: "2026-11-12 15:00",
        recurring: false,
        timezone: "Asia/Kolkata",
      },
      duration: { amount: 45, unit: "minute" },
    };
    expect(matchesOperationResult(op, remote, "Asia/Kolkata")).toBe(true);
    expect(
      matchesOperationResult(op, { ...remote, duration: null }, "Asia/Kolkata"),
    ).toBe(false);
    expect(
      matchesOperationResult(
        op,
        { ...remote, due: { ...remote.due!, date: "2026-11-12T15:00:00" } },
        "Asia/Kolkata",
      ),
    ).toBe(true);
  });
  test("duration updates accept legacy empty values and preserve concurrent schedule edits", () => {
    const op: TaskOperation = {
      ...operation,
      mutation: {
        kind: "update",
        taskId: "task",
        changes: { duration: { amount: 45, unit: "minute" } },
      },
    };
    expect(preflightOperation(op, { ...base, duration: null })).toBe("ready");
    expect(
      preflightOperation(op, {
        ...base,
        duration: { amount: 30, unit: "minute" },
      }),
    ).toBe("conflict");
    expect(
      preflightOperation(op, {
        ...base,
        duration: { amount: 45, unit: "minute" },
      }),
    ).toBe("already-applied");
    const due = {
      date: "2026-11-12T09:00:00",
      recurring: true,
      text: "every day",
      timezone: "UTC",
    };
    expect(
      preflightOperation(
        {
          ...op,
          base: { ...base, due },
          mutation: {
            kind: "update",
            taskId: "task",
            changes: { due: { ...due, date: "2026-11-13T09:00:00" } },
          },
        },
        { ...base, due: { ...due, timezone: "Asia/Kolkata" } },
      ),
    ).toBe("conflict");
  });
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
