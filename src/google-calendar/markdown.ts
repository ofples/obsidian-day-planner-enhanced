import type { Heading, List, ListItem } from "mdast";

import { fromMarkdown } from "../mdast/mdast";
import { getTimeFromLine, getTimeRangeMatch } from "../parser/parser";
import type { DayPlannerSettings } from "../settings";
import { captureTitle, parseCaptureCandidates } from "../tasks/capture-parser";
import {
  formatTaskLink,
  stripTaskLink,
  taskLinkIdentity,
  taskLinkUrl,
} from "../tasks/weak-links";

import {
  normalizeTitle,
  type CalendarSnapshot,
  type LocalBlock,
} from "./types";

export function normalizeLocalSnapshot(block: LocalBlock): CalendarSnapshot {
  const first = block.raw.split(/\r?\n/)[0] ?? "";
  const candidate = parseCaptureCandidates(
    block.path,
    `- [ ] ${stripTaskLink(first).replace(/^\s*(?:[-*+]|\d+[.)])\s+(?:\[[^\]]\]\s*)?/, "")}`,
  )[0];
  const tags = candidate?.tags.map((tag) => tag.name) ?? [];
  const title = stripTaskLink(
    candidate ? captureTitle(candidate, new Set(tags)) : block.snapshot.title,
  );
  const root = fromMarkdown(block.raw);
  const parent = root.children.find((node) => node.type === "list")
    ?.children[0];
  const lists = parent?.children.filter((node) => node.type === "list") ?? [];
  const subtasks = lists
    .map((node) => {
      const from = node.position?.start.offset ?? 0;
      const lineStart = block.raw.lastIndexOf("\n", from - 1) + 1;
      const indent = block.raw.slice(lineStart, from);
      return block.raw
        .slice(from, node.position?.end.offset)
        .split(/\r?\n/)
        .map((line, index) =>
          index && line.startsWith(indent) ? line.slice(indent.length) : line,
        )
        .join("\n");
    })
    .join("\n");
  const description = readLocalDescription(block.raw);
  return {
    ...block.snapshot,
    title,
    tags,
    subtasks,
    description,
    taskUrl: taskLinkUrl(first) ?? null,
  };
}

const descriptionHeading = /^\s*> Calendar description:\s*$/;
const descriptionEnd = /^\s*> End Calendar description\s*$/;
function readLocalDescription(raw: string) {
  const lines = raw.split(/\r?\n/);
  const index = lines.findIndex((line) => descriptionHeading.test(line));
  if (index < 0) {
    const root = fromMarkdown(raw);
    const parent = root.children.find((node) => node.type === "list")
      ?.children[0];
    const lists = (parent?.children ?? [])
      .filter((node) => node.type === "list")
      .map((node) => ({
        start: node.position?.start.line ?? 0,
        end: node.position?.end.line ?? 0,
      }));
    return lines
      .slice(1)
      .filter(
        (_, index) =>
          !lists.some(
            (range) => index + 2 >= range.start && index + 2 <= range.end,
          ),
      )
      .map((line) => line.replace(/^ {1,2}/, ""))
      .join("\n")
      .trim();
  }
  if (
    lines.findIndex((line, i) => i > index && descriptionHeading.test(line)) >=
    0
  )
    throw new Error(
      "Multiple Calendar description sections need review before syncing.",
    );
  const result: string[] = [];
  let ended = false;
  for (let i = index + 1; i < lines.length; i++) {
    if (descriptionEnd.test(lines[i]!)) {
      ended = true;
      break;
    }
    const match = lines[i]!.match(/^\s*> ?(.*)$/);
    if (!match)
      throw new Error(
        "The Calendar description section is incomplete. Review it before syncing.",
      );
    result.push(match[1]!);
  }
  if (!ended)
    throw new Error(
      "The Calendar description section is incomplete. Review it before syncing.",
    );
  return result.join("\n");
}

export const syncMarker = /<!-- dp-gcal:([a-f0-9]{32}) -->/;
const cancelledMarker = /<!-- dp-gcal-cancelled:[a-f0-9]{32} -->/;

