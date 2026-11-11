import { requestUrl } from "obsidian";
import { z } from "zod";

import { TaskReadError, type TaskProvider, type TaskSnapshot } from "./types";

const resourceId = z
  .string()
  .min(1)
  .refine((id) => !id.startsWith("tmp-"));
const userSchema = z.object({
  id: resourceId,
  full_name: z.string(),
  tz_info: z.object({ timezone: z.string() }),
});
const projectSchema = z.object({
  id: resourceId,
  name: z.string(),
  child_order: z.number(),
});
const remoteTaskSchema = z.object({
  id: resourceId,
  project_id: resourceId,
  parent_id: resourceId.nullable(),
  content: z.string(),
  description: z.string(),
  labels: z.array(z.string()),
  priority: z.number().int().min(1).max(4),
  checked: z.boolean(),
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
  constructor(private readonly token: string) {}

  private async request(path: string): Promise<unknown> {
    const response = await requestUrl({
      url: `https://api.todoist.com/api/v1/${path}`,
      method: "GET",
      headers: { Authorization: `Bearer ${this.token}` },
      throw: false,
    });
    if (response.status !== 200) {
      const retry = response.headers["retry-after"];
      const seconds = Number(retry);
      const retryAt = retry
        ? Number.isFinite(seconds)
          ? Date.now() + seconds * 1000
          : Date.parse(retry)
        : undefined;
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
      );
    }
    return response.json as unknown;
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
    const [projects, tasks] = await Promise.all([
      this.pages("projects", projectSchema),
      this.pages("tasks", remoteTaskSchema),
    ]);
    // User responses may include a token. Select only these explicit account fields.
    return {
      provider: "todoist",
      account: {
        id: user.id,
        name: user.full_name,
        timezone: user.tz_info.timezone,
      },
      projects: projects.map((project) => ({
        id: project.id,
        name: project.name,
        order: project.child_order,
      })),
      tasks: tasks.map((task) => ({
        id: task.id,
        title: task.content,
        description: task.description,
        projectId: task.project_id,
        parentId: task.parent_id,
        labels: task.labels,
        priority: task.priority,
        completed: task.checked,
        order: task.child_order,
        due: task.due
          ? {
              date: task.due.date,
              recurring: task.due.is_recurring,
              text: task.due.string,
              timezone: task.due.timezone ?? null,
            }
          : null,
      })),
      fetchedAt: new Date().toISOString(),
    };
  }
}
