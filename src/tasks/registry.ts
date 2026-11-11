import { z } from "zod";

import { taskOperationSchema, type TaskOperation } from "./operations";
import {
  scheduleOperationSchema,
  taskProjectionSchema,
} from "./schedule-types";
import { taskSourceSchema } from "./source";
import { taskSchema, type TaskStorage } from "./types";

export { taskSourceSchema, type TaskSource } from "./source";

export const taskLinkSchema = z.object({
  provider: z.string(),
  accountId: z.string(),
  taskId: z.string().nullable(),
  source: taskSourceSchema,
  base: taskSchema.nullable(),
});

const taskRegistrySchema = z.object({
  version: z.literal(4),
  namespace: z.string().regex(/^[a-f0-9]{32}$/),
  operations: z.array(taskOperationSchema),
  links: z.record(z.string(), taskLinkSchema),
  schedules: z.array(scheduleOperationSchema),
  projections: z.record(z.string(), taskProjectionSchema),
});

const legacyRegistrySchema = taskRegistrySchema.extend({
  version: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  schedules: z.array(scheduleOperationSchema).default([]),
  projections: z.record(z.string(), taskProjectionSchema).default({}),
});

export type TaskRegistryState = z.infer<typeof taskRegistrySchema>;
export type TaskLink = z.infer<typeof taskLinkSchema>;

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
        ? {
            version: 4,
            namespace: this.namespace,
            operations: [],
            links: {},
            schedules: [],
            projections: {},
          }
        : taskRegistrySchema.parse(
            legacy.success ? { ...legacy.data, version: 4 } : stored,
          );
    if (this.state.namespace !== this.namespace)
      throw new Error(
        "Task registry belongs to another vault. Restore its matching cache.",
      );
    if (legacy.success && this.lastSaved !== null)
      await this.storage.backupState?.(this.lastSaved, legacy.data.version);
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
