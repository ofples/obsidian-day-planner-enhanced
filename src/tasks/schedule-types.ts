import { DateTime } from "luxon";
import { z } from "zod";

import { taskPatchSchema } from "./operations";
import { taskSourceSchema } from "./source";
import { taskSchema } from "./types";

export const scheduleIntervalSchema = z
  .object({ start: z.iso.datetime(), end: z.iso.datetime() })
  .refine(
    (interval) => {
      const start = Date.parse(interval.start),
        end = Date.parse(interval.end);
      return (
        start % 60_000 === 0 &&
        end % 60_000 === 0 &&
        end > start &&
        end - start <= 24 * 60 * 60_000
      );
    },
    { message: "Choose a whole-minute schedule lasting up to 24 hours." },
  );

const calendarSnapshotSchema = z.object({
  title: z.string(),
  start: z.iso.datetime(),
  end: z.iso.datetime(),
});
export const projectionBlockSchema = z.object({
  uid: z.string(),
  path: z.string(),
  raw: z.string(),
  from: z.number().int().nonnegative(),
  snapshot: calendarSnapshotSchema,
});
export const noteEditSchema = z.object({
  path: z.string(),
  before: z.string(),
  after: z.string(),
});
const projectionLinkSchema = z.object({
  uid: z.string(),
  task: taskSchema,
  source: taskSourceSchema,
});

export const taskProjectionSchema = z.object({
  provider: z.string(),
  accountId: z.string(),
  taskId: z.string(),
  linkUid: z.string(),
  googleUid: z.string().optional(),
  googleEventId: z.string().optional(),
  occurrenceKey: z.string(),
  source: taskSourceSchema,
  interval: scheduleIntervalSchema.nullable(),
  base: taskSchema,
});

export const scheduleOperationSchema = z.object({
  id: z.uuid(),
  provider: z.string(),
  accountId: z.string(),
  task: taskSchema,
  linkUid: z.string(),
  googleUid: z.string(),
  providerOperationId: z.uuid(),
  occurrenceKey: z.string(),
  target: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("schedule"), interval: scheduleIntervalSchema }),
    z.object({
      kind: z.literal("insert"),
      path: z.string(),
      offset: z.number().int().nonnegative(),
      before: z.string(),
    }),
    z.object({ kind: z.literal("unschedule") }),
  ]),
  previous: taskSourceSchema.optional(),
  children: z.array(taskSchema),
  previousInterval: scheduleIntervalSchema.optional(),
  raw: z.string(),
  generatedTaskIds: z.array(z.string()),
  syncTaskDate: z.boolean(),
  providerChanges: taskPatchSchema.optional(),
  phase: z.enum([
    "pending",
    "prepared",
    "local-applied",
    "provider-pending",
    "calendar-pending",
    "complete",
    "conflict",
    "cancelled",
  ]),
  plan: z
    .object({
      edits: z.array(noteEditSchema),
      block: projectionBlockSchema.optional(),
      links: z.array(projectionLinkSchema),
      interval: scheduleIntervalSchema.nullable(),
    })
    .optional(),
  createdAt: z.iso.datetime(),
  error: z.string().optional(),
});

export type ScheduleInterval = z.infer<typeof scheduleIntervalSchema>;
export type TaskProjection = z.infer<typeof taskProjectionSchema>;
export type ScheduleOperation = z.infer<typeof scheduleOperationSchema>;

export function resolveScheduleInput(
  date: string,
  time: string,
  duration: number,
  zone: string,
  offset?: number,
): ScheduleInterval {
  const local = DateTime.fromISO(`${date}T${time}`, { zone });
  if (
    !local.isValid ||
    local.toISODate() !== date ||
    local.toFormat("HH:mm") !== time
  )
    throw new Error("Choose a valid date and time in this time zone.");
  const possibilities = local.getPossibleOffsets();
  const chosen =
    possibilities.length > 1
      ? possibilities.find((value) => value.offset === offset)
      : local;
  if (!chosen)
    throw new Error("Choose the time offset for this repeated clock time.");
  return scheduleIntervalSchema.parse({
    start: chosen.toUTC().toISO(),
    end: chosen.plus({ minutes: duration }).toUTC().toISO(),
  });
}
