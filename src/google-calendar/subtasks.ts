import type { List, ListItem } from "mdast";

import { fromMarkdown } from "../mdast/mdast";
import { exportPlainText } from "../util/schedule-export";

export const subtasksStart = "<!-- day-planner-subtasks:start -->";
export const subtasksEnd = "<!-- day-planner-subtasks:end -->";

export const structuredStart = "--- Day Planner fields ---";
export const structuredEnd = "--- End Day Planner fields ---";

function validateStructuredSubtasks(value: string) {
  if (!value.trim()) return;
  const tree = fromMarkdown(value);
  if (
    !tree.children.length ||
    tree.children.some((node) => node.type !== "list")
  )
    throw new Error(
      "The Google Calendar subtasks must be a Markdown list. Review them before syncing.",
    );
}

/** The editable section uses Markdown, so checkbox state and nesting survive a round trip. */
export function structuredDescription(
  description: string,
  tags: string[],
  subtasks: string,
) {
  validateStructuredSubtasks(subtasks);
  if (
    description.includes(structuredStart) ||
    description.includes(structuredEnd)
  )
    throw new Error(
      "The description contains reserved Day Planner markers. Review it before syncing.",
    );
  const section = [
    structuredStart,
    `Tags: ${tags.map((tag) => `#${tag}`).join(" ")}`,
    "Subtasks:",
    subtasks,
    structuredEnd,
  ].join("\n");
  return description ? `${description}\n\n${section}` : section;
}

export function readStructuredDescription(value: string) {
  const start = value.indexOf(structuredStart);
  const end = value.indexOf(structuredEnd);
  if (start < 0 && end < 0) return null;
  if (
    start < 0 ||
    end < start ||
    value.indexOf(structuredStart, start + 1) >= 0 ||
    value.indexOf(structuredEnd, end + 1) >= 0
  )
    throw new Error(
      "The Day Planner fields in the Google description are malformed. Review them before syncing.",
    );
  const content = value
    .slice(start + structuredStart.length, end)
    .replace(/^\r?\n/, "")
    .replace(/\r?\n$/, "");
  const match = content.match(
    /^Tags:\s*([^\r\n]*)\r?\nSubtasks:\s*(?:\r?\n|$)([\s\S]*)$/,
  );
  if (!match)
    throw new Error(
      "The Day Planner fields in the Google description are malformed. Review them before syncing.",
    );
  const tagLine = match[1]!.trim();
  const tags = tagLine ? tagLine.split(/\s+/) : [];
  if (tags.some((tag) => !/^#[\p{L}\p{M}\p{N}_/-]+$/u.test(tag)))
    throw new Error(
      "The Day Planner tags in Google Calendar are invalid. Review them before syncing.",
    );
  const prefix = value.slice(0, start).replace(/\r?\n\r?\n$/, "");
  const suffix = value.slice(end + structuredEnd.length);
  validateStructuredSubtasks(match[2]!);
  return {
    tags: tags.map((tag) => tag.slice(1)),
    subtasks: match[2]!,
    description: prefix + suffix,
  };
}

function escapeHtml(text: string) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Share only the nested list, using the same Markdown-to-text conversion as PNG exports. */
export function renderSubtasks(raw: string) {
  const root = fromMarkdown(raw);
  const parent = root.children.find((node) => node.type === "list")
    ?.children[0];
  if (!parent) return "";
  const renderItem = (item: ListItem): string => {
    const text = item.children
      .filter((node) => node.type !== "list")
      .map((node) =>
        raw.slice(node.position?.start.offset, node.position?.end.offset),
      )
      .join("\n\n");
    const status = text.match(/^\s*\[([^\]])\](?:\s+|$)/)?.[1];
    const checkbox =
      status === undefined
        ? ""
        : /^[xX]$/.test(status)
          ? "☑ "
          : status === " "
            ? "☐ "
            : `[${escapeHtml(status)}] `;
    return `<li>${checkbox}${escapeHtml(exportPlainText(text)).replace(/\r?\n/g, "<br>")}${renderLists(item)}</li>`;
  };
  const renderList = (list: List): string => {
    const tag = list.ordered ? "ol" : "ul";
    const start = list.ordered && list.start ? ` start="${list.start}"` : "";
    return `<${tag}${start}>${list.children.map(renderItem).join("")}</${tag}>`;
  };
  const renderLists = (item: ListItem): string =>
    item.children
      .filter((node): node is List => node.type === "list")
      .map(renderList)
      .join("");
  const children = renderLists(parent);
  return children ? `<b>Subtasks</b>${children}` : "";
}

export function withSubtasks(
  description: string,
  subtasks: string,
  previouslyManaged = false,
) {
  const start = description.indexOf(subtasksStart);
  const end = description.indexOf(subtasksEnd);
  if (
    start >= 0 !== end >= 0 ||
    (start >= 0 && end < start) ||
    description.indexOf(subtasksStart, start + subtasksStart.length) >= 0 ||
    description.indexOf(subtasksEnd, end + subtasksEnd.length) >= 0
  )
    throw new Error(
      "The synced subtask section in Google Calendar was changed. Remove that section and sync again.",
    );
  if (start < 0 && previouslyManaged && /Subtasks/.test(description))
    throw new Error(
      "The synced subtask section in Google Calendar was changed. Remove that section and sync again.",
    );
  const prefix = start < 0 ? description : description.slice(0, start);
  const suffix = end < 0 ? "" : description.slice(end + subtasksEnd.length);
  const section = subtasks
    ? `${subtasksStart}${prefix ? "<br><br>" : ""}${subtasks}${subtasksEnd}`
    : "";
  return prefix + section + suffix;
}
