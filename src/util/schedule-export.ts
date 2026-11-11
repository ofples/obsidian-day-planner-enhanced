import type { Nodes } from "mdast";

import { fromMarkdown } from "../mdast/mdast";
import { restoreWikilinks } from "../mdast/wikilink";
import type { ListItemEntryWithChildren } from "../redux/index/index-slice";
import type { DayPlannerSettings } from "../settings";
import { isRemote, type TimelineTimeBlock } from "../time-block-types";

import type { Moment } from "./obsidian-moment";
import { filterVisibleTaskChildren } from "./task-status";
import { isCompleted, toRenderableMarkdown } from "./time-block-utils";

export interface ScheduleExportLine {
  text: string;
  depth: number;
  completed: boolean;
  checkbox: boolean;
}

export interface ScheduleExportEntry {
  time: string;
  title: string;
  completed: boolean;
  checkbox: boolean;
  color: string;
  lines: ScheduleExportLine[];
}

function nodeText(node: Nodes): string {
  if (node.type === "html") return "";
  if (node.type === "image") return node.alt ?? "";
  if ("children" in node)
    return node.children.map(nodeText).join(node.type === "root" ? "\n" : "");
  if ("value" in node) return node.value;
  return "";
}

export function exportPlainText(markdown: string) {
  const source = markdown.replace(/\s\^[\w-]+\s*$/u, "");
  return restoreWikilinks(nodeText(fromMarkdown(source)))
    .replace(
      /!?\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g,
      (_match, target: string, alias?: string) => alias ?? target,
    )
    .replace(/^\s*(?:[-*+]\s+)?\[[^\]]\]\s*/u, "")
    .trim();
}

export function createScheduleExportEntries(
  blocks: TimelineTimeBlock[],
  settings: DayPlannerSettings,
  includeSubtasks = true,
): ScheduleExportEntry[] {
  const sorted = blocks.toSorted(
    (a, b) =>
      Number(!a.isAllDayEvent) - Number(!b.isAllDayEvent) ||
      a.startTime.valueOf() - b.startTime.valueOf(),
  );
  return sorted.map((block) => {
    const duration = "durationMinutes" in block ? block.durationMinutes : 0;
    const time = block.isAllDayEvent
      ? "All day"
      : `${block.startTime.format(settings.timestampFormat)} – ${block.startTime.clone().add(duration, "minutes").format(settings.timestampFormat)}`;
    if (isRemote(block)) {
      return {
        time,
        title: exportPlainText(block.summary),
        completed: block.rsvpStatus === "DECLINED",
        checkbox: false,
        color: block.calendar.color,
        lines: [],
      };
    }
    const { listItem } = toRenderableMarkdown(block, {
      hideTasksMetadata: settings.hideTasksMetadata,
    });
    const lines: ScheduleExportLine[] = [];
    function addChildren(
      children: ListItemEntryWithChildren[] = [],
      depth = 0,
    ) {
      for (const child of children) {
        // The original child text preserves its own time range, unlike a parent title.
        lines.push({
          text: exportPlainText(child.text.split("\n")[0] ?? ""),
          depth,
          completed: isCompleted(child.task),
          checkbox: child.task !== undefined,
        });
        addChildren(child.children, depth + 1);
      }
    }
    if (includeSubtasks)
      addChildren(
        filterVisibleTaskChildren(block.children, settings.hiddenTaskStatuses),
      );
    const override = settings.colorOverrides.find((entry) =>
      block.text.includes(entry.text),
    );
    return {
      time,
      title: exportPlainText(listItem),
      completed: isCompleted(block.task ?? block.status),
      checkbox: block.task !== undefined,
      color: override?.color ?? "#318779",
      lines,
    };
  });
}

export function wrapExportText(
  text: string,
  maxWidth: number,
  measure: (value: string) => number,
) {
  const lines: string[] = [];
  for (const paragraph of text.split(/\r?\n/)) {
    let line = "";
    for (const word of paragraph.split(/\s+/u).filter(Boolean)) {
      const joined = line ? `${line} ${word}` : word;
      if (measure(joined) <= maxWidth) {
        line = joined;
        continue;
      }
      if (line) {
        lines.push(line);
        line = "";
      }
      // Long links/words and CJK text must wrap as well.
      const segments =
        typeof Intl.Segmenter === "function"
          ? Array.from(
              new Intl.Segmenter(undefined, {
                granularity: "grapheme",
              }).segment(word),
              (segment) => segment.segment,
            )
          : Array.from(word);
      for (const character of segments) {
        if (line && measure(line + character) > maxWidth) {
          lines.push(line);
          line = "";
        }
        line += character;
      }
    }
    lines.push(line);
  }
  return lines;
}

interface DrawnRow {
  text: string[];
  depth: number;
  checkbox: boolean;
  completed: boolean;
  title: boolean;
}

