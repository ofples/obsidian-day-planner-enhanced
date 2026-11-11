import { z } from "zod";

import { taskOperationSchema, type TaskOperation } from "./operations";
import { taskSchema, type TaskStorage } from "./types";

export const taskSourceSchema = z.object({
  path: z.string(),
  raw: z.string(),
  from: z.number().int().nonnegative(),
  title: z.string(),
});

export const taskLinkSchema = z.object({
  provider: z.string(),
  accountId: z.string(),
  taskId: z.string().nullable(),
  source: taskSourceSchema,
  base: taskSchema.nullable(),
});

const taskRegistrySchema = z.object({
  version: z.literal(1),
  namespace: z.string().regex(/^[a-f0-9]{32}$/),
  operations: z.array(taskOperationSchema),
  links: z.record(z.string(), taskLinkSchema),
});

export type TaskRegistryState = z.infer<typeof taskRegistrySchema>;
export type TaskLink = z.infer<typeof taskLinkSchema>;
export type TaskSource = z.infer<typeof taskSourceSchema>;

/** Serializes intent writes independently of the replaceable task snapshot cache. */
export class TaskRegistry {
  private state!: TaskRegistryState;
  private lastSaved: string | null = null;
  private tail: Promise<void> = Promise.resolve();

  constructor(
    private readonly storage: Pick<TaskStorage, "readState" | "writeState">,
    private readonly namespace: string,
  ) {}

  async initialize() {
    this.lastSaved = await this.storage.readState();
    this.state =
      this.lastSaved === null
        ? { version: 1, namespace: this.namespace, operations: [], links: {} }
        : taskRegistrySchema.parse(JSON.parse(this.lastSaved));
    if (this.state.namespace !== this.namespace)
      throw new Error(
        "Task registry belongs to another vault. Restore its matching cache.",
      );
    if (this.lastSaved === null) await this.change(() => {});
  }

  snapshot() {
    return structuredClone(this.state);
  }

  updateOperation(id: string, patch: Partial<TaskOperation>) {
    return this.change((state) => {
      const operation = state.operations.find((item) => item.id === id);
      if (!operation)
        throw new Error(
          "The saved task change is missing. Reopen the vault before syncing.",
        );
      Object.assign(operation, patch);
    });
  }

  change<T>(update: (state: TaskRegistryState) => T): Promise<T> {
    const operation = this.tail.then(async () => {
      if ((await this.storage.readState()) !== this.lastSaved)
        throw new Error(
          "Task state changed in another session. Reopen this vault before syncing.",
        );
      const state = this.snapshot();
      const result = update(state);
      const serialized = JSON.stringify(taskRegistrySchema.parse(state));
      await this.storage.writeState(serialized);
      this.lastSaved = serialized;
      this.state = state;
      return result;
    });
    this.tail = operation.then(
      () => {},
      () => {},
    );
    return operation;
  }
}
