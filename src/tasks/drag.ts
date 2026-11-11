import { get, writable } from "svelte/store";
import { z } from "zod";

import type { TaskService } from "./service";
import { TaskReadError, type ProviderTask } from "./types";

export const taskDragMime = "application/x-day-planner-task+json";
const payloadSchema = z.object({
  version: z.literal(1),
  namespace: z.string(),
  nonce: z.uuid(),
});

export class TaskDrag {
  readonly state = writable<ProviderTask | null>(null);
  private active?: {
    nonce: string;
    taskId: string;
    provider: string;
    accountId: string;
    expires: number;
  };
  constructor(private readonly service: TaskService) {}

  start(task: ProviderTask, transfer: DataTransfer) {
    const browser = get(this.service.state);
    if (
      !browser.writable ||
      !browser.snapshot ||
      task.completed ||
      task.id.startsWith("local-")
    )
      throw new TaskReadError(
        "Wait for this task to finish syncing before dragging it.",
      );
    this.active = {
      nonce: crypto.randomUUID(),
      taskId: task.id,
      provider: browser.snapshot.provider,
      accountId: browser.snapshot.account.id,
      expires: Date.now() + 120_000,
    };
    transfer.setData(
      taskDragMime,
      JSON.stringify({
        version: 1,
        namespace: this.service.registry.snapshot().namespace,
        nonce: this.active.nonce,
      }),
    );
    transfer.setData("text/plain", task.title);
    transfer.effectAllowed = "copyMove";
    this.state.set(task);
  }

  current() {
    const snapshot = get(this.service.state).snapshot,
      active = this.active;
    if (
      !active ||
      active.expires < Date.now() ||
      !get(this.service.state).writable ||
      snapshot?.provider !== active.provider ||
      snapshot.account.id !== active.accountId
    )
      return null;
    return (
      snapshot.tasks.find(
        (task) => task.id === active.taskId && !task.completed,
      ) ?? null
    );
  }

  accept(transfer: DataTransfer) {
    let value: unknown;
    try {
      value = JSON.parse(transfer.getData(taskDragMime));
    } catch {
      throw new TaskReadError(
        "This task drag expired. Drag the task from the pane again.",
      );
    }
    const payload = payloadSchema.safeParse(value),
      task = this.current();
    if (
      !payload.success ||
      payload.data.namespace !== this.service.registry.snapshot().namespace ||
      payload.data.nonce !== this.active?.nonce ||
      !task
    )
      throw new TaskReadError(
        "This task drag belongs to another vault, account or session. Start a fresh drag.",
      );
    return { task, id: payload.data.nonce };
  }

  cancel() {
    this.active = undefined;
    this.state.set(null);
  }
}
