import { DateTime } from "luxon";
import type { Nodes } from "mdast";

import { fromMarkdown } from "../mdast/mdast";
import { parseCaptureCandidates } from "../tasks/capture-parser";
import { frameDropWarning, frameState } from "../tasks/frame";
import { containsLockedTask } from "../util/task-lock";

import {
  planningContextSchema,
  planningProposalSchema,
  type PlanningAction,
  type PlanningContext,
  type PlanningIssue,
  type PlanningProposal,
} from "./types";

export class PlanningValidationError extends Error {
  constructor(readonly issues: PlanningIssue[]) {
    super(issues.map((issue) => issue.message).join("\n"));
    this.name = "PlanningValidationError";
  }
}

/** Use the ordinary lock checks for roots and all Markdown list descendants. */
export function planningSourceLocked(raw: string) {
  const children: Array<{ text: string }> = [];
  const pending: Nodes[] = [fromMarkdown(raw)];
  while (pending.length) {
    const node = pending.pop()!;
    if (node.type === "listItem")
      children.push({
        text: raw.slice(node.position!.start.offset, node.position!.end.offset),
      });
    if ("children" in node) pending.push(...node.children);
  }
  return containsLockedTask({ text: raw, children });
}

export function planningDestination(context: PlanningContext, start: string) {
  const date = DateTime.fromISO(start, { zone: context.timezone })
    .setZone(context.timezone)
    .toISODate();
  return Object.entries(context.documents).find(
    ([, document]) => document.date === date,
  )?.[0];
}

export function selectedPlanningActions(
  proposal: PlanningProposal,
  selectedIds?: string[],
) {
  const selected = new Set(
    selectedIds ?? proposal.actions.map((action) => action.id),
  );
  return proposal.actions.filter((action) => selected.has(action.id));
}

function overlaps(
  left: { start: string; end: string },
  right: { start: string; end: string },
) {
  return (
    Date.parse(left.start) < Date.parse(right.end) &&
    Date.parse(right.start) < Date.parse(left.end)
  );
}

function validInterval(
  context: PlanningContext,
  action: Extract<PlanningAction, { start: string }>,
) {
  const start = DateTime.fromISO(action.start, {
    zone: context.timezone,
  }).setZone(context.timezone);
  const end = DateTime.fromISO(action.end, {
    zone: context.timezone,
  }).setZone(context.timezone);
  const lastInstant = end.minus({ milliseconds: 1 });
  const lastDate = DateTime.fromISO(context.startDate, {
    zone: context.timezone,
  })
    .plus({ days: context.dayCount - 1 })
    .toISODate();
  const endMinutes = end.startOf("day").equals(end)
    ? 1440
    : end.hour * 60 + end.minute;
  return Boolean(
    start.isValid &&
      end.isValid &&
      end > start &&
      start.toMillis() % 60_000 === 0 &&
      end.toMillis() % 60_000 === 0 &&
      start.toISODate()! >= context.startDate &&
      lastInstant.toISODate()! <= lastDate! &&
      start.hasSame(lastInstant, "day") &&
      start.hour * 60 + start.minute >= context.preferences.startHour * 60 &&
      endMinutes <= context.preferences.endHour * 60,
  );
}

