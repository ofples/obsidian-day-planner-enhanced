import { z } from "zod";

export const taskSourceSchema = z.object({
  path: z.string(),
  raw: z.string(),
  from: z.number().int().nonnegative(),
  title: z.string(),
});

export type TaskSource = z.infer<typeof taskSourceSchema>;
