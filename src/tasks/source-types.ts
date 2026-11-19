import { z } from "zod";

export const taskSourceReferenceSchema = z.object({
  provider: z.string().min(1),
  accountId: z.string().min(1),
  itemId: z.string().min(1),
});

export const taskMembershipSchema = z.object({
  containerId: z.string().min(1),
  itemId: z.string().min(1),
  order: z.number(),
  status: z
    .object({ fieldId: z.string(), optionId: z.string(), name: z.string() })
    .optional(),
  date: z.object({ fieldId: z.string(), value: z.iso.date() }).optional(),
});

export const taskSourceMetadataSchema = z.object({
  kind: z.enum(["task", "issue", "draft", "pull-request"]),
  nativeId: z.string().min(1),
  nativeContainerId: z.string().optional(),
  url: z.string().optional(),
  updatedAt: z.string().optional(),
  orderKey: z.string().optional(),
  dateMeaning: z.enum(["scheduled", "target"]).optional(),
  memberships: z.array(taskMembershipSchema).optional(),
  state: z.enum(["open", "closed"]).optional(),
  number: z.number().int().positive().optional(),
  assignees: z.array(z.string()).optional(),
  assignedToMe: z.boolean().optional(),
  private: z.boolean().optional(),
  milestoneDate: z.iso.date().optional(),
  descriptionTruncated: z.boolean().optional(),
});

export const taskContainerMetadataSchema = z.object({
  kind: z.enum(["list", "repository", "project"]),
  nativeId: z.string().min(1),
  url: z.string().optional(),
  fields: z
    .array(
      z.object({
        id: z.string().min(1),
        name: z.string(),
        type: z.enum(["single-select", "date"]),
        options: z
          .array(z.object({ id: z.string(), name: z.string() }))
          .optional(),
      }),
    )
    .optional(),
  fieldsComplete: z.boolean().optional(),
});

export type TaskSourceReference = z.infer<typeof taskSourceReferenceSchema>;
export type TaskSourceMetadata = z.infer<typeof taskSourceMetadataSchema>;
export type TaskMembership = z.infer<typeof taskMembershipSchema>;
