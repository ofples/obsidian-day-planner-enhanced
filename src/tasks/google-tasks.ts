import { z } from "zod";

import { SourceActionRejectedError } from "./source-errors";
import type { SourceRequest } from "./source-http";
import {
  SourcePageBudget,
  readSourcePages,
  type SourcePageState,
} from "./source-pages";
import { googleTaskId } from "./source-references";
import type { SourceReadResult } from "./source-session";
import { TaskReadError, type ProviderTask, type TaskSnapshot } from "./types";

const listSchema = z.object({ id: z.string().min(1), title: z.string() });
const remoteTaskSchema = z.object({
  id: z.string().min(1),
  title: z.string().default(""),
  notes: z.string().optional(),
  parent: z.string().optional(),
  position: z.string().default(""),
  status: z.enum(["needsAction", "completed"]).default("needsAction"),
  due: z.string().optional(),
  updated: z.string().optional(),
  deleted: z.boolean().optional(),
  hidden: z.boolean().optional(),
  webViewLink: z.string().optional(),
});
type RemoteTask = z.infer<typeof remoteTaskSchema>;
const pageSchema = <T extends z.ZodType>(item: T) =>
  z.object({
    items: z.array(item).default([]),
    nextPageToken: z.string().optional(),
  });

export interface GoogleTasksSelection {
  /** null chooses the first list on a new connection; [] explicitly chooses none. */
  listIds: string[] | null;
  showAssigned: boolean;
  allowCompletion: boolean;
}

function normalizeTask(
  listId: string,
  task: RemoteTask,
  order: number,
): ProviderTask {
  const date = task.due?.slice(0, 10);
  return {
    id: googleTaskId(listId, task.id),
    title: task.title,
    description: task.notes ?? "",
    projectId: listId,
    parentId: task.parent ? googleTaskId(listId, task.parent) : null,
    labels: [],
    priority: 1,
    completed:
      task.status === "completed" || Boolean(task.deleted || task.hidden),
    order,
    due:
      date && z.iso.date().safeParse(date).success
        ? { date, recurring: false, text: date, timezone: null }
        : null,
    source: {
      kind: "task",
      nativeId: task.id,
      nativeContainerId: listId,
      dateMeaning: "scheduled",
      orderKey: task.position,
      ...(task.webViewLink ? { url: task.webViewLink } : {}),
      ...(task.updated ? { updatedAt: task.updated } : {}),
    },
  };
}

/** Google exposes a date and sibling position, not a scheduled time or priority. */
export class GoogleTasksProvider {
  constructor(
    private readonly request: SourceRequest,
    private readonly account: TaskSnapshot["account"],
    private readonly selection: () => GoogleTasksSelection,
  ) {}

