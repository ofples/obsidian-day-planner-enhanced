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
  version: z.literal(2),
  namespace: z.string().regex(/^[a-f0-9]{32}$/),
  operations: z.array(taskOperationSchema),
  links: z.record(z.string(), taskLinkSchema),
});

const legacyRegistrySchema = taskRegistrySchema.extend({
  version: z.literal(1),
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
    private readonly storage: Pick<
      TaskStorage,
      "readState" | "writeState" | "backupState"
    >,
    private readonly namespace: string,
  ) {}

  async initialize() {
    this.lastSaved = await this.storage.readState();
    const stored: unknown =
      this.lastSaved === null ? null : JSON.parse(this.lastSaved);
    const legacy = legacyRegistrySchema.safeParse(stored);
    this.state =
      this.lastSaved === null
        ? { version: 2, namespace: this.namespace, operations: [], links: {} }
        : taskRegistrySchema.parse(
            legacy.success ? { ...legacy.data, version: 2 } : stored,
          );
    if (this.state.namespace !== this.namespace)
      throw new Error(
        "Task registry belongs to another vault. Restore its matching cache.",
      );
    if (legacy.success && this.lastSaved !== null)
      await this.storage.backupState?.(this.lastSaved, 1);
    if (this.lastSaved === null || legacy.success) await this.change(() => {});
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
      const validated = taskRegistrySchema.parse(state);
      const serialized = JSON.stringify(validated);
      await this.storage.writeState(serialized);
      this.lastSaved = serialized;
      this.state = validated;
      return result;
    });
    this.tail = operation.then(
      () => {},
      () => {},
    );
    return operation;
  }
}