export function stripSyncMarkers(text: string) {
  return text.replace(/ ?<!-- dp-gcal(?:-cancelled)?:[a-f0-9]{32} -->/g, "");
}

export interface ParsedBlock {
  uid?: string;
  from: number;
  to: number;
  raw: string;
  snapshot: CalendarSnapshot;
}

function headingText(heading: Heading) {
  return heading.children
    .map((child) => ("value" in child ? child.value : ""))
    .join("");
}

export function hasPlannerSection(text: string, settings: DayPlannerSettings) {
  return (
    !settings.plannerHeading ||
    fromMarkdown(text).children.some(
      (node) =>
        node.type === "heading" &&
        headingText(node) === settings.plannerHeading,
    )
  );
}

/** Use the planner's AST and time parser, with source offsets for minimal writes. */
export function parseBlocks(
  text: string,
  date: string,
  settings: DayPlannerSettings,
): ParsedBlock[] {
  const root = fromMarkdown(text);
  let active = !settings.plannerHeading;
  let depth = 0;
  const result: ParsedBlock[] = [];
  for (const node of root.children) {
    if (node.type === "heading") {
      if (headingText(node) === settings.plannerHeading) {
        active = true;
        depth = node.depth;
      } else if (node.depth <= depth) active = !settings.plannerHeading;
      continue;
    }
    if (!active || node.type !== "list") continue;
    for (const item of (node as List).children as ListItem[]) {
      const from = item.position?.start.offset;
      const to = item.position?.end.offset;
      if (from === undefined || to === undefined) continue;
      const raw = text.slice(from, to);
      if (cancelledMarker.test(raw.split(/\r?\n/)[0] ?? "")) continue;
      const line = raw.split(/\r?\n/)[0] ?? "";
      if (/^\s*[-*+]\s+\[-\]/.test(line)) continue;
      const range = getTimeRangeMatch(line);
      const time = getTimeFromLine({
        line,
        day: window.moment(date, "YYYY-MM-DD", true),
      });
      if (!time || !range || !time.startTime.isValid()) continue;
      let duration = time.durationMinutes ?? settings.defaultDurationMinutes;
      // Match the timeline's optional stretch-to-next behavior.
      if (!range.end && settings.extendDurationUntilNext) {
        const nextTimes = (node as List).children
          .map((next) => {
            const start = next.position?.start.offset ?? 0;
            return getTimeFromLine({
              line: text.slice(start).split(/\r?\n/)[0] ?? "",
              day: window.moment(date),
            })?.startTime;
          })
          .filter((next) => next && next.isAfter(time.startTime));
        const next = nextTimes.sort(
          (a, b) => (a?.valueOf() ?? 0) - (b?.valueOf() ?? 0),
        )[0];
        if (next) duration = next.diff(time.startTime, "minutes");
      }
      const withoutTime =
        line.slice(0, range.startIndex) + line.slice(range.endIndex);
      const title = withoutTime
        .replace(/^\s*(?:[-*+]|\d+[.)])\s+(?:\[[^\]]\]\s*)?/, "")
        .replace(/\s\^[\w-]+\s*$/, "")
        .replace(syncMarker, "")
        .trim()
        .replace(/\s+/g, " ")
        .replace(/^-\s+/, "");
      result.push({
        uid: line.match(syncMarker)?.[1],
        from,
        to,
        raw,
        snapshot: {
          title: normalizeTitle(title),
          start: time.startTime.toISOString(),
          end: time.startTime.clone().add(duration, "minutes").toISOString(),
        },
      });
    }
  }
  return result;
}

export function addMarker(line: string, uid: string) {
  const blockId = line.match(/\s\^[\w-]+\s*$/)?.[0] ?? "";
  return `${line.slice(0, line.length - blockId.length).trimEnd()} <!-- dp-gcal:${uid} -->${blockId}`;
}

