import type { Nodes } from "mdast";
import type { Moment } from "moment";

import { parseBlocks } from "../google-calendar/markdown";
import { toMarkdown } from "../mdast/mdast";
import { fromMarkdown } from "../mdast/mdast";
import { getTimeRangeMatch } from "../parser/parser";
import type { DayPlannerSettings } from "../settings";
import { exportPlainText } from "../util/schedule-export";

import {
  taskAccountSettings,
  type TaskCaptureSettings,
} from "./capture-settings";
import { TaskReadError, type ProviderTask, type TaskSnapshot } from "./types";

/** A drop immediately before or after a timed root takes the adjacent slot. */
export function adjacentTaskDropInterval(
  text: string,
  offset: number,
  day: Moment,
  settings: DayPlannerSettings,
  durationMinutes: number,
) {
  const blocks = parseBlocks(text, day.format("YYYY-MM-DD"), {
    ...settings,
    plannerHeading: "",
  });
  for (const block of blocks) {
    if (offset > block.from && offset < block.to) return null;
  }
  const gap = (value: string) => /^[\t ]*(?:\r?\n[\t ]*)?$/.test(value);
  const previous = blocks
    .filter((block) => block.to <= offset && gap(text.slice(block.to, offset)))
    .at(-1);
  const next = blocks.find(
    (block) => block.from >= offset && gap(text.slice(offset, block.from)),
  );
  if (previous) {
    const start = window.moment(previous.snapshot.end);
    return {
      start: start.toISOString(),
      end: start.clone().add(durationMinutes, "minutes").toISOString(),
    };
  }
  if (next) {
    const end = window.moment(next.snapshot.start);
    return {
      start: end.clone().subtract(durationMinutes, "minutes").toISOString(),
      end: end.toISOString(),
    };
  }
  return null;
}

/** Place whole list items or lines without splitting existing Markdown. */
export function taskDropBoundary(text: string, offset: number) {
  for (const node of fromMarkdown(text).children) {
    if (node.type !== "list") continue;
    for (const item of node.children) {
      const from = item.position?.start.offset;
      const to = item.position?.end.offset;
      if (
        from === undefined ||
        to === undefined ||
        offset < from ||
        offset > to
      )
        continue;
      const headerEnd = text.indexOf("\n", from);
      const midpoint =
        (from + (headerEnd < 0 ? to : Math.min(headerEnd, to))) / 2;
      return offset <= midpoint ? text.lastIndexOf("\n", from - 1) + 1 : to;
    }
  }
  const from = text.lastIndexOf("\n", offset - 1) + 1;
  const end = text.indexOf("\n", offset);
  const to = end < 0 ? text.length : end;
  return offset <= (from + to) / 2 ? from : to;
}

export function noteTaskSource(
  before: string,
  target: { path: string; line: number; text: string },
) {
  const pending: Nodes[] = [fromMarkdown(before)];
  while (pending.length) {
    const node = pending.pop()!;
    if (
      node.type === "listItem" &&
      node.position?.start.line === target.line + 1
    ) {
      const from = node.position.start.offset!;
      const raw = before.slice(from, node.position.end.offset!);
      const first = raw.split(/\r?\n/)[0]!;
      const text = first
        .replace(/^(?:[-*+]|\d+[.)])\s+(?:\[[^\]]\]\s*)?/, "")
        .trim();
      const lineStart = before.lastIndexOf("\n", from - 1) + 1;
      if (
        text !== target.text.split(/\r?\n/)[0]?.trim() ||
        !/^[ \t]*$/.test(before.slice(lineStart, from)) ||
        !taskDropAllowed(before, from)
      )
        break;
      return { path: target.path, from, raw, title: text };
    }
    if ("children" in node) pending.push(...node.children);
  }
  throw new TaskReadError(
    "This block changed. Refresh the timeline before adding a subtask.",
  );
}

export function subtaskInsertTarget(
  before: string,
  target: { path: string; line: number; text: string },
) {
  const parent = noteTaskSource(before, target);
  if (!getTimeRangeMatch(parent.raw.split(/\r?\n/)[0] ?? ""))
    throw new TaskReadError("Choose a timed schedule block for this subtask.");
  return {
    path: target.path,
    offset: parent.from + parent.raw.length,
    before,
    parent,
  };
}