  async read(previous?: SourceReadResult): Promise<SourceReadResult> {
    if (
      previous &&
      (previous.snapshot.provider !== "google-tasks" ||
        previous.snapshot.account.id !== this.account.id)
    )
      throw new TaskReadError(
        "Refresh the current Google Tasks account first.",
      );
    const budget = new SourcePageBudget();
    const states = new Map(
      previous?.coverage.streams.map((state) => [state.id, state]),
    );
    const lists = await readSourcePages(
      "lists",
      budget,
      async (limit, cursor) => {
        const query = new URLSearchParams({
          maxResults: String(limit),
          ...(cursor ? { pageToken: cursor } : {}),
        });
        const page = pageSchema(listSchema).parse(
          await this.request(`/tasks/v1/users/@me/lists?${query}`),
        );
        return { items: page.items, next: page.nextPageToken };
      },
      states.get("lists"),
    );
    const projects = new Map(
      previous?.snapshot.projects.map((item) => [item.id, item]),
    );
    for (const list of lists.items)
      projects.set(list.id, {
        id: list.id,
        name: list.title,
        order: projects.get(list.id)?.order ?? projects.size,
        source: { kind: "list", nativeId: list.id },
      });
    const selection = this.selection();
    const selected = selection.listIds ?? [...projects.keys()].slice(0, 1);
    const tasks = new Map(
      previous?.snapshot.tasks
        .filter((task) => selected.includes(task.projectId))
        .map((item) => [item.id, item]),
    );
    const streams: SourcePageState[] = [lists.state];
    for (const id of selected) {
      const streamId = `list:${id}`;
      if (!projects.has(id)) {
        streams.push({
          id: streamId,
          containerId: id,
          complete: false,
          error: "This selected list is unavailable. Check the list selection.",
        });
        continue;
      }
      try {
        const page = await readSourcePages(
          streamId,
          budget,
          async (limit, cursor) => {
            const query = new URLSearchParams({
              maxResults: String(limit),
              showCompleted: "false",
              showHidden: "false",
              showDeleted: "false",
              showAssigned: String(selection.showAssigned),
              ...(cursor ? { pageToken: cursor } : {}),
            });
            const result = pageSchema(remoteTaskSchema).parse(
              await this.request(
                `/tasks/v1/lists/${encodeURIComponent(id)}/tasks?${query}`,
              ),
            );
            return { items: result.items, next: result.nextPageToken };
          },
          states.get(streamId),
        );
        // Pages follow Google sibling positions. Normalize after merging to keep order stable.
        for (const remote of page.items) {
          const normalized = normalizeTask(id, remote, 0);
          tasks.set(normalized.id, normalized);
        }
        const merged = [...tasks.values()]
          .filter((item) => item.projectId === id)
          .toSorted((a, b) => {
            const left = a.source?.orderKey ?? "";
            const right = b.source?.orderKey ?? "";
            return left < right
              ? -1
              : left > right
                ? 1
                : a.id.localeCompare(b.id);
          });
        for (const [index, item] of merged.entries())
          tasks.set(item.id, { ...item, order: index });
        streams.push({ ...page.state, containerId: id });
      } catch (error) {
        if (
          !(error instanceof TaskReadError) ||
          error.needsReconnect ||
          error.retryAt
        )
          throw error;
        streams.push({
          id: streamId,
          containerId: id,
          complete: false,
          error: error.message,
        });
      }
    }
    return {
      snapshot: {
        provider: "google-tasks",
        account: {
          ...this.account,
          capabilities: { complete: selection.allowCompletion },
        },
        projects: [...projects.values()],
        tasks: [...tasks.values()],
        fetchedAt: new Date().toISOString(),
      },
      coverage: { complete: streams.every((state) => state.complete), streams },
    };
  }

  private path(task: ProviderTask) {
    const source = task.source;
    if (
      source?.kind !== "task" ||
      !source.nativeContainerId ||
      task.id !== googleTaskId(source.nativeContainerId, source.nativeId)
    )
      throw new TaskReadError(
        "This Google task reference is unavailable. Refresh its list.",
      );
    return `/tasks/v1/lists/${encodeURIComponent(source.nativeContainerId)}/tasks/${encodeURIComponent(source.nativeId)}`;
  }

  async get(task: ProviderTask) {
    try {
      const remote = remoteTaskSchema.parse(
        await this.request(this.path(task)),
      );
      const normalized = normalizeTask(
        task.source!.nativeContainerId!,
        remote,
        task.order,
      );
      if (normalized.id !== task.id)
        throw new TaskReadError(
          "Google returned a different task. Refresh its list.",
        );
      return normalized;
    } catch (error) {
      if (
        error instanceof TaskReadError &&
        (error.status === 404 || error.status === 410)
      )
        return null;
      throw error;
    }
  }

  async complete(task: ProviderTask): Promise<ProviderTask> {
    if (!this.selection().allowCompletion)
      throw new SourceActionRejectedError(
        "Enable Google Tasks completion and grant editing access first.",
      );
    let current: ProviderTask | null;
    try {
      current = await this.get(task);
    } catch (error) {
      throw new SourceActionRejectedError(
        error instanceof Error
          ? error.message
          : "Google could not read this task before completion.",
        error instanceof TaskReadError ? error.retryAt : undefined,
        error instanceof TaskReadError ? error.needsReconnect : false,
        error instanceof TaskReadError ? error.status : undefined,
      );
    }
    if (!current)
      throw new SourceActionRejectedError(
        "This Google task is no longer available.",
      );
    if (current.completed) return current;
    if (
      current.source?.updatedAt !== task.source?.updatedAt ||
      current.due?.date !== task.due?.date
    )
      throw new SourceActionRejectedError(
        "This Google task changed. Refresh its list before completing it.",
      );
    const result = remoteTaskSchema.parse(
      await this.request(this.path(current), {
        method: "PATCH",
        body: { status: "completed" },
      }),
    );
    const normalized = normalizeTask(
      current.source!.nativeContainerId!,
      result,
      current.order,
    );
    if (normalized.id !== current.id)
      throw new TaskReadError(
        "Google returned a different task. Verify this completion before retrying.",
      );
    return normalized;
  }
}
