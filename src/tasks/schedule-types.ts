import { DateTime } from "luxon";
import { z } from "zod";

import { taskMutationSchema, taskPatchSchema } from "./operations";
import { taskSourceSchema } from "./source";
import { taskSchema, type ProviderTask } from "./types";

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

export const scheduleOperationSchema = z
  .object({
    id: z.uuid(),
    provider: z.string(),
    accountId: z.string(),
    task: taskSchema,
    linkUid: z.string(),
    googleUid: z.string(),
    providerOperationId: z.uuid(),
    occurrenceKey: z.string(),
    target: z.discriminatedUnion("kind", [
      z.object({
        kind: z.literal("schedule"),
        interval: scheduleIntervalSchema,
      }),
      z.object({
        kind: z.literal("insert"),
        path: z.string(),
        offset: z.number().int().nonnegative(),
        before: z.string(),
      }),
      z.object({ kind: z.literal("unschedule") }),
      z.object({
        kind: z.literal("reconcile"),
        interval: scheduleIntervalSchema.nullable(),
      }),
    ]),
    previous: taskSourceSchema.optional(),
    children: z.array(taskSchema),
    previousInterval: scheduleIntervalSchema.optional(),
    raw: z.string(),
    generatedTaskIds: z.array(z.string()),
    syncTaskDate: z.boolean(),
    unlink: z.boolean().optional(),
    unlinkNoteBase: taskSourceSchema.optional(),
    repairCaptureTag: z.boolean().optional(),
    providerChanges: taskPatchSchema.optional(),
    providerSteps: z
      .array(
        z.object({
          id: z.uuid(),
          mutation: taskMutationSchema,
          base: taskSchema,
        }),
      )
      .optional(),
    taskAcknowledged: z.boolean().optional(),
    calendarBase: calendarSnapshotSchema.optional(),
    supersededBy: z.uuid().optional(),
    calendarRemovals: z
      .array(
        z.object({
          uid: z.string(),
          path: z.string(),
          snapshot: calendarSnapshotSchema,
        }),
      )
      .optional(),
    calendarPredecessors: z
      .array(
        projectionBlockSchema.extend({
          base: calendarSnapshotSchema.optional(),
        }),
      )
      .optional(),
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
  })
  .refine(
    (operation) =>
      !operation.unlink ||
      (operation.target.kind === "reconcile" &&
        !operation.repairCaptureTag &&
        !operation.syncTaskDate &&
        !operation.providerChanges &&
        !operation.providerSteps?.length &&
        !operation.plan?.block),
    {
      message:
        "Unlink journals contain local note edits and calendar recovery only.",
    },
  )
  .refine(
    (operation) =>
      !operation.repairCaptureTag ||
      (operation.target.kind === "reconcile" &&
        !operation.unlink &&
        !operation.syncTaskDate &&
        !operation.providerChanges &&
        !operation.providerSteps?.length &&
        !operation.plan?.block),
    {
      message:
        "Capture-tag repair journals contain local note edits and calendar recovery only.",
    },
  );

export type ScheduleInterval = z.infer<typeof scheduleIntervalSchema>;
export type TaskProjection = z.infer<typeof taskProjectionSchema>;
export type ScheduleOperation = z.infer<typeof scheduleOperationSchema>;

/** Calendar-only retries can yield to a later task edit after both task sides agree. */
export function scheduleBlocksTask(operation: ScheduleOperation) {
  return (
    !["complete", "cancelled"].includes(operation.phase) &&
    !(
      operation.phase === "calendar-pending" &&
      operation.taskAcknowledged &&
      !operation.unlink
    )
  );
}

export function taskOccurrenceKey(task: ProviderTask) {
  return task.due?.recurring
    ? JSON.stringify([task.due.date, task.due.text, task.due.timezone])
    : "single";
}

/** A date-only provider edit retains the linked interval's local clock time and length. */
export function intervalForTaskDate(
  interval: ScheduleInterval,
  task: {
    due: { date: string; timezone: string | null } | null;
    duration?: { amount: number; unit: "minute" | "day" } | null;
  },
  zone: string,
  syncDuration = false,
): ScheduleInterval {
  if (!task.due && (!syncDuration || !task.duration)) return interval;
  const timezone = task.due?.timezone ?? zone;
  const dateValue = task.due?.date;
  const original = DateTime.fromISO(interval.start).setZone(timezone);
  const date = !dateValue
    ? original
    : dateValue.includes("T")
      ? DateTime.fromISO(dateValue, { zone: timezone })
      : DateTime.fromISO(`${dateValue}T${original.toFormat("HH:mm")}`, {
          zone: timezone,
        });
  if (
    !date.isValid ||
    (dateValue &&
      !dateValue.includes("T") &&
      date.toFormat("HH:mm") !== original.toFormat("HH:mm"))
  )
    throw new Error(
      "This provider date falls in an invalid local clock time. Choose its schedule time explicitly.",
    );
  if (
    dateValue &&
    !/(?:Z|[+-]\d{2}:\d{2})$/i.test(dateValue) &&
    date.getPossibleOffsets().length > 1 &&
    !date.getPossibleOffsets().some((value) => value.offset === original.offset)
  )
    throw new Error(
      "Choose an explicit offset for this repeated local clock time.",
    );
  const chosen =
    !dateValue || /(?:Z|[+-]\d{2}:\d{2})$/i.test(dateValue)
      ? date
      : (date
          .getPossibleOffsets()
          .find((value) => value.offset === original.offset) ?? date);
  return scheduleIntervalSchema.parse({
    start: chosen.toUTC().toISO(),
    end: chosen
      .plus({
        milliseconds:
          syncDuration && task.duration
            ? task.duration.amount *
              (task.duration.unit === "day" ? 1440 : 1) *
              60_000
            : Date.parse(interval.end) - Date.parse(interval.start),
      })
      .toUTC()
      .toISO(),
  });
}

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
