import { writable } from "svelte/store";
import { describe, expect, test, vi } from "vitest";

import {
  taskEditorFields,
  taskEditorDraft,
  saveTaskEditor,
} from "../src/tasks/editor";
import type { TaskMutation, TaskOperation } from "../src/tasks/operations";
import type { TaskBrowserState, TaskService } from "../src/tasks/service";
import type { ProviderTask, TaskSnapshot } from "../src/tasks/types";

const task: ProviderTask = {
  id: "task",
  title: "Original",
  description: "Keep this",
  projectId: "work",
  parentId: null,
  labels: ["existing"],
  priority: 1,
  completed: false,
  order: 1,
  due: {
    date: "2026-11-11T04:30:00Z",
    timezone: "Asia/Kolkata",
    text: "every day",
    recurring: true,
  },
};
const snapshot: TaskSnapshot = {
  provider: "todoist",
  account: { id: "account", name: "Fixture", timezone: "Asia/Kolkata" },
  projects: [
    { id: "work", name: "Work", order: 1, inbox: true },
    { id: "home", name: "Home", order: 2 },
  ],
  tasks: [task],
  fetchedAt: "2026-11-11T00:00:00Z",
};

function harness() {
  const state = writable<TaskBrowserState>({
    snapshot,
    connected: true,
    loading: false,
    error: "",
    writable: true,
    aliases: {},
    operations: [],
    completed: [],
  });
  const mutate = vi.fn(
    async (mutation: TaskMutation) =>
      ({
        id: crypto.randomUUID(),
        tempId: "temporary",
        provider: "todoist",
        accountId: "account",
        mutation,
        base: task,
        status: "pending",
        attempts: 0,
        createdAt: snapshot.fetchedAt,
      }) as TaskOperation,
  );
  return {
    state,
    mutate,
    service: { state, mutate } as unknown as TaskService,
  };
}

describe("custom task editor", () => {
  test("unchanged date retains the provider's complete recurrence metadata", () => {
    const fields = taskEditorFields(snapshot, task);
    expect(fields.date).toBe("2026-11-11");
    expect(taskEditorDraft(snapshot, fields, task).due).toEqual(task.due);
  });

  test("moving a task date retains its local clock time and recurrence", () => {
    const fields = { ...taskEditorFields(snapshot, task), date: "2026-11-12" };
    expect(taskEditorDraft(snapshot, fields, task).due).toEqual({
      ...task.due,
      date: "2026-11-12T10:00:00.000+05:30",
    });
  });

  test("clearing the date and deduplicating labels are explicit field edits", () => {
    const draft = taskEditorDraft(
      snapshot,
      {
        ...taskEditorFields(snapshot, task),
        date: "",
        labels: "home, errands, home, ",
      },
      task,
    );
    expect(draft.due).toBeNull();
    expect(draft.labels).toEqual(["home", "errands"]);
  });

  test("new subtasks inherit their parent's project and remote identity", () => {
    const fields = {
      ...taskEditorFields(snapshot, undefined, task),
      title: "New child",
    };
    expect(taskEditorDraft(snapshot, fields, undefined, task)).toMatchObject({
      title: "New child",
      parentId: task.id,
      projectId: task.projectId,
      due: null,
    });
  });

  test("a title edit saves a narrow command against the opened task baseline", async () => {
    const h = harness();
    await saveTaskEditor(
      h.service,
      snapshot,
      { ...taskEditorFields(snapshot, task), title: "Edited" },
      task,
    );
    expect(h.mutate).toHaveBeenCalledWith(
      { kind: "update", taskId: task.id, changes: { title: "Edited" } },
      undefined,
      {
        id: expect.any(String),
        base: task,
        provider: "todoist",
        accountId: "account",
      },
    );
  });

  test("project placement and field edits remain separate ordered commands", async () => {
    const h = harness();
    await saveTaskEditor(
      h.service,
      snapshot,
      {
        ...taskEditorFields(snapshot, task),
        title: "Edited",
        projectId: "home",
      },
      task,
    );
    expect(h.mutate.mock.calls.map(([command]) => command.kind)).toEqual([
      "update",
      "moveProject",
    ]);
  });

  test("an account change refuses creation from an older open form", async () => {
    const h = harness();
    h.state.update((state) => ({
      ...state,
      snapshot: { ...snapshot, account: { ...snapshot.account, id: "other" } },
    }));
    await expect(
      saveTaskEditor(h.service, snapshot, {
        ...taskEditorFields(snapshot),
        title: "New task",
      }),
    ).rejects.toThrow("original account");
    expect(h.mutate).not.toHaveBeenCalled();
  });

  test("an unchanged task creates no outbox commands", async () => {
    const h = harness();
    expect(
      await saveTaskEditor(
        h.service,
        snapshot,
        taskEditorFields(snapshot, task),
        task,
      ),
    ).toBe(task.id);
    expect(h.mutate).not.toHaveBeenCalled();
  });
});
