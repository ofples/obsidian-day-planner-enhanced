import {
  appendToPlanner,
  normalizeLocalSnapshot,
  parseBlocks,
  renderBlock,
} from "../google-calendar/markdown";
import type { LocalIdentity } from "../google-calendar/types";
import { getTimeRangeMatch } from "../parser/parser";
import { locateSource } from "../service/source-identity";
import {
  indentTaskSubtree,
  scheduleNoteTitle,
} from "../tasks/schedule-markdown";
import { detectIndentation } from "../util/markdown";

import type {
  PlanningBatch,
  PlanningBatchOptions,
  PlanningContext,
  PlanningProposal,
} from "./types";
import {
  PlanningValidationError,
  planningDestination,
  selectedPlanningActions,
  validateProposal,
} from "./validation";

function sourceIndent(
  context: PlanningContext,
  source: { path?: string; from?: number },
) {
  if (!source.path || source.from === undefined) return "";
  const text = context.documents[source.path]?.text ?? "";
  return text.slice(text.lastIndexOf("\n", source.from - 1) + 1, source.from);
}

function withoutTime(raw: string) {
  const first = raw.split(/\r?\n/, 1)[0] ?? "";
  const range = getTimeRangeMatch(first);
  return range
    ? first.slice(0, range.startIndex) +
        first.slice(range.endIndex).trimStart() +
        raw.slice(first.length)
    : raw;
}

/** Prepare one checked batch without filesystem, provider, or host effects. */
export function buildPlanningBatch(
  context: PlanningContext,
  proposal: PlanningProposal,
  selectedIds: string[],
  options: PlanningBatchOptions,
): PlanningBatch {
  const issues = validateProposal(
    context,
    proposal,
    selectedIds,
    options.currentDocuments,
  );
  if (issues.length) throw new PlanningValidationError(issues);
  const actions = selectedPlanningActions(proposal, selectedIds);
  const documents: Record<string, string> = Object.fromEntries(
    Object.entries(context.documents).map(([path, document]) => [
      path,
      document.text ?? options.templates?.[path] ?? "",
    ]),
  );
  const sources = new Map(
    [...context.tasks, ...context.blocks].map((source) => [source.ref, source]),
  );
  const roots = new Map(
    context.blocks.map((block) => [
      block.ref,
      { uid: block.uid, path: block.path, raw: block.raw },
    ]),
  );
  const changedRoots = new Set<string>();
  const createdUids: string[] = [];
  const assignedUids = new Set(context.blocks.map((block) => block.uid));
  const consumedRefs: string[] = [];
  for (const action of actions) {
    const path =
      action.kind === "add-to-frame"
        ? context.blocks.find((block) => block.ref === action.frameRef)?.path
        : planningDestination(context, action.start);
    if (
      path &&
      context.documents[path]?.text === null &&
      options.templates?.[path] === undefined
    )
      throw new PlanningValidationError([
        {
          actionId: action.id,
          code: "context",
          message:
            "Prepare this daily note's template before applying its schedule.",
        },
      ]);
  }

  // Remove selected sources against original offsets before adding their destinations.
  const removals = actions
    .flatMap((action) => {
      const source = sources.get(action.sourceRef)!;
      return source.path && source.from !== undefined
        ? [{ path: source.path, from: source.from, raw: source.raw }]
        : [];
    })
    .sort((left, right) => right.from - left.from);
  for (const source of removals) {
    const text = documents[source.path]!;
    documents[source.path] =
      text.slice(0, source.from) + text.slice(source.from + source.raw.length);
  }

  for (const action of actions.filter((item) => item.kind !== "add-to-frame")) {
    const source = sources.get(action.sourceRef)!;
    const path = planningDestination(context, action.start)!;
    let uid: string;
    if (action.kind === "move")
      uid = context.blocks.find((block) => block.ref === action.sourceRef)!.uid;
    else {
      uid = options.newUids[action.id] ?? "";
      if (!/^[a-f0-9]{32}$/.test(uid) || assignedUids.has(uid))
        throw new PlanningValidationError([
          {
            actionId: action.id,
            code: "duplicate",
            message:
              "This placement needs a unique saved identity. Refresh the review.",
          },
        ]);
      assignedUids.add(uid);
      createdUids.push(uid);
      consumedRefs.push(source.ref);
    }
    const destination = documents[path]!;
    const raw = indentTaskSubtree(
      source.raw,
      sourceIndent(context, source),
      "",
      destination.includes("\r\n") ? "\r\n" : "\n",
      detectIndentation(destination),
    );
    const rendered = renderBlock(
      uid,
      { title: scheduleNoteTitle(raw), start: action.start, end: action.end },
      options.settings,
      raw,
      destination,
    );
    documents[path] = appendToPlanner(destination, rendered, options.settings);
    roots.set(action.sourceRef, { uid, path, raw: rendered });
    changedRoots.add(action.sourceRef);
  }

  for (const action of actions.filter((item) => item.kind === "add-to-frame")) {
    const source = sources.get(action.sourceRef)!;
    const parent = roots.get(action.frameRef)!;
    const text = documents[parent.path]!;
    const from = locateSource(text, parent);
    if (from < 0)
      throw new PlanningValidationError([
        {
          actionId: action.id,
          code: "stale",
          message: "The destination frame changed. Refresh context.",
        },
      ]);
    const step = detectIndentation(text);
    const newline = text.includes("\r\n") ? "\r\n" : "\n";
    const raw = indentTaskSubtree(
      withoutTime(source.raw),
      sourceIndent(context, source),
      step,
      newline,
      step,
    );
    const updated = parent.raw + newline + raw;
    documents[parent.path] =
      text.slice(0, from) + updated + text.slice(from + parent.raw.length);
    roots.set(action.frameRef, { ...parent, raw: updated });
    changedRoots.add(action.frameRef);
    consumedRefs.push(source.ref);
  }

  const identities: Record<string, LocalIdentity> = {};
  for (const ref of changedRoots) {
    const root = roots.get(ref)!;
    const document = context.documents[root.path]!;
    const matches = parseBlocks(
      documents[root.path]!,
      document.date!,
      options.settings,
    ).filter((block) => block.raw === root.raw);
    if (matches.length !== 1)
      throw new PlanningValidationError([
        {
          code: "source",
          message:
            "A proposed schedule block could not be located uniquely. Refresh context.",
        },
      ]);
    const block = matches[0]!;
    identities[root.uid] = {
      path: root.path,
      from: block.from,
      raw: block.raw,
      snapshot: normalizeLocalSnapshot({
        uid: root.uid,
        path: root.path,
        raw: block.raw,
        from: block.from,
        snapshot: block.snapshot,
      }),
    };
  }
  return {
    actionIds: actions.map((action) => action.id),
    edits: Object.entries(documents)
      .filter(
        ([path, after]) =>
          after !==
          (context.documents[path]!.text ?? options.templates?.[path] ?? ""),
      )
      .map(([path, after]) => ({
        path,
        before: context.documents[path]!.text,
        after,
      })),
    identities,
    createdUids,
    consumedRefs,
  };
}

