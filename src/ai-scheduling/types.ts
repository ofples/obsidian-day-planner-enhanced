import { z } from "zod";

import type { LocalIdentity } from "../google-calendar/types";
import type { DayPlannerSettings } from "../settings";

const reference = z.string().min(1).max(200);
const timestamp = z.iso.datetime({ offset: true });
const date = z.iso.date();

export const planningPreferencesSchema = z.object({
  startHour: z.number().int().min(0).max(23).default(6),
  endHour: z.number().int().min(1).max(24).default(22),
  defaultDurationMinutes: z.number().int().min(1).max(1440).default(30),
  instructions: z.string().max(20_000).default(""),
});

export const planningTaskSchema = z.object({
  ref: reference,
  kind: z.enum(["note", "todoist"]),
  title: z.string(),
  raw: z.string().min(1),
  path: z.string().optional(),
  from: z.number().int().nonnegative().optional(),
  provider: z.string().optional(),
  accountId: z.string().optional(),
  taskId: z.string().optional(),
  taskIds: z.array(z.string()).max(1000).optional(),
  completed: z.boolean().optional(),
  available: z.boolean().optional(),
  locked: z.boolean().optional(),
  priority: z.number().int().min(1).max(4).optional(),
  due: z.string().nullable().optional(),
  durationMinutes: z.number().int().positive().optional(),
  project: z.string().optional(),
  labels: z.array(z.string()).optional(),
  fingerprint: z.string().optional(),
});

export const planningBlockSchema = z.object({
  ref: reference,
  uid: z.string().regex(/^[a-f0-9]{32}$/),
  path: z.string().min(1),
  from: z.number().int().nonnegative(),
  raw: z.string().min(1),
  title: z.string(),
  start: timestamp,
  end: timestamp,
});

export const planningCommitmentSchema = z.object({
  ref: reference,
  title: z.string(),
  start: timestamp,
  end: timestamp,
  allDay: z.boolean().default(false),
});

export const planningContextSchema = z.object({
  version: z.literal(1),
  id: reference,
  createdAt: timestamp,
  timezone: z.string().min(1),
  startDate: date,
  dayCount: z.number().int().min(1).max(7),
  request: z.string().max(20_000).default(""),
  preferences: planningPreferencesSchema,
  documents: z.record(
    z.string(),
    z.object({ date: date.nullable(), text: z.string().nullable() }),
  ),
  tasks: z.array(planningTaskSchema).max(1000),
  blocks: z.array(planningBlockSchema).max(2000),
  commitments: z.array(planningCommitmentSchema).max(2000),
  freshness: z
    .object({
      tasksUpdatedAt: z.string().nullable().optional(),
      calendarsUpdatedAt: z.string().nullable().optional(),
      taskCount: z.number().int().nonnegative().optional(),
      truncated: z.boolean().optional(),
    })
    .default({}),
});

const actionFields = {
  id: reference,
  sourceRef: reference,
  reason: z.string().max(2000).default(""),
};

export const planningActionSchema = z.discriminatedUnion("kind", [
  z
    .object({
      ...actionFields,
      kind: z.literal("schedule"),
      start: timestamp,
      end: timestamp,
    })
    .strict(),
  z
    .object({
      ...actionFields,
      kind: z.literal("move"),
      start: timestamp,
      end: timestamp,
    })
    .strict(),
  z
    .object({
      ...actionFields,
      kind: z.literal("add-to-frame"),
      frameRef: reference,
    })
    .strict(),
]);

export const planningBucketSchema = z
  .object({
    id: reference,
    title: z.string().min(1).max(200),
    taskRefs: z.array(reference).max(1000),
  })
  .strict();

export const planningProposalSchema = z
  .object({
    version: z.literal(1),
    contextId: reference,
    summary: z.string().max(10_000).default(""),
    actions: z.array(planningActionSchema).max(50),
    buckets: z.array(planningBucketSchema).max(20).default([]),
    unplaced: z
      .array(z.object({ sourceRef: reference, reason: z.string().max(2000) }))
      .max(1000)
      .default([]),
  })
  .strict();

export type PlanningPreferences = z.infer<typeof planningPreferencesSchema>;
export type PlanningTask = z.infer<typeof planningTaskSchema>;
export type PlanningBlock = z.infer<typeof planningBlockSchema>;
export type PlanningCommitment = z.infer<typeof planningCommitmentSchema>;
export type PlanningContext = z.infer<typeof planningContextSchema>;
export type PlanningAction = z.infer<typeof planningActionSchema>;
export type PlanningBucket = z.infer<typeof planningBucketSchema>;
export type PlanningProposal = z.infer<typeof planningProposalSchema>;

export interface PlanningIssue {
  actionId?: string;
  code:
    | "context"
    | "source"
    | "locked"
    | "labels"
    | "interval"
    | "overlap"
    | "stale"
    | "duplicate";
  message: string;
}

export interface PlanningBatchOptions {
  settings: DayPlannerSettings;
  currentDocuments: Record<string, string | null>;
  templates?: Record<string, string>;
  newUids: Record<string, string>;
}

export interface PlanningBatch {
  actionIds: string[];
  edits: Array<{ path: string; before: string | null; after: string }>;
  identities: Record<string, LocalIdentity>;
  createdUids: string[];
  consumedRefs: string[];
}
