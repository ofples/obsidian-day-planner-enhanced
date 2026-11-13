import { requestUrl } from "obsidian";
import { z } from "zod";

import {
  RequestCooldownError,
  RequestCancelledError,
  todoistRequestGate,
} from "../service/request-gate";

import type { TaskDraft, TaskOperation, TaskPatch } from "./operations";
import {
  TaskReadError,
  TaskWriteError,
  taskDurationSchema,
  type ProviderTask,
  type TaskProvider,
  type TaskSnapshot,
} from "./types";

const resourceId = z
  .string()
  .min(1)
  .refine((id) => !id.startsWith("tmp-"));
const userSchema = z.object({
  id: resourceId,
  full_name: z.string(),
  tz_info: z.object({ timezone: z.string() }),
  is_premium: z.boolean().optional(),
});

function normalizeTask(task: z.infer<typeof remoteTaskSchema>): ProviderTask {
  return {
    id: task.id,
    title: task.content,
    description: task.description,
    projectId: task.project_id,
    parentId: task.parent_id,
    labels: task.labels,
    priority: task.priority,
    completed: task.checked,
    ...(task.completed_count !== undefined
      ? { completionCount: task.completed_count }
      : {}),
    order: task.child_order,
    ...(task.duration !== undefined ? { duration: task.duration } : {}),
    due: task.due
      ? {
          date: task.due.date,
          recurring: task.due.is_recurring,
          text: task.due.string,
          timezone: task.due.timezone ?? null,
        }
      : null,
  };
}

function writableFields(task: TaskPatch | TaskDraft) {
  const fields: Record<string, unknown> = {};
  if (task.title !== undefined) fields["content"] = task.title;
  if (task.description !== undefined) fields["description"] = task.description;
  if (task.priority !== undefined) fields["priority"] = task.priority;
  if (task.labels !== undefined) fields["labels"] = task.labels;
  if (task.duration !== undefined) fields["duration"] = task.duration;
  if (task.due !== undefined)
    fields["due"] = task.due
      ? {
          date: task.due.date,
          string: task.due.text,
          is_recurring: task.due.recurring,
          timezone: task.due.timezone,
        }
      : null;
  return fields;
}
const projectSchema = z.object({
  id: resourceId,
  name: z.string(),
  child_order: z.number(),
  inbox_project: z.boolean().optional(),
});
const remoteTaskSchema = z.object({
  duration: taskDurationSchema.nullable().optional(),
  id: resourceId,
  project_id: resourceId,
  parent_id: resourceId.nullable(),
  content: z.string(),
  description: z.string(),
  labels: z.array(z.string()),
  priority: z.number().int().min(1).max(4),
  checked: z.boolean(),
  completed_count: z.number().int().nonnegative().optional(),
  child_order: z.number(),
  due: z
    .object({
      date: z.string(),
      is_recurring: z.boolean(),
      string: z.string(),
      timezone: z.string().nullable().optional(),
    })
    .nullable(),
});

/** Read a complete account snapshot before publishing any of it. */
export class TodoistProvider implements TaskProvider {
  readonly capabilities = { recurringUndo: true };
  constructor(
    private readonly token: string,
    private readonly canStart: () => boolean = () => true,
    private readonly accessToken: () => Promise<string> = () =>
      Promise.resolve(token),
  ) {}

  private async request(
    path: string,
    body?: URLSearchParams,
  ): Promise<unknown> {
    let result;
    try {
      result = await todoistRequestGate(this.token).run(
        async () => {
          const token = await this.accessToken();
          if (!this.canStart()) throw new RequestCancelledError();
          return requestUrl({
            url: `https://api.todoist.com/api/v1/${path}`,
            method: body ? "POST" : "GET",
            headers: { Authorization: `Bearer ${token}` },
            ...(body
              ? {
                  body: body.toString(),
                  contentType: "application/x-www-form-urlencoded",
                }
              : {}),
            throw: false,
          });
        },
        undefined,
        this.canStart,
        `${body ? "POST" : "GET"} ${path.split("?")[0]}${body?.has("commands") ? " commands" : ""}`,
        (response) => response.status === 401 || response.status === 403,
      );
    } catch (error) {
      if (error instanceof RequestCooldownError)
        throw new TaskReadError(
          error.permanent
            ? "Reconnect Todoist or check this connection's permissions."
            : error.circuitOpen
              ? "Todoist sync is paused after repeated failures. Use Retry sync when ready."
              : "Todoist is busy. Try refreshing after a short wait.",
          error.retryAt,
          error.permanent,
          error.status,
        );
      throw error;
    }
    const { response, retryAt } = result;
    if (response.status !== 200) {
      throw new TaskReadError(
        response.status === 401
          ? "Reconnect Todoist to refresh your tasks."
          : response.status === 403
            ? "Todoist denied access. Check this connection's permissions."
            : response.status === 429
              ? "Todoist is busy. Try refreshing after a short wait."
              : "Could not refresh Todoist. Your last task snapshot is available.",
        retryAt,
        response.status === 401 || response.status === 403,
        response.status,
      );
    }
    return response.json as unknown;
  }

  async get(id: string): Promise<ProviderTask | null> {
    try {
      return normalizeTask(
        remoteTaskSchema.parse(
          await this.request(`tasks/${encodeURIComponent(id)}`),
        ),
      );
    } catch (error) {
      if (
        error instanceof TaskReadError &&
        (error.status === 404 || error.status === 410)
      )
        return null;
      throw error;
    }
  }