export function renderBlock(
  _uid: string,
  snapshot: CalendarSnapshot,
  settings: DayPlannerSettings,
  previous?: string,
) {
  const newline = previous?.includes("\r\n") ? "\r\n" : "\n";
  const lines = previous?.split(/\r?\n/) ?? [];
  const first = lines[0] ?? "- [ ] ";
  const prefix =
    first.match(/^\s*(?:[-*+]|\d+[.)])\s+(?:\[[^\]]\]\s*)?/)?.[0] ?? "- [ ] ";
  const blockId = first.match(/\s\^[\w-]+\s*$/)?.[0] ?? "";
  const comments = (first.match(/<!--.*?-->/g) ?? [])
    .filter((comment) => !syncMarker.test(comment))
    .join(" ");
  const start = window.moment(snapshot.start);
  const end = window.moment(snapshot.end);
  if (end.diff(start, "minutes") > 24 * 60 || !end.isAfter(start)) {
    throw new Error(
      "Events longer than 24 hours cannot be represented as a Day Planner time range.",
    );
  }
  // Google event titles are plain text: prevent Markdown/HTML injection into a note.
  const title =
    snapshot.title
      .replace(/[\r\n]+/g, " ")
      .replace(/<!--.*?-->/g, "")
      .trim() +
    (snapshot.tags?.length
      ? ` ${snapshot.tags.map((tag) => `#${tag}`).join(" ")}`
      : "");
  const range = `${start.format(settings.timestampFormat)} - ${end.format(settings.timestampFormat)}`;
  const previousLink = taskLinkIdentity(first);
  const selectedUrl =
    snapshot.taskUrl === undefined ? previousLink?.url : snapshot.taskUrl;
  const link = selectedUrl
    ? formatTaskLink(
        selectedUrl,
        previousLink?.url === selectedUrl ? previousLink.occurrence : undefined,
      )
    : "";
  let remaining = lines.slice(1);
  if (previous && snapshot.subtasks !== undefined) {
    const root = fromMarkdown(previous);
    const parent = root.children.find((node) => node.type === "list")
      ?.children[0];
    const ranges = (parent?.children ?? [])
      .filter((node) => node.type === "list")
      .map((node) => ({
        start: node.position?.start.line ?? 0,
        end: node.position?.end.line ?? 0,
      }));
    remaining = remaining.filter(
      (_, index) =>
        !ranges.some(
          (range) => index + 2 >= range.start && index + 2 <= range.end,
        ),
    );
  }
  if (snapshot.description !== undefined) {
    if (snapshot.subtasks !== undefined) remaining = [];
    else if (previous) {
      const parent = fromMarkdown(previous).children.find(
        (node) => node.type === "list",
      )?.children[0];
      const lists = (parent?.children ?? [])
        .filter((node) => node.type === "list")
        .map((node) => ({
          start: node.position?.start.line ?? 0,
          end: node.position?.end.line ?? 0,
        }));
      remaining = remaining.filter((_, index) =>
        lists.some(
          (range) => index + 2 >= range.start && index + 2 <= range.end,
        ),
      );
    }
  }
  return [
    `${prefix}${range} ${title}${link ? ` ${link}` : ""}${comments ? ` ${comments}` : ""}${blockId}`,
    ...remaining,
    ...(snapshot.description
      ? [...snapshot.description.split(/\r?\n/).map((line) => `  ${line}`)]
      : []),
    ...(snapshot.subtasks
      ? snapshot.subtasks.split(/\r?\n/).map((line) => `  ${line}`)
      : []),
  ].join(newline);
}

export function appendToPlanner(
  text: string,
  block: string,
  settings: DayPlannerSettings,
) {
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  const root = fromMarkdown(text);
  if (!settings.plannerHeading)
    return `${text}${newline}${newline}${block}${newline}`;
  const index = root.children.findIndex(
    (node) =>
      node.type === "heading" && headingText(node) === settings.plannerHeading,
  );
  const heading = root.children[index];
  if (heading?.type !== "heading") {
    return `${text}${newline}${newline}${"#".repeat(settings.plannerHeadingLevel)} ${settings.plannerHeading}${newline}${newline}${block}${newline}`;
  }
  const next = root.children
    .slice(index + 1)
    .find((node) => node.type === "heading" && node.depth <= heading.depth);
  const offset = next?.position?.start.offset ?? text.length;
  return `${text.slice(0, offset)}${newline}${block}${newline}${newline}${text.slice(offset)}`;
}
