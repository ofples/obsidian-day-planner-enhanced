import type { Menu } from "obsidian";
import { writable } from "svelte/store";
import { describe, expect, test, vi } from "vitest";

import type { ListItemEntryWithChildren } from "../src/redux/index/index-slice";
import { defaultSettings } from "../src/settings";
import type { TimelineTimeBlock } from "../src/time-block-types";
import { addTimelineViewMenuItems } from "../src/ui/timeline-view-menu";
import {
  createScheduleExportEntries,
  drawScheduleOverview,
  drawSchedulePng,
  exportPlainText,
  filterScheduleExportBlocks,
  schedulePrintHtml,
  wrapExportText,
} from "../src/util/schedule-export";

import { baseTimeBlock } from "./edit/util/fixtures";

const child = (
  id: string,
  text: string,
  task = " ",
): ListItemEntryWithChildren => ({
  id,
  text,
  task,
  symbol: "-",
  path: "Daily/2026-11-11.md",
  position: {
    start: { line: 1, col: 0, offset: 0 },
    end: { line: 1, col: 0, offset: 0 },
  },
  logEntries: [],
  planEntries: [],
});

describe("shareable schedule", () => {
  test.each([drawSchedulePng, drawScheduleOverview])(
    "PNG layouts draw wrapped tag pills and hide control labels",
    (draw) => {
      const written: string[] = [];
      const rectangles: number[][] = [];
      const context = {
        font: "",
        fillStyle: "",
        textBaseline: "",
        strokeStyle: "",
        lineWidth: 1,
        scale: vi.fn(),
        fillRect: vi.fn(),
        beginPath: vi.fn(),
        fill: vi.fn(),
        stroke: vi.fn(),
        moveTo: vi.fn(),
        lineTo: vi.fn(),
        arc: vi.fn(),
        roundRect: (...values: number[]) => rectangles.push(values),
        measureText: (text: string) => ({ width: text.length * 10 }),
        fillText: (text: string) => written.push(text),
      };
      const canvas = {
        getContext: () => context,
        width: 0,
        height: 0,
      } as unknown as HTMLCanvasElement;
      const long = "#" + "a".repeat(300);
      draw(canvas, window.moment("2026-11-17"), [
        {
          time: "09:00",
          title: `Task #karma #frame #locked ${long}`,
          description: ["Details #frame #project"],
          color: "#318779",
          checkbox: true,
          completed: false,
          lines: [
            {
              text: "Child #work #locked",
              depth: 0,
              completed: false,
              checkbox: true,
            },
          ],
        },
      ]);
      expect(written).toContain("#karma");
      expect(written).toContain("#work");
      expect(written).toContain("#project");
      expect(written.join("")).toContain(long);
      expect(written.join(" ")).not.toMatch(/#(?:locked|frame)\b/);
      expect(rectangles.some((rect) => rect[2]! < 700 && rect[3]! > 50)).toBe(
        true,
      );
    },
  );
  test("frame and lock tags are hidden and ordinary tags become pills in both text and child rows", () => {
    const blocks = [
      {
        ...baseTimeBlock,
        text: "Karma #frame #locked #karma",
        children: [child("only", "Mop the floor #karma #locked")],
      },
    ];
    const [entry] = createScheduleExportEntries(blocks, defaultSettings);
    expect(entry?.title).toBe("Mop the floor");
    expect(entry?.tags).toEqual(["#karma"]);
    expect(entry?.lines).toEqual([]);
    const html = schedulePrintHtml(
      window.moment("2026-11-17"),
      [entry!],
      false,
    );
    expect(html).toContain('<span class="tag-pill">#karma</span>');
    expect(html).not.toContain("#frame");
    expect(html).not.toContain("#locked");
  });
  test("exports parent narrative without subtasks and removes the Todoist link", () => {
    const blocks = [
      {
        ...baseTimeBlock,
        text: "09:00 - 10:00 Planning [🔗](https://app.todoist.com/app/task/abc)\nBring the folder\n- [ ] Child task",
        children: [child("child", "Child task")],
      },
    ];
    const [entry] = createScheduleExportEntries(blocks, defaultSettings, false);
    expect(entry?.title).toBe("Planning");
    expect(entry?.description).toEqual(["Bring the folder"]);
    expect(entry?.lines).toEqual([]);
    const pdf = schedulePrintHtml(window.moment("2026-11-11"), [entry!], false);
    expect(pdf).toContain("Bring the folder");
    expect(pdf).not.toContain("Child task");
    expect(pdf).not.toContain("todoist.com");
  });

  test("normalizes RGB and HSL colors safely for PDF cards", () => {
    const entries = [
      "rgb(255, 0, 0)",
      "hsl(120, 100%, 50%)",
      "red; background:url(https://example.com)",
    ].map((color) => ({
      time: "09:00",
      title: "Task",
      color,
      completed: false,
      checkbox: false,
      lines: [],
    }));
    const html = schedulePrintHtml(window.moment("2026-11-11"), entries, true);
    expect(html).toContain("border-color:#ff0000");
    expect(html).toContain("border-color:#00ff00");
    expect(html).not.toContain("example.com");
  });
  test("filters all-day and external events while keeping Todoist previews", () => {
    const remote = {
      id: "remote",
      source: "ical",
      summary: "Remote",
      rsvpStatus: "ACCEPTED",
      calendar: { name: "Calendar", url: "", color: "#123456" },
      startTime: window.moment(),
    } as TimelineTimeBlock;
    const task = {
      ...remote,
      id: "task",
      taskSource: { provider: "todoist", accountId: "a", taskId: "t" },
    } as TimelineTimeBlock;
    const allDay = { ...baseTimeBlock, id: "all", isAllDayEvent: true };
    expect(
      filterScheduleExportBlocks([baseTimeBlock, remote, task, allDay], {
        allDay: false,
        otherCalendars: false,
      }).map((block) => block.id),
    ).toEqual([baseTimeBlock.id, "task"]);
  });

  test("PDF HTML preserves all text safely and has paginated compact cards", () => {
    const html = schedulePrintHtml(
      window.moment("2026-11-11"),
      [
        {
          time: "09:00",
          title: "<script>unsafe</script>",
          color: "#ff0000",
          checkbox: false,
          completed: false,
          lines: [
            { text: "Child & more", depth: 1, checkbox: true, completed: true },
          ],
        },
      ],
      true,
    );
    expect(html).not.toContain("<script>unsafe</script>");
    expect(html).toContain("&lt;script&gt;unsafe&lt;/script&gt;");
    expect(html).toContain("Child &amp; more");
    expect(html).toContain("column-count:3");
    expect(html).toContain("break-inside:avoid");
    expect(html).toContain("default-src 'none'");
  });
  test("overview draws every task and subtask without truncating text", () => {
    const written: string[] = [];
    const context = {
      font: "",
      fillStyle: "",
      textBaseline: "",
      scale: vi.fn(),
      fillRect: vi.fn(),
      beginPath: vi.fn(),
      roundRect: vi.fn(),
      fill: vi.fn(),
      measureText: (text: string) => ({ width: text.length * 10 }),
      fillText: (text: string) => written.push(text),
    };
    const canvas = {
      width: 0,
      height: 0,
      getContext: () => context,
    } as unknown as HTMLCanvasElement;
    const entries = Array.from({ length: 9 }, (_, index) => ({
      time: `0${index}:00`,
      title: `Entry ${index}`,
      color: "#33aa88",
      checkbox: true,
      completed: false,
      lines: [
        { text: `Child ${index}`, depth: 0, checkbox: true, completed: false },
      ],
    }));
    const size = drawScheduleOverview(
      canvas,
      window.moment("2026-11-11"),
      entries,
    );
    for (let index = 0; index < 9; index++) {
      expect(written).toContain(`Entry ${index}`);
      expect(written).toContain(`Child ${index}`);
    }
    expect(size.width).toBeGreaterThan(0);
    expect(size.height).toBeGreaterThan(0);
  });
  test("exports every subtask once, preserves nesting/times, and does not mutate source data", () => {
    const blocks = [
      {
        ...baseTimeBlock,
        text: "09:15 - 09:30 Admin #work\nCall supplier",
        startTime: window.moment("2026-11-11T09:15"),
        durationMinutes: 15,
        children: [
          child("a", "Call supplier"),
          {
            ...child("b", "09:20 - 09:25 Review [[Project|Brief]]", "x"),
            children: [child("c", "Send reply")],
          },
        ],
      },
    ];
    const before = JSON.stringify(blocks);
    const [entry] = createScheduleExportEntries(blocks, defaultSettings);
    expect(entry?.title).toBe("Admin");
    expect(entry?.tags).toEqual(["#work"]);
    expect(entry?.time).toBe("09:15 – 09:30");
    expect(
      entry?.lines.map((line) => [line.text, line.depth, line.completed]),
    ).toEqual([
      ["Call supplier", 0, false],
      ["09:20 - 09:25 Review Brief", 0, true],
      ["Send reply", 1, false],
    ]);
    expect(JSON.stringify(blocks)).toBe(before);
  });
  test("respects hidden child statuses and allows omitting all subtasks", () => {
    const blocks = [
      {
        ...baseTimeBlock,
        children: [child("a", "Visible"), child("b", "Cancelled", "-")],
      },
    ];
    const settings = { ...defaultSettings, hiddenTaskStatuses: ["-"] };
    expect(
      createScheduleExportEntries(blocks, settings)[0]?.lines.map(
        (line) => line.text,
      ),
    ).toEqual(["Visible"]);
    expect(
      createScheduleExportEntries(blocks, settings, false)[0]?.lines,
    ).toEqual([]);
  });
  test("keeps remote and all-day events, sorted before timed entries", () => {
    const remote: TimelineTimeBlock = {
      id: "remote",
      source: "ical",
      summary: "Meeting",
      rsvpStatus: "ACCEPTED",
      calendar: { name: "Work", url: "", color: "#abcdef" },
      startTime: window.moment("2026-11-11T08:00"),
      durationMinutes: 30,
    } as TimelineTimeBlock;
    const blocks = [
      { ...baseTimeBlock, startTime: window.moment("2026-11-11T10:00") },
      remote,
      {
        ...baseTimeBlock,
        id: "all",
        isAllDayEvent: true,
        text: "All-day reminder",
      },
    ];
    const entries = createScheduleExportEntries(blocks, defaultSettings);
    expect(entries[0]?.time).toBe("All day");
    expect(entries[1]).toMatchObject({
      title: "Meeting",
      time: "08:00 – 08:30",
      checkbox: false,
      color: "#abcdef",
    });
  });
  test("removes tracking comments, URLs behind labels, and Markdown syntax from shared text", () => {
    expect(
      exportPlainText(
        "- [ ] **Read** [[Long note|Brief]] and [docs](https://example.com) <!-- dp-gcal:private --> ^anchor",
      ),
    ).toBe("Read Brief and docs");
  });
  test("wraps long text without losing words or breaking emoji sequences", () => {
    const lines = wrapExportText(
      "First second supercalifragilistic 👩‍💻 👨‍👩‍👧‍👦",
      12,
      (text) => Array.from(new Intl.Segmenter().segment(text)).length,
    );
    expect(
      lines.every(
        (line) => Array.from(new Intl.Segmenter().segment(line)).length <= 12,
      ),
    ).toBe(true);
    expect(lines.join("").replace(/\s+/g, "")).toBe(
      "Firstsecondsupercalifragilistic👩‍💻👨‍👩‍👧‍👦",
    );
    expect(lines.some((line) => line.includes("👨‍👩‍👧‍👦"))).toBe(true);
  });
  test("menu exports the currently selected day, with a safe no-selection fallback", () => {
    let selected = window.moment("2026-11-11");
    const callbacks = new Map<string, () => void>();
    const exportSchedule = vi.fn();
    const menu = {
      addItem: (build: (item: unknown) => void) => {
        let title = "";
        const item = {
          setSection: () => item,
          setIcon: () => item,
          setChecked: () => item,
          setDisabled: () => item,
          setTitle: (value: string) => {
            title = value;
            return item;
          },
          onClick: (callback: () => void) => {
            callbacks.set(title, callback);
            return item;
          },
        };
        build(item);
        return menu;
      },
    } as unknown as Menu;
    addTimelineViewMenuItems(menu, {
      exportSchedule,
      getSelectedDay: () => selected,
      openFileForDay: vi.fn(),
      initWeeklyView: vi.fn(),
      openTimelineSettingsModal: vi.fn(),
      reSync: vi.fn(),
      settingsStore: writable(defaultSettings),
    });
    selected = window.moment("2026-11-12");
    callbacks.get("Export schedule…")?.();
    expect(exportSchedule).toHaveBeenCalledWith(selected);
    selected = undefined as never;
    callbacks.get("Export schedule…")?.();
    expect(exportSchedule).toHaveBeenCalledTimes(1);
  });
});
