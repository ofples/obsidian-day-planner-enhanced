import chroma from "chroma-js";
import type { Nodes } from "mdast";

import { fromMarkdown } from "../mdast/mdast";
import { restoreWikilinks } from "../mdast/wikilink";
import type { ListItemEntryWithChildren } from "../redux/index/index-slice";
import type { DayPlannerSettings } from "../settings";
import { stripTaskLink } from "../tasks/weak-links";
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
  description?: string[];
  lines: ScheduleExportLine[];
}

export function filterScheduleExportBlocks(
  blocks: TimelineTimeBlock[],
  options: { allDay: boolean; otherCalendars: boolean },
) {
  return blocks.filter(
    (block) =>
      (options.allDay || !block.isAllDayEvent) &&
      (options.otherCalendars || !isRemote(block) || Boolean(block.taskSource)),
  );
}

function escapeHtml(value: string) {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        character
      ]!,
  );
}

function exportColor(value: string) {
  return chroma.valid(value) ? chroma(value).hex() : "#318779";
}

/** Self-contained print document: no external resources or executable scripts. */
export function schedulePrintHtml(
  day: Moment,
  entries: ScheduleExportEntry[],
  overview: boolean,
) {
  const cards = entries
    .map((entry) => {
      const color = exportColor(entry.color);
      const description = (entry.description ?? [])
        .map((line) => `<div class="description">${escapeHtml(line)}</div>`)
        .join("");
      const children = entry.lines
        .map(
          (line) =>
            `<div class="child" style="margin-left:${Math.min(line.depth, 8) * 12}px">${line.checkbox ? (line.completed ? "☑ " : "☐ ") : "• "}${escapeHtml(line.text)}</div>`,
        )
        .join("");
      return `<article style="border-color:${color}"><div class="time">${escapeHtml(entry.time)}</div><div class="title">${entry.checkbox ? (entry.completed ? "☑ " : "☐ ") : ""}${escapeHtml(entry.title)}</div>${description}${children}</article>`;
    })
    .join("");
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><style>@page{size:A4;margin:12mm}body{font:14px system-ui,sans-serif;color:#203a35;margin:0}h1{font-size:25px;margin:0 0 4px}.date{color:#60736e;margin:0 0 20px}.cards{${overview ? "column-count:3;column-gap:12px" : ""}}article{break-inside:avoid;page-break-inside:avoid;border-left:4px solid;padding:9px 10px;margin:0 0 10px;background:#f3f7f5;overflow-wrap:anywhere}.time{font-size:11px;color:#60736e}.title{font-weight:600;margin:3px 0}.child{font-size:12px;line-height:1.4;margin-top:3px}</style></head><body><h1>${escapeHtml(day.format("dddd"))}</h1><p class="date">${escapeHtml(day.format("D MMMM YYYY"))}</p><div class="cards">${cards || "No scheduled entries for this day."}</div></body></html>`;
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
  const source = markdown
    .replace(/\s\^[\w-]+\s*$/u, "")
    .split(/\r?\n/)
    .map(stripTaskLink)
    .join("\n");
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
    const { listItem, paragraphs } = toRenderableMarkdown(block, {
      hideTasksMetadata: settings.hideTasksMetadata,
    });
    const description = fromMarkdown(paragraphs)
      .children.filter((node) => node.type !== "list")
      .map((node) =>
        exportPlainText(
          paragraphs.slice(
            node.position?.start.offset,
            node.position?.end.offset,
          ),
        ),
      )
      .filter(Boolean);
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
      description,
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
  narrative?: boolean;
}

/** A compact, three-column day view with each subtree kept within its card. */
export function drawScheduleOverview(
  canvas: HTMLCanvasElement,
  day: Moment,
  entries: ScheduleExportEntry[],
) {
  const context = canvas.getContext("2d");
  if (!context)
    throw new Error("This device could not create an image canvas.");
  const width = 1500,
    columnWidth = 462,
    gap = 18,
    font = '"Segoe UI", "Noto Sans", system-ui, sans-serif';
  context.font = `400 19px ${font}`;
  const plans = entries.map((entry) => {
    const rows = [
      {
        text: entry.title,
        depth: 0,
        checkbox: entry.checkbox,
        completed: entry.completed,
        narrative: false,
      },
      ...(entry.description ?? []).map((text) => ({
        text,
        depth: 0,
        checkbox: false,
        completed: false,
        narrative: true,
      })),
      ...entry.lines.map((line) => ({
        ...line,
        depth: line.depth + 1,
        narrative: false,
      })),
    ];
    const wrapped = rows.map((row) => ({
      ...row,
      lines: wrapExportText(
        row.text,
        Math.max(170, columnWidth - 52 - Math.min(row.depth, 7) * 16),
        (text) => context.measureText(text).width,
      ),
    }));
    return {
      entry,
      rows: wrapped,
      height:
        54 + wrapped.reduce((sum, row) => sum + row.lines.length * 25 + 5, 0),
    };
  });
  const total = plans.reduce((sum, plan) => sum + plan.height + gap, 0);
  const target = Math.max(1, Math.ceil(total / 3));
  const columns: (typeof plans)[] = [[], [], []];
  let column = 0,
    used = 0;
  for (const plan of plans) {
    if (column < 2 && used && used + plan.height > target) {
      column++;
      used = 0;
    }
    columns[column]!.push(plan);
    used += plan.height + gap;
  }
  const height =
    190 +
    Math.max(
      100,
      ...columns.map((items) =>
        items.reduce((sum, item) => sum + item.height + gap, 0),
      ),
    ) +
    40;
  if (height > 16000)
    throw new Error(
      "This overview is too long for one PNG. Export as PDF or omit subtasks.",
    );
  const scale = Math.min(
    2,
    16000 / height,
    Math.sqrt(32_000_000 / (width * height)),
  );
  canvas.width = Math.floor(width * scale);
  canvas.height = Math.floor(height * scale);
  context.scale(scale, scale);
  context.textBaseline = "top";
  context.fillStyle = "#f4f6f4";
  context.fillRect(0, 0, width, height);
  context.fillStyle = "#203a35";
  context.font = `600 36px ${font}`;
  context.fillText(day.format("dddd"), 48, 42);
  context.fillStyle = "#60736e";
  context.font = `400 22px ${font}`;
  context.fillText(day.format("D MMMM YYYY"), 48, 92);
  columns.forEach((items, index) => {
    const x = 48 + index * (columnWidth + gap);
    let y = 150;
    for (const plan of items) {
      context.fillStyle = "#fff";
      context.beginPath();
      context.roundRect(x, y, columnWidth, plan.height, 10);
      context.fill();
      context.fillStyle = exportColor(plan.entry.color);
      context.fillRect(x, y + 12, 4, plan.height - 24);
      context.fillStyle = "#60736e";
      context.font = `600 16px ${font}`;
      context.fillText(plan.entry.time, x + 20, y + 14);
      let rowY = y + 42;
      for (const row of plan.rows) {
        context.font = `${row.depth || row.narrative ? "400" : "600"} 19px ${font}`;
        context.fillStyle = row.completed ? "#8b9993" : "#203a35";
        const rowX = x + 20 + Math.min(row.depth, 7) * 16;
        if (row.checkbox)
          context.fillText(row.completed ? "☑" : "☐", rowX, rowY);
        for (const line of row.lines) {
          context.fillText(line, rowX + (row.checkbox ? 24 : 0), rowY);
          rowY += 25;
        }
        rowY += 5;
      }
      y += plan.height + gap;
    }
  });
  if (!entries.length) {
    context.fillStyle = "#60736e";
    context.fillText("No scheduled entries for this day.", 48, 150);
  }
  return { width: canvas.width, height: canvas.height };
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
    for (const text of entry.description ?? [])
      rows.push({
        depth: 0,
        checkbox: false,
        completed: false,
        title: false,
        narrative: true,
        text: wrapExportText(
          text,
          670,
          (value) => context.measureText(value).width,
        ),
      });
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
    context.fillStyle = exportColor(entry.color);
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
      } else if (!row.title && !row.narrative) {
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
