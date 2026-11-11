import { getTimeRangeMatch } from "../parser/parser";

import { parseCaptureCandidates } from "./capture-parser";
import type { TaskAccountSettings } from "./capture-settings";
import { taskInlineMarkdown } from "./schedule-markdown";
import type { ProviderTask } from "./types";

/** Change owned first-line fields while retaining child bytes, comments and native IDs. */
export function rewriteTaskNote(
  raw: string,
  task: ProviderTask,
  account: TaskAccountSettings,
  fields: string[],
) {
  const newline = raw.includes("\r\n") ? "\r\n" : "\n";
  const lines = raw.split(/\r?\n/);
  let first = lines[0] ?? "";
  if (fields.includes("title")) {
    const parsed = parseCaptureCandidates("", raw)[0];
    if (!parsed)
      throw new Error("The linked note is no longer a checklist task.");
    const tags = parsed.tags.map((tag) => tag.name);
    const routing = new Set([
      "todoist",
      ...Object.keys(account.projectMappings),
      ...Object.keys(account.labelMappings),
    ]);
    const unknown = new Set(
      tags
        .filter((tag) => !routing.has(tag.toLowerCase()))
        .map((tag) => tag.toLowerCase()),
    );
    const title = task.title
      .replace(
        /(^|[\s(])#([\p{L}\p{M}\p{N}_/-]+)/gu,
        (match, prefix: string, tag: string) =>
          unknown.has(tag.toLowerCase()) ? prefix : match,
      )
      .trim();
    const prefix = first.match(/^\s*(?:[-*+]|\d+[.)])\s+\[[^\]]\]\s*/)?.[0];
    if (!prefix)
      throw new Error(
        "Restore the linked checklist marker before reconciling its title.",
      );
    const range = getTimeRangeMatch(first);
    const time = range ? first.slice(range.startIndex, range.endIndex) : "";
    const comments = first.match(/<!--.*?-->|%%.*?%%/g) ?? [];
    const blockId = first.match(/\s\^[\w-]+\s*$/)?.[0] ?? "";
    first = `${prefix}${time ? `${time} ` : ""}${taskInlineMarkdown(title)}${tags.length ? ` ${tags.map((tag) => `#${tag}`).join(" ")}` : ""}${comments.length ? ` ${comments.join(" ")}` : ""}${blockId}`;
  }
  const project = fields.includes("projectId"),
    labels = fields.includes("labels");
  if (project || labels) {
    const candidate = parseCaptureCandidates("", first)[0];
    if (!candidate)
      throw new Error(
        "Restore the linked checklist before reconciling its tags.",
      );
    for (const tag of candidate.tags.toReversed())
      if (
        (project && account.projectMappings[tag.name.toLowerCase()]) ||
        (labels && account.labelMappings[tag.name.toLowerCase()])
      )
        first = first.slice(0, tag.from) + first.slice(tag.to);
    const additions = [
      ...(project
        ? (Object.entries(account.projectMappings)
            .find(([, id]) => id === task.projectId)
            ?.slice(0, 1) ?? [])
        : []),
      ...(labels
        ? Object.entries(account.labelMappings)
            .filter(([, name]) => task.labels.includes(name))
            .map(([tag]) => tag)
        : []),
    ];
    const blockId = first.match(/\s\^[\w-]+\s*$/)?.[0] ?? "";
    first =
      first.slice(0, first.length - blockId.length).trimEnd() +
      (additions.length
        ? ` ${additions.map((tag) => `#${tag}`).join(" ")}`
        : "") +
      blockId;
  }
  if (fields.includes("completed"))
    first = first.replace(
      /^(\s*(?:[-*+]|\d+[.)])\s+\[)[^\]](\])/,
      `$1${task.completed ? "x" : " "}$2`,
    );
  lines[0] = first;
  return lines.join(newline);
}