/** Validate selected actions together against the schedule they would produce. */
export function validateProposal(
  context: PlanningContext,
  proposal: PlanningProposal,
  selectedIds?: string[],
  currentDocuments?: Record<string, string | null>,
): PlanningIssue[] {
  const parsed = planningProposalSchema.safeParse(proposal);
  if (!parsed.success || !planningContextSchema.safeParse(context).success)
    return [
      {
        code: "context",
        message:
          "The planning document is invalid. Refresh context and import a valid proposal.",
      },
    ];
  if (proposal.contextId !== context.id)
    return [
      {
        code: "context",
        message:
          "These suggestions belong to another planning context. Refresh context.",
      },
    ];
  if (
    !DateTime.fromISO(context.createdAt).setZone(context.timezone).isValid ||
    context.preferences.startHour >= context.preferences.endHour
  )
    return [
      {
        code: "context",
        message: "Choose a valid local timezone and planning hours.",
      },
    ];

  const issues: PlanningIssue[] = [];
  const add = (
    actionId: string,
    code: PlanningIssue["code"],
    message: string,
  ) => issues.push({ actionId, code, message });
  const actions = selectedPlanningActions(proposal, selectedIds);
  const actionIds = new Set<string>();
  for (const action of proposal.actions) {
    if (actionIds.has(action.id))
      add(action.id, "duplicate", "Each suggestion needs a unique ID.");
    actionIds.add(action.id);
  }
  if (selectedIds?.some((id) => !actionIds.has(id)))
    issues.push({
      code: "source",
      message: "A selected suggestion is unavailable. Refresh the review.",
    });
  const refs = new Set<string>();
  for (const source of [...context.tasks, ...context.blocks]) {
    if (refs.has(source.ref))
      issues.push({
        code: "context",
        message:
          "The planning context contains duplicate references. Refresh context.",
      });
    refs.add(source.ref);
  }
  const taskRefs = new Set(context.tasks.map((task) => task.ref));
  for (const bucket of proposal.buckets)
    if (bucket.taskRefs.some((ref) => !taskRefs.has(ref)))
      issues.push({
        code: "source",
        message: `The task view “${bucket.title}” refers to an unavailable task.`,
      });
  const selectedRefs = new Set<string>();
  const sources: Array<{
    actionId: string;
    path: string;
    from: number;
    raw: string;
  }> = [];
  const moved = new Set(
    actions
      .filter((action) => action.kind === "move")
      .map((action) => action.sourceRef),
  );
  const fixed = context.blocks.filter((block) => !moved.has(block.ref));
  const intervals: Array<{ actionId: string; start: string; end: string }> = [];

  for (const action of actions) {
    if (selectedRefs.has(action.sourceRef))
      add(action.id, "duplicate", "Choose one placement for each source task.");
    selectedRefs.add(action.sourceRef);
    const source =
      action.kind === "move"
        ? context.blocks.find((block) => block.ref === action.sourceRef)
        : context.tasks.find((task) => task.ref === action.sourceRef);
    if (!source) {
      add(
        action.id,
        "source",
        "This task or block is unavailable in the planning context.",
      );
      continue;
    }
    if (
      ("completed" in source && source.completed) ||
      ("available" in source && source.available === false) ||
      parseCaptureCandidates("", source.raw).find(
        (candidate) => candidate.from === 0,
      )?.completed
    )
      add(
        action.id,
        "source",
        "This task is no longer available for scheduling.",
      );
    if (
      ("locked" in source && source.locked) ||
      planningSourceLocked(source.raw)
    )
      add(action.id, "locked", "This task or one of its subtasks is locked.");
    const paths = new Set<string>();
    if (source.path) {
      paths.add(source.path);
      const text = context.documents[source.path]?.text;
      if (
        source.from === undefined ||
        text?.slice(source.from, source.from + source.raw.length) !== source.raw
      )
        add(
          action.id,
          "stale",
          "The saved task source changed. Refresh context.",
        );
      else
        sources.push({
          actionId: action.id,
          path: source.path,
          from: source.from,
          raw: source.raw,
        });
      if (
        action.kind !== "move" &&
        source.from !== undefined &&
        context.blocks.some(
          (block) =>
            block.path === source.path &&
            source.from! >= block.from &&
            source.from! < block.from + block.raw.length,
        )
      )
        add(
          action.id,
          "source",
          "This task already belongs to a scheduled block.",
        );
    } else if (
      action.kind === "move" ||
      ("kind" in source && source.kind === "note")
    )
      add(action.id, "source", "This note task has no source document.");
    if (action.kind === "add-to-frame") {
      const frame = context.blocks.find(
        (block) => block.ref === action.frameRef,
      );
      if (!frame || !frameState({ text: frame.raw }).frame) {
        add(action.id, "source", "Choose an existing frame from this context.");
        continue;
      }
      if (planningSourceLocked(frame.raw))
        add(
          action.id,
          "locked",
          "This frame or one of its subtasks is locked.",
        );
      const warning = frameDropWarning(frame.raw, source.raw);
      if (warning) add(action.id, "labels", warning);
      paths.add(frame.path);
    } else {
      if (
        action.kind === "move" &&
        "start" in source &&
        Date.parse(action.end) - Date.parse(action.start) !==
          Date.parse(source.end) - Date.parse(source.start)
      )
        add(
          action.id,
          "interval",
          "Keep this block's existing duration when moving it.",
        );
      if (!validInterval(context, action))
        add(
          action.id,
          "interval",
          "Choose whole-minute times within one selected planning day and its planning hours.",
        );
      const path = planningDestination(context, action.start);
      if (!path)
        add(
          action.id,
          "source",
          "The destination daily note is unavailable. Refresh context.",
        );
      else paths.add(path);
      if (
        [
          ...fixed,
          ...context.commitments.filter((entry) => !entry.allDay),
        ].some((block) => overlaps(action, block))
      )
        add(
          action.id,
          "overlap",
          "This suggestion overlaps an existing commitment or an unmoved schedule block.",
        );
      intervals.push({
        actionId: action.id,
        start: action.start,
        end: action.end,
      });
    }
    for (const path of paths)
      if (
        currentDocuments &&
        currentDocuments[path] !== context.documents[path]?.text
      )
        add(
          action.id,
          "stale",
          "A relevant note changed after these suggestions. Refresh context.",
        );
  }
  for (let index = 0; index < intervals.length; index++)
    for (const other of intervals.slice(index + 1))
      if (overlaps(intervals[index]!, other)) {
        add(
          intervals[index]!.actionId,
          "overlap",
          "Selected suggestions overlap each other.",
        );
        add(
          other.actionId,
          "overlap",
          "Selected suggestions overlap each other.",
        );
      }
  for (let index = 0; index < sources.length; index++)
    for (const other of sources.slice(index + 1)) {
      const source = sources[index]!;
      if (
        source.path === other.path &&
        source.from < other.from + other.raw.length &&
        other.from < source.from + source.raw.length
      ) {
        add(
          source.actionId,
          "duplicate",
          "Choose the parent task or its child, since their source subtrees overlap.",
        );
        add(
          other.actionId,
          "duplicate",
          "Choose the parent task or its child, since their source subtrees overlap.",
        );
      }
    }
  const providerSources = actions.flatMap((action) => {
    const task = context.tasks.find((entry) => entry.ref === action.sourceRef);
    return task && task.kind !== "note" ? [{ actionId: action.id, task }] : [];
  });
  for (let index = 0; index < providerSources.length; index++)
    for (const other of providerSources.slice(index + 1)) {
      const source = providerSources[index]!;
      if (
        source.task.provider !== other.task.provider ||
        source.task.accountId !== other.task.accountId
      )
        continue;
      const taskIds = new Set(source.task.taskIds ?? [source.task.taskId]);
      if (
        (other.task.taskIds ?? [other.task.taskId]).some((id) =>
          taskIds.has(id),
        )
      ) {
        add(
          source.actionId,
          "duplicate",
          "Choose the provider parent task or its child, since their subtasks overlap.",
        );
        add(
          other.actionId,
          "duplicate",
          "Choose the provider parent task or its child, since their subtasks overlap.",
        );
      }
    }
  return issues;
}