/** Source ranges start at the list marker, while continuation lines retain
 * their original indentation. Move the whole subtree with those offsets. */
export function indentTaskSubtree(
  raw: string,
  sourceIndent: string,
  destinationIndent: string,
  newline: string,
) {
  return raw
    .split(/\r?\n/)
    .map(
      (line, index) =>
        destinationIndent +
        (index > 0 && line.startsWith(sourceIndent)
          ? line.slice(sourceIndent.length)
          : line),
    )
    .join(newline);
}

export function taskInlineMarkdown(title: string) {
  let text = toMarkdown({
    type: "paragraph",
    children: title
      .replace(/[\r\n]+/g, " ")
      .split(/([<%])/)
      .filter(Boolean)
      .map((part) =>
        part === "<" || part === "%"
          ? { type: "html" as const, value: part === "<" ? "&#60;" : "&#37;" }
          : { type: "text" as const, value: part },
      ),
  }).trim();
  text = text.replace(
    /(^|[\s(])#([\p{L}\p{M}\p{N}_/-]+)/gu,
    (_, prefix: string, tag: string) => `${prefix}\\#${tag}`,
  );
  text = text.replace(/\s\^([\w-]+)\s*$/, " \\^$1");
  const time = getTimeRangeMatch(text);
  if (time)
    text =
      text.slice(0, time.startIndex) +
      "`" +
      text.slice(time.startIndex, time.endIndex) +
      "`" +
      text.slice(time.endIndex);
  return text;
}

export function taskDropAllowed(text: string, offset: number) {
  const properties = text.match(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/)?.[0];
  if (properties && offset < properties.length) return false;
  for (const comment of text.matchAll(/%%[\s\S]*?(?:%%|$)/g))
    if (offset >= comment.index && offset <= comment.index + comment[0].length)
      return false;
  const pending: Nodes[] = [fromMarkdown(text)];
  while (pending.length) {
    const node = pending.pop()!;
    const from = node.position?.start.offset,
      to = node.position?.end.offset;
    if (
      from !== undefined &&
      to !== undefined &&
      offset >= from &&
      offset <= to &&
      ["code", "inlineCode", "html"].includes(node.type)
    )
      return false;
    if ("children" in node) pending.push(...node.children);
  }
  return true;
}

export function taskDropUsesPlanner(
  text: string,
  offset: number,
  heading: string,
) {
  if (!heading) return true;
  let active = false,
    depth = 0;
  for (const node of fromMarkdown(text).children) {
    if ((node.position?.start.offset ?? 0) > offset) break;
    if (node.type !== "heading") continue;
    if (exportPlainText(toMarkdown(node)) === heading) {
      active = true;
      depth = node.depth;
    } else if (node.depth <= depth) active = false;
  }
  return active;
}

export function scheduleNoteTitle(raw: string) {
  let line = raw.split(/\r?\n/)[0] ?? "";
  const range = getTimeRangeMatch(line);
  if (range)
    line = line.slice(0, range.startIndex) + line.slice(range.endIndex);
  return line
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+(?:\[[^\]]\]\s*)?/, "")
    .replace(/<!--.*?-->/g, "")
    .replace(/\s\^[\w-]+\s*$/, "")
    .trim();
}

export function newTaskMarkdown(
  task: ProviderTask,
  children: { task: ProviderTask; depth: number }[],
  snapshot: TaskSnapshot,
  settings: TaskCaptureSettings,
) {
  const account = taskAccountSettings(settings, snapshot);
  const projectTag = Object.entries(account.projectMappings).find(
    ([, id]) => id === task.projectId,
  )?.[0];
  const labels = Object.entries(account.labelMappings)
    .filter(([, label]) => task.labels.includes(label))
    .map(([tag]) => `#${tag}`);
  const tags = [
    "#todoist",
    ...(projectTag ? [`#${projectTag}`] : []),
    ...labels,
  ];
  return [
    `- [ ] ${taskInlineMarkdown(task.title)} ${tags.join(" ")}`,
    ...children.map(
      (child) =>
        `${"  ".repeat(child.depth)}- [ ] ${taskInlineMarkdown(child.task.title)}`,
    ),
  ].join("\n");
}
