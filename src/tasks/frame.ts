import { fromMarkdown } from "../mdast/mdast";

import { captureTitle, parseCaptureCandidates } from "./capture-parser";
import { taskInlineMarkdown } from "./schedule-markdown";
import { replaceTaskTitle } from "./weak-sync";

function tags(text: string) {
  const first = text.split(/\r?\n/, 1)[0] ?? "";
  const line = `- [ ] ${first.replace(/^\s*(?:[-*+]|\d+[.)])\s+(?:\[[^\]]\]\s*)?/, "")}`;
  return (parseCaptureCandidates("", line)[0]?.tags ?? []).map((tag) =>
    tag.name.toLowerCase(),
  );
}
const controlTags = new Set(["frame", "locked", "todoist"]);

export function frameTaskTitle(text: string) {
  const first = text.split(/\r?\n/, 1)[0] ?? "";
  const line = `- [ ] ${first.replace(/^\s*(?:[-*+]|\d+[.)])\s+(?:\[[^\]]\]\s*)?/, "")}`;
  const candidate = parseCaptureCandidates("", line)[0];
  return candidate
    ? captureTitle(candidate, new Set(candidate.tags.map((tag) => tag.name)))
    : "";
}

export function singleFrameChild<T extends { text: string }>(block: {
  text: string;
  children?: T[];
}) {
  const child = block.children?.length === 1 ? block.children[0] : undefined;
  return child &&
    tags(block.text).includes("frame") &&
    frameTaskTitle(child.text)
    ? child
    : undefined;
}

export function frameHeading(block: {
  text: string;
  children?: Array<{ text: string }>;
}) {
  const child = singleFrameChild(block);
  if (!child) return block.text;
  const first = block.text.split(/\r?\n/, 1)[0] ?? "";
  const parent = parseCaptureCandidates("", `- [ ] ${first}`)[0];
  const childTags =
    parseCaptureCandidates(
      "",
      `- [ ] ${child.text.replace(/^\s*(?:[-*+]|\d+[.)])\s+(?:\[[^\]]\]\s*)?/, "")}`,
    )[0]?.tags ?? [];
  const labels = [
    ...new Set(
      [...(parent?.tags ?? []), ...childTags].map((tag) => `#${tag.name}`),
    ),
  ].join(" ");
  const childFirst = child.text.split(/\r?\n/, 1)[0] ?? "";
  return (
    `${taskInlineMarkdown(frameTaskTitle(child.text))}${labels ? ` ${labels}` : ""}` +
    block.text.slice(first.length) +
    child.text.slice(childFirst.length)
  );
}

export function calendarFrameChild(snapshot: {
  tags?: string[];
  subtasks?: string;
}) {
  if (!snapshot.tags?.some((tag) => tag.toLowerCase() === "frame")) return;
  const raw = snapshot.subtasks ?? "";
  const items = fromMarkdown(raw).children.flatMap((node) =>
    node.type === "list" ? node.children : [],
  );
  const item = items.length === 1 ? items[0] : undefined;
  if (!item?.position) return;
  const from = item.position.start.offset!;
  const first = raw.slice(from).split(/\r?\n/, 1)[0] ?? "";
  const title = frameTaskTitle(first);
  return title ? { title, from, first } : undefined;
}

export function renameCalendarFrameChild(
  snapshot: { tags?: string[]; subtasks?: string },
  title: string,
) {
  const child = calendarFrameChild(snapshot);
  if (!child) return snapshot.subtasks ?? "";
  const prefix =
    child.first.match(/^(?:[-*+]|\d+[.)])\s+(?:\[[^\]]\]\s*)?/)?.[0] ?? "- ";
  const normalized = `- [ ] ${child.first.slice(prefix.length)}`;
  const candidate = parseCaptureCandidates("", normalized)[0]!;
  const renamed = replaceTaskTitle(
    candidate,
    normalized,
    taskInlineMarkdown(title),
  ).slice(6);
  const raw = snapshot.subtasks ?? "";
  return (
    raw.slice(0, child.from) +
    prefix +
    renamed +
    raw.slice(child.from + child.first.length)
  );
}

export function frameDropWarning(
  parent: string,
  child: string,
): string | undefined {
  if (!parent.toLowerCase().includes("#frame")) return;
  const labels = tags(parent);
  if (!labels.includes("frame")) return;
  const expected = labels.filter((label) => !controlTags.has(label));
  const actual = tags(child).filter((label) => !controlTags.has(label));
  if (
    !expected.length ||
    !actual.length ||
    expected.some((label) => actual.includes(label))
  )
    return;
  return `This frame expects ${expected.map((label) => `#${label}`).join(" or ")}. The added task does not match the frame labels.`;
}

export function frameState(block: {
  text: string;
  children?: Array<{ text: string }>;
}) {
  const frame =
    block.text.toLowerCase().includes("#frame") &&
    tags(block.text).includes("frame");
  const empty = frame && !block.children?.length;
  const mismatch =
    frame &&
    block.children?.some((child) =>
      Boolean(frameDropWarning(block.text, child.text)),
    );
  return {
    frame,
    empty,
    warning: empty
      ? "Add tasks to this frame"
      : mismatch
        ? "Some tasks do not match this frame’s labels"
        : "",
  };
}
