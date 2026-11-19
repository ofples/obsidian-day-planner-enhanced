import { parseBlocks } from "../google-calendar/markdown";
import type { LocalIdentity } from "../google-calendar/types";
import type { DayPlannerSettings } from "../settings";
import { captureTitle, parseCaptureCandidates } from "../tasks/capture-parser";
import { noteTaskRows } from "../tasks/note-list";

import {
  planningContextSchema,
  type PlanningCommitment,
  type PlanningContext,
  type PlanningPreferences,
  type PlanningTask,
} from "./types";

interface ContextInput {
  id: string;
  createdAt: string;
  timezone: string;
  startDate: string;
  dayCount: number;
  request: string;
  preferences: PlanningPreferences;
  documents: PlanningContext["documents"];
  providerTasks: Array<Omit<PlanningTask, "ref">>;
  providerTaskCount?: number;
  commitments: PlanningCommitment[];
  identities: Record<string, LocalIdentity>;
  settings: DayPlannerSettings;
  tasksUpdatedAt?: string;
  calendarsUpdatedAt?: string;
  allocateUid?: () => string;
}

/** Build from existing caches and selected note contents without I/O. */
export function buildPlanningContext(input: ContextInput): PlanningContext {
  const allocateUid =
    input.allocateUid ?? (() => crypto.randomUUID().replace(/-/g, ""));
  const blocks: PlanningContext["blocks"] = [];
  const candidates = Object.entries(input.documents).flatMap(
    ([path, document]) => {
      if (document.text === null) return [];
      if (document.date) {
        const parsed = parseBlocks(
          document.text,
          document.date,
          input.settings,
        );
        for (const block of parsed) {
          const matches = Object.entries(input.identities).filter(
            ([, identity]) =>
              identity.path === path && identity.raw === block.raw,
          );
          const known =
            matches.find(([, identity]) => identity.from === block.from) ??
            (matches.length === 1 &&
            parsed.filter((item) => item.raw === block.raw).length === 1
              ? matches[0]
              : undefined);
          blocks.push({
            ref: `block-${blocks.length + 1}`,
            uid: known?.[0] ?? allocateUid(),
            path,
            from: block.from,
            raw: block.raw,
            title: block.snapshot.title,
            start: block.snapshot.start,
            end: block.snapshot.end,
          });
        }
      }
      return parseCaptureCandidates(path, document.text);
    },
  );
  const lockedAncestors = candidates.filter((candidate) =>
    candidate.tags.some((tag) => tag.name.toLowerCase() === "locked"),
  );
  const notes: PlanningTask[] = noteTaskRows(candidates)
    .filter((row) => !row.context)
    .map(({ candidate, locked }) => ({
      ref: "",
      kind: "note",
      title: captureTitle(
        candidate,
        new Set(candidate.tags.map((tag) => tag.name)),
      ),
      raw: candidate.raw,
      path: candidate.path,
      from: candidate.from,
      completed: candidate.completed,
      locked:
        locked ||
        lockedAncestors.some(
          (ancestor) =>
            ancestor.path === candidate.path &&
            ancestor.from < candidate.from &&
            ancestor.to >= candidate.to,
        ),
      labels: candidate.tags.map((tag) => tag.name),
    }));
  const providers = input.providerTasks.filter((task) => !task.completed);
  const available: Array<Omit<PlanningTask, "ref">> = [];
  // Interleave note and external candidates before applying the shared context limit.
  for (
    let index = 0;
    index < Math.max(notes.length, providers.length);
    index++
  ) {
    if (notes[index]) available.push(notes[index]!);
    if (providers[index]) available.push(providers[index]!);
  }
  if (available.length <= 500)
    available.splice(0, available.length, ...notes, ...providers);
  const tasks = available
    .slice(0, 500)
    .map((task, index) => ({ ...task, ref: `task-${index + 1}` }));
  return planningContextSchema.parse({
    version: 1,
    id: input.id,
    createdAt: input.createdAt,
    timezone: input.timezone,
    startDate: input.startDate,
    dayCount: input.dayCount,
    request: input.request,
    preferences: input.preferences,
    documents: input.documents,
    tasks,
    blocks,
    commitments: input.commitments,
    freshness: {
      tasksUpdatedAt: input.tasksUpdatedAt,
      calendarsUpdatedAt: input.calendarsUpdatedAt,
      taskCount: notes.length + (input.providerTaskCount ?? providers.length),
      truncated:
        notes.length + (input.providerTaskCount ?? providers.length) >
        tasks.length,
    },
  });
}

/** Full document snapshots stay local. Assistants receive scheduling data only. */
export function publicPlanningContext(context: PlanningContext) {
  return {
    version: context.version,
    id: context.id,
    createdAt: context.createdAt,
    timezone: context.timezone,
    startDate: context.startDate,
    dayCount: context.dayCount,
    request: context.request,
    preferences: context.preferences,
    tasks: context.tasks,
    blocks: context.blocks,
    commitments: context.commitments,
    freshness: context.freshness,
  };
}