/** Draw a standalone, light-background sharing layout, independent of viewport/zoom. */
export function drawSchedulePng(
  canvas: HTMLCanvasElement,
  day: Moment,
  entries: ScheduleExportEntry[],
) {
  const context = canvas.getContext("2d");
  if (!context)
    throw new Error("This device could not create an image canvas.");
  const width = 1080;
  const font = '"Segoe UI", "Noto Sans", system-ui, sans-serif';
  const plans = entries.map((entry) => {
    const rows: DrawnRow[] = [
      {
        text: [],
        depth: 0,
        checkbox: entry.checkbox,
        completed: entry.completed,
        title: true,
      },
    ];
    context.font = `600 29px ${font}`;
    rows[0]!.text = wrapExportText(
      entry.title,
      670,
      (text) => context.measureText(text).width,
    );
    context.font = `400 23px ${font}`;
    for (const child of entry.lines) {
      const depth = Math.min(child.depth + 1, 8);
      rows.push({
        ...child,
        depth,
        title: false,
        text: wrapExportText(
          child.text,
          Math.max(240, 670 - depth * 24),
          (text) => context.measureText(text).width,
        ),
      });
    }
    return {
      entry,
      rows,
      height: Math.max(
        88,
        38 +
          rows.reduce(
            (sum, row) =>
              sum +
              row.text.length * (row.title ? 39 : 33) +
              (row.title ? 0 : 10),
            0,
          ),
      ),
    };
  });
  const height =
    240 + plans.reduce((sum, plan) => sum + plan.height + 14, 0) + 76;
  if (height > 16_000)
    throw new Error(
      "This schedule is too long for one PNG. Export without subtasks or reduce the number of entries.",
    );
  const scale = Math.min(
    2,
    16_000 / height,
    Math.sqrt(32_000_000 / (width * height)),
  );
  canvas.width = Math.floor(width * scale);
  canvas.height = Math.floor(height * scale);
  context.scale(scale, scale);
  context.fillStyle = "#f4f6f4";
  context.fillRect(0, 0, width, height);
  context.fillStyle = "#318779";
  context.fillRect(52, 50, 42, 5);
  context.font = `600 15px ${font}`;
  context.fillText("DAILY SCHEDULE", 52, 88);
  context.fillStyle = "#1b3030";
  context.font = `600 42px ${font}`;
  context.fillText(day.format("dddd"), 52, 144);
  context.fillStyle = "#647773";
  context.font = `400 25px ${font}`;
  context.fillText(day.format("D MMMM YYYY"), 52, 186);
  context.textBaseline = "top";
  let y = 228;
  for (const { entry, rows, height: cardHeight } of plans) {
    context.fillStyle = "#ffffff";
    context.beginPath();
    context.roundRect(42, y, width - 84, cardHeight, 15);
    context.fill();
    context.fillStyle =
      /^#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/i.test(entry.color)
        ? entry.color
        : "#318779";
    context.fillRect(42, y + 18, 4, cardHeight - 36);
    context.fillStyle = "#60736e";
    context.font = `600 20px ${font}`;
    const timeLines = entry.time.split(" – ");
    timeLines.forEach((time, index) =>
      context.fillText(
        index === 0 ? time : `– ${time}`,
        66,
        y + 25 + index * 28,
      ),
    );
    let rowY = y + 23;
    for (const row of rows) {
      const x = 273 + row.depth * 24;
      context.font = `${row.title ? "600 29" : "400 23"}px ${font}`;
      context.fillStyle = row.completed
        ? "#8b9993"
        : row.title
          ? "#203a35"
          : "#52665e";
      if (row.checkbox) {
        context.strokeStyle = row.completed ? "#8b9993" : "#8fa99e";
        context.lineWidth = 1.6;
        context.beginPath();
        context.roundRect(x - 28, rowY + 5, 17, 17, 4);
        context.stroke();
        if (row.completed) {
          context.beginPath();
          context.moveTo(x - 25, rowY + 13);
          context.lineTo(x - 21, rowY + 18);
          context.lineTo(x - 14, rowY + 9);
          context.stroke();
        }
      } else if (!row.title) {
        context.beginPath();
        context.arc(x - 18, rowY + 13, 2.5, 0, Math.PI * 2);
        context.fill();
      }
      for (const text of row.text) {
        context.fillText(text, x, rowY);
        rowY += row.title ? 39 : 33;
      }
      if (!row.title) rowY += 10;
    }
    y += cardHeight + 14;
  }
  if (!entries.length) {
    context.fillStyle = "#60736e";
    context.font = `400 25px ${font}`;
    context.fillText("No scheduled entries for this day.", 52, 238);
  }
  context.fillStyle = "#8b9993";
  context.font = `400 17px ${font}`;
  context.fillText("Day Planner", 52, height - 48);
  return { width: canvas.width, height: canvas.height };
}