  async apply(operation: TaskOperation): Promise<{ taskId: string }> {
    const mutation = operation.mutation;
    const command = {
      uuid: operation.id,
      type: "",
      args: {} as Record<string, unknown>,
      ...(mutation.kind === "create" ? { temp_id: operation.tempId } : {}),
    };
    switch (mutation.kind) {
      case "create":
        command.type = "item_add";
        command.args = {
          ...writableFields(mutation.task),
          project_id: mutation.task.projectId,
          ...(mutation.task.parentId
            ? { parent_id: mutation.task.parentId }
            : {}),
        };
        break;
      case "update":
        command.type = "item_update";
        command.args = {
          id: mutation.taskId,
          ...writableFields(mutation.changes),
        };
        break;
      case "moveProject":
        command.type = "item_move";
        command.args = { id: mutation.taskId, project_id: mutation.projectId };
        break;
      case "moveParent":
        command.type = "item_move";
        command.args = { id: mutation.taskId, parent_id: mutation.parentId };
        break;
      case "complete":
        command.type = operation.recurringCompletion
          ? "item_update_date_complete"
          : "item_close";
        command.args = {
          id: mutation.taskId,
          ...(operation.recurringCompletion
            ? {
                is_forward: 1,
                reset_subtasks: Number(
                  operation.recurringCompletion.resetSubtasks,
                ),
              }
            : {}),
        };
        break;
      case "reopen":
        command.type = operation.recurringUndo
          ? "item_update_date_complete"
          : "item_uncomplete";
        command.args = {
          id: mutation.taskId,
          ...(operation.recurringUndo
            ? {
                ...writableFields({ due: operation.recurringUndo.due }),
                is_forward: 0,
                reset_subtasks: 0,
              }
            : {}),
        };
        break;
      case "delete":
        command.type = "item_delete";
        command.args = { id: mutation.taskId };
        break;
    }
    const response = z
      .object({
        sync_status: z.record(
          z.string(),
          z.union([
            z.literal("ok"),
            z.object({ error_code: z.number(), error: z.string() }),
          ]),
        ),
        temp_id_mapping: z.record(z.string(), z.string()).optional(),
      })
      .parse(
        await this.request(
          "sync",
          new URLSearchParams({
            commands: JSON.stringify([command]),
            resource_types: "[]",
          }),
        ),
      );
    const status = response.sync_status[operation.id];
    if (status !== "ok")
      throw new TaskWriteError(
        status
          ? `Todoist rejected this change (code ${status.error_code}). Review the task fields and project permissions.`
          : "Todoist did not acknowledge this change. Retry to check its result.",
        Boolean(status),
      );
    const taskId =
      mutation.kind === "create"
        ? response.temp_id_mapping?.[operation.tempId]
        : mutation.taskId;
    if (!taskId)
      throw new TaskWriteError(
        "Todoist did not return the created task's identity. Retry the saved change.",
        false,
      );
    return { taskId: resourceId.parse(taskId) };
  }

  private async pages<T extends { id: string }>(
    path: string,
    schema: z.ZodType<T>,
  ): Promise<T[]> {
    const values: T[] = [];
    const seen = new Set<string>();
    let cursor: string | null = null;
    do {
      const params = new URLSearchParams({ limit: "200" });
      if (cursor) params.set("cursor", cursor);
      const page = z
        .object({
          results: z.array(schema),
          next_cursor: z.string().nullable(),
        })
        .parse(await this.request(`${path}?${params.toString()}`));
      values.push(...page.results);
      cursor = page.next_cursor;
      if (cursor && seen.has(cursor))
        throw new Error("Todoist returned a repeated page. Refresh again.");
      if (cursor) seen.add(cursor);
    } while (cursor);
    if (new Set(values.map((value) => value.id)).size !== values.length)
      throw new Error("Todoist returned duplicate resources. Refresh again.");
    return values;
  }

  async read(): Promise<TaskSnapshot> {
    const user = userSchema.parse(await this.request("user"));
    const [projects, tasks, settings] = await Promise.all([
      this.pages("projects", projectSchema),
      this.pages("tasks", remoteTaskSchema),
      this.request(
        "sync",
        new URLSearchParams({
          sync_token: "*",
          resource_types: '["user_settings"]',
        }),
      ).then(
        (value) =>
          z
            .object({
              user_settings: z.object({
                reset_recurring_subtasks: z.boolean(),
              }),
            })
            .parse(value).user_settings,
      ),
    ]);
    // User responses may include a token. Select only these explicit account fields.
    return {
      provider: "todoist",
      account: {
        id: user.id,
        name: user.full_name,
        timezone: user.tz_info.timezone,
        preferences: {
          resetRecurringSubtasks: settings.reset_recurring_subtasks,
        },
        capabilities: {
          delete: true,
          recurringUndo: this.capabilities.recurringUndo,
          ...(user.is_premium !== undefined
            ? { duration: user.is_premium }
            : {}),
        },
      },
      projects: projects.map((project) => ({
        id: project.id,
        name: project.name,
        order: project.child_order,
        inbox: project.inbox_project ?? false,
      })),
      tasks: tasks.map(normalizeTask),
      fetchedAt: new Date().toISOString(),
    };
  }
}
