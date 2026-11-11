import type { Nodes } from "mdast";

import { toMarkdown } from "../mdast/mdast";
import { fromMarkdown } from "../mdast/mdast";
import { getTimeRangeMatch } from "../parser/parser";
import { exportPlainText } from "../util/schedule-export";

import { taskGroups } from "./browser";
import {
  taskAccountSettings,
  type TaskCaptureSettings,
} from "./capture-settings";
import type { ProviderTask, TaskSnapshot } from "./types";

export function taskInlineMarkdown(title: string) {
  let text = toMarkdown({
    type: "paragraph",
    children: [{ type: "text", value: title.replace(/[\r\n]+/g, " ") }],
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

/** Use the same iterative task forest as the pane. */
export function taskSubtree(snapshot: TaskSnapshot, task: ProviderTask) {
  const rows =
    taskGroups(snapshot, {
      groupBy: "project",
      query: "",
      projectId: "",
      selectedId: null,
      collapsed: [],
    }).find((group) => group.id === task.projectId)?.rows ?? [];
  const root = rows.findIndex((row) => row.task.id === task.id);
  const depth = rows[root]?.depth ?? 0;
  const children: { task: ProviderTask; depth: number }[] = [];
  for (let index = root + 1; root >= 0 && index < rows.length; index++) {
    const row = rows[index]!;
    if (row.depth <= depth) break;
    children.push({ task: row.task, depth: row.depth - depth });
  }
  return children;
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
