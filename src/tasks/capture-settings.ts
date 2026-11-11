import { z } from "zod";

import type { TaskSnapshot } from "./types";

export const taskAccountSettingsSchema = z.object({
  calendarDisplay: z
    .object({
      enabled: z.boolean(),
      googleCalendarIds: z.array(z.string()),
      icalUrls: z.array(z.string()),
    })
    .optional(),
  defaultProjectId: z.string().default(""),
  projectMappings: z.record(z.string(), z.string()).default({}),
  labelMappings: z.record(z.string(), z.string()).default({}),
});

export const taskCaptureSettingsSchema = z.object({
  enabled: z.boolean().default(true),
  roots: z.array(z.string()).default([]),
  accounts: z.record(z.string(), taskAccountSettingsSchema).default({}),
});

export type TaskAccountSettings = z.infer<typeof taskAccountSettingsSchema>;
export type TaskCaptureSettings = z.infer<typeof taskCaptureSettingsSchema>;

export function taskAccountKey(snapshot: TaskSnapshot) {
  return JSON.stringify([snapshot.provider, snapshot.account.id]);
}

export function taskAccountSettings(
  settings: TaskCaptureSettings,
  snapshot: TaskSnapshot,
): TaskAccountSettings {
  const saved = settings.accounts[taskAccountKey(snapshot)];
  if (saved) return saved;
  const names = new Map<string, string[]>();
  for (const project of snapshot.projects) {
    const tag = project.name.toLowerCase();
    if (tag === "todoist" || !/^[\p{L}\p{M}\p{N}_/-]+$/u.test(tag)) continue;
    names.set(tag, [...(names.get(tag) ?? []), project.id]);
  }
  return {
    defaultProjectId:
      snapshot.projects.find((project) => project.inbox)?.id ?? "",
    projectMappings: Object.fromEntries(
      [...names]
        .filter(([, ids]) => ids.length === 1)
        .map(([tag, ids]) => [tag, ids[0]!]),
    ),
    labelMappings: {},
  };
}

export function capturePathEnabled(
  path: string,
  settings: TaskCaptureSettings,
) {
  return (
    settings.enabled &&
    (!settings.roots.length ||
      settings.roots.some(
        (root) =>
          path === root || path.startsWith(root.replace(/\/$/, "") + "/"),
      ))
  );
}
