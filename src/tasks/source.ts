import { z } from "zod";

import { taskSchema } from "./types";

export const taskSourceSchema = z.object({
  path: z.string(),
  raw: z.string(),
  from: z.number().int().nonnegative(),
  title: z.string(),
});

export type TaskSource = z.infer<typeof taskSourceSchema>;

export const taskLinkSchema = z.object({
  provider: z.string(),
  accountId: z.string(),
  taskId: z.string().nullable(),
  source: taskSourceSchema,
  noteBase: taskSourceSchema.optional(),
  base: taskSchema.nullable(),
});
