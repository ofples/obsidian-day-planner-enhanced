import { DateTime } from "luxon";
import { get } from "svelte/store";

import { taskDay } from "./browser";
import {
  operationTaskId,
  sameTaskField,
  taskDraftSchema,
  type TaskMutation,
  type TaskPatch,
} from "./operations";
import type { TaskService } from "./service";
import { TaskReadError, type ProviderTask, type TaskSnapshot } from "./types";

export interface TaskEditorFields {
  title: string;
  description: string;
  projectId: string;
  priority: number;
  labels: string;
  date: string;
}

export function taskEditorFields(
  snapshot: TaskSnapshot,
  task?: ProviderTask,
  parent?: ProviderTask,
): TaskEditorFields {
  return {
    title: task?.title ?? "",
    description: task?.description ?? "",
    projectId:
      task?.projectId ??
      parent?.projectId ??
      snapshot.projects.find((project) => project.inbox)?.id ??
      snapshot.projects[0]?.id ??
      "",
    priority: task?.priority ?? 1,
    labels: task?.labels.join(", ") ?? "",
    date: task ? (taskDay(task, snapshot.account.timezone) ?? "") : "",
  };
}

export function taskEditorDraft(
  snapshot: TaskSnapshot,
  fields: TaskEditorFields,
  task?: ProviderTask,
  parent?: ProviderTask,
) {
  let due = task?.due ?? null;
  const initialDate = task
    ? (taskDay(task, snapshot.account.timezone) ?? "")
    : "";
  if (fields.date !== initialDate) {
    const day = DateTime.fromISO(fields.date, {
      zone: snapshot.account.timezone,
    });
    if (fields.date && !day.isValid)
      throw new TaskReadError("Choose a valid task date.");
    const instant =
      fields.date && task?.due?.date.includes("T")
        ? DateTime.fromISO(task.due.date, {
            zone: task.due.timezone ?? snapshot.account.timezone,
          })
            .setZone(snapshot.account.timezone)
            .set({ year: day.year, month: day.month, day: day.day })
            .toISO()
        : null;
    due = fields.date
      ? {
          date: instant ?? fields.date,
          recurring: task?.due?.recurring ?? false,
          text: task?.due?.recurring ? task.due.text : (instant ?? fields.date),
          timezone: task?.due?.timezone ?? null,
        }
      : null;
  }
  return taskDraftSchema.parse({
    ...fields,
    labels: [
      ...new Set(
        fields.labels
          .split(",")
          .map((label) => label.trim())
          .filter(Boolean),
      ),
    ],
    parentId: task?.parentId ?? parent?.id ?? null,
    due,
  });
}

/** Task edits use narrow commands and the opened field baseline. */
export async function saveTaskEditor(
  service: TaskService,
  snapshot: TaskSnapshot,
  fields: TaskEditorFields,
  task?: ProviderTask,
  parent?: ProviderTask,
) {
  const draft = taskEditorDraft(snapshot, fields, task, parent);
  const commands: TaskMutation[] = [];
  if (task) {
    const changes: TaskPatch = {};
    for (const field of [
      "title",
      "description",
      "priority",
      "labels",
      "due",
    ] as const)
      if (!sameTaskField(task[field], draft[field], field))
        Object.assign(changes, { [field]: draft[field] });
    if (Object.keys(changes).length)
      commands.push({ kind: "update", taskId: task.id, changes });
    if (draft.projectId !== task.projectId)
      commands.push({
        kind: "moveProject",
        taskId: task.id,
        projectId: draft.projectId,
      });
  } else commands.push({ kind: "create", task: draft });
  let selectedId = task?.id;
  for (const command of commands) {
    const current = get(service.state).snapshot;
    if (
      current?.provider !== snapshot.provider ||
      current.account.id !== snapshot.account.id
    )
      throw new TaskReadError(
        "Reopen the task editor under its original account before saving.",
      );
    const operation = await service.mutate(
      command,
      undefined,
      task
        ? {
            id: crypto.randomUUID(),
            base: task,
            provider: snapshot.provider,
            accountId: snapshot.account.id,
          }
        : undefined,
    );
    selectedId = operationTaskId(operation);
  }
  return selectedId;
}