/** Rebase remaining suggestions after this proposal's own approved subset. */
export function advancePlanningContext(
  context: PlanningContext,
  batch: PlanningBatch,
): PlanningContext {
  const documents = { ...context.documents };
  for (const edit of batch.edits)
    documents[edit.path] = { ...documents[edit.path]!, text: edit.after };
  const blocks = context.blocks.map((block) => {
    const identity = batch.identities[block.uid];
    if (identity)
      return {
        ...block,
        ...identity,
        title: identity.snapshot.title,
        start: identity.snapshot.start,
        end: identity.snapshot.end,
      };
    const from = locateSource(documents[block.path]?.text ?? "", block);
    return { ...block, from };
  });
  for (const [uid, identity] of Object.entries(batch.identities))
    if (!blocks.some((block) => block.uid === uid))
      blocks.push({
        ref: `accepted-${uid}`,
        uid,
        path: identity.path,
        raw: identity.raw,
        from: identity.from,
        title: identity.snapshot.title,
        start: identity.snapshot.start,
        end: identity.snapshot.end,
      });
  const consumedTasks = context.tasks.filter((task) =>
    batch.consumedRefs.includes(task.ref),
  );
  const tasks = context.tasks.map((task) => {
    if (
      batch.consumedRefs.includes(task.ref) ||
      consumedTasks.some(
        (source) =>
          source.kind === "todoist" &&
          task.kind === "todoist" &&
          source.provider === task.provider &&
          source.accountId === task.accountId &&
          task.taskId &&
          source.taskIds?.includes(task.taskId),
      )
    )
      return { ...task, available: false };
    if (!task.path || task.from === undefined) return task;
    const from = locateSource(documents[task.path]?.text ?? "", task);
    return from < 0 ? { ...task, available: false } : { ...task, from };
  });
  return { ...context, documents, blocks, tasks };
}
