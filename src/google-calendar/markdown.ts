import type { Heading, List, ListItem } from "mdast";

import { fromMarkdown } from "../mdast/mdast";
import { getTimeFromLine, getTimeRangeMatch } from "../parser/parser";
import type { DayPlannerSettings } from "../settings";

import { normalizeTitle, type CalendarSnapshot } from "./types";

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
  const title = snapshot.title
    .replace(/[\r\n]+/g, " ")
    .replace(/<!--.*?-->/g, "")
    .trim();
  const range = `${start.format(settings.timestampFormat)} - ${end.format(settings.timestampFormat)}`;
  return [
    `${prefix}${range} ${title}${comments ? ` ${comments}` : ""}${blockId}`,
    ...lines.slice(1),
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
