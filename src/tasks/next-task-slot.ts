import type { Nodes } from "mdast";

import { fromMarkdown } from "../mdast/mdast";
import { getTimeRangeMatch } from "../parser/parser";
import { parseTime } from "../parser/time";
import type { DayPlannerSettings } from "../settings";
import { getMinutesSinceMidnight } from "../util/moment";
import { createTimestampParts } from "../util/time-block-utils";

import { taskDropAllowed } from "./schedule-markdown";

/** Insert a sibling after the whole current task, retaining its existing children. */
export function planNextTaskSlot(
  contents: string,
  line: number,
  settings: DayPlannerSettings,
) {
  if (!settings.nextTaskSlotOnEnter) return;
  const text = contents.split(/\r?\n/)[line];
  if (text === undefined) return;
  const prefix = text.match(/^([ \t]*)([-*+]|\d+[.)])\s+(?:\[([^\]])\]\s*)?/);
  const range = getTimeRangeMatch(text);
  if (!prefix || !range) return;
  const pending: Nodes[] = [fromMarkdown(contents)];
  let at: number | undefined;
  while (pending.length) {
    const node = pending.pop()!;
    if (node.type === "listItem" && node.position?.start.line === line + 1) {
      if (!taskDropAllowed(contents, node.position.start.offset ?? 0)) return;
      at = node.position.end.offset;
      break;
    }
    if ("children" in node) pending.push(...node.children);
  }
  if (at === undefined) return;
  try {
    const day = window.moment().startOf("day");
    const start = parseTime(range.start, day);
    const next = range.end
      ? parseTime(range.end, day)
      : start.clone().add(settings.defaultDurationMinutes, "minutes");
    if (range.end && !next.isAfter(start)) next.add(1, "day");
    if (!next.isSame(day, "day")) return;
    const clock = createTimestampParts(
      getMinutesSinceMidnight(next),
      settings.defaultDurationMinutes,
      settings.timestampFormat,
    );
    const number = prefix[2]!.match(/^(\d+)([.)])$/);
    const marker = number ? `${Number(number[1]) + 1}${number[2]}` : prefix[2]!;
    const listPrefix = `${prefix[1]}${marker} ${prefix[3] === undefined ? "" : "[ ] "}`;
    const newline = contents.includes("\r\n") ? "\r\n" : "\n";
    const selected = `${clock.start} - ${clock.end} `;
    const insertion = `${newline}${listPrefix}${selected}`;
    const from = at + newline.length + listPrefix.length;
    return { at, insertion, from, to: from + selected.length };
  } catch {
    return;
  }
}
