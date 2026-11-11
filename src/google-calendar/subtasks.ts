import type { List, ListItem } from "mdast";

import { fromMarkdown } from "../mdast/mdast";
import { exportPlainText } from "../util/schedule-export";

export const subtasksStart = "<!-- day-planner-subtasks:start -->";
export const subtasksEnd = "<!-- day-planner-subtasks:end -->";

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
