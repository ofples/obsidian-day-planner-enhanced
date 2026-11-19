import { z } from "zod";

import { githubSelectionSchema } from "./github-config";

const googleSettings = z.object({
  listIds: z.array(z.string()).nullable().default(null),
  showAssigned: z.boolean().default(false),
  allowCompletion: z.boolean().default(false),
});
const githubSettings = githubSelectionSchema.extend({
  includePrivate: z.boolean().default(false),
  useCustomClient: z.boolean().default(false),
  clientId: z.string().default(""),
});
export const taskSourcesSettingsSchema = z.object({
  googleTasks: googleSettings.default(() => googleSettings.parse({})),
  github: githubSettings.default(() => githubSettings.parse({})),
});
export type TaskSourcesSettings = z.infer<typeof taskSourcesSettingsSchema>;

export const taskSourceChoices = [
  { id: "overview", label: "Overview" },
  { id: "notes", label: "Notes" },
  { id: "todoist", label: "Todoist" },
  { id: "google-tasks", label: "Google Tasks" },
  { id: "github", label: "GitHub" },
] as const;
export type TaskPaneSource = (typeof taskSourceChoices)[number]["id"];
