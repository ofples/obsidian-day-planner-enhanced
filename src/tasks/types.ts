import { z } from "zod";

import type { TaskOperation } from "./operations";

export const taskDurationSchema = z.object({
  amount: z.number().int().positive(),
  unit: z.enum(["minute", "day"]),
});

export const taskSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  description: z.string(),
  projectId: z.string(),
  parentId: z.string().nullable(),
  labels: z.array(z.string()),
  priority: z.number().int().min(1).max(4),
  completed: z.boolean(),
  completionCount: z.number().int().nonnegative().optional(),
  order: z.number(),
  createdAt: z.string().optional(),
  duration: taskDurationSchema.nullable().optional(),
  due: z
    .object({
      date: z.string(),
      recurring: z.boolean(),
      text: z.string(),
      timezone: z.string().nullable(),
    })
    .nullable(),
});

export const taskSnapshotSchema = z.object({
  provider: z.string().min(1),
  account: z.object({
    id: z.string().min(1),
    name: z.string(),
    timezone: z.string(),
    preferences: z.object({ resetRecurringSubtasks: z.boolean() }).optional(),
    capabilities: z
      .object({
        duration: z.boolean().optional(),
        delete: z.boolean().optional(),
        recurringUndo: z.boolean().optional(),
      })
      .optional(),
  }),
  projects: z.array(
    z.object({
      id: z.string().min(1),
      name: z.string(),
      order: z.number(),
      inbox: z.boolean().optional(),
    }),
  ),
  tasks: z.array(taskSchema),
  fetchedAt: z.iso.datetime(),
});

export const taskCacheSchema = z.object({
  version: z.literal(1),
  namespace: z.string().regex(/^[a-f0-9]{32}$/),
  snapshot: taskSnapshotSchema.nullable(),
});

export type ProviderTask = z.infer<typeof taskSchema>;
export type TaskSnapshot = z.infer<typeof taskSnapshotSchema>;
export type TaskCache = z.infer<typeof taskCacheSchema>;

export interface TaskProvider {
  readonly capabilities?: { recurringUndo?: boolean };
  read(): Promise<TaskSnapshot>;
  get?(id: string): Promise<ProviderTask | null>;
  apply?(operation: TaskOperation): Promise<{ taskId: string }>;
}

export interface TaskStorage {
  read(): Promise<string | null>;
  write(content: string): Promise<void>;
  readState(): Promise<string | null>;
  writeState(content: string): Promise<void>;
  backupState?(content: string, version: number): Promise<void>;
  readStateCheckpoint?(): Promise<string | null>;
  writeStateCheckpoint?(content: string): Promise<void>;
  getSecret(key: string): string | null;
  setSecret(key: string, value: string): void;
}

export class TaskReadError extends Error {
  constructor(
    message: string,
    readonly retryAt?: number,
    readonly needsReconnect = false,
    readonly status?: number,
  ) {
    super(message);
  }
}

export class TaskWriteError extends TaskReadError {
  constructor(
    message: string,
    readonly permanent: boolean,
  ) {
    super(message);
  }
}
