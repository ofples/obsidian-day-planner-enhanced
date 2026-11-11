import type { Menu } from "obsidian";
import { writable } from "svelte/store";
import { describe, expect, test, vi } from "vitest";

import type { ListItemEntryWithChildren } from "../src/redux/index/index-slice";
import { defaultSettings } from "../src/settings";
import type { TimelineTimeBlock } from "../src/time-block-types";
import { addTimelineViewMenuItems } from "../src/ui/timeline-view-menu";
import {
  createScheduleExportEntries,
  exportPlainText,
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
    expect(entry?.title).toBe("Admin #work");
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
    callbacks.get("Export schedule as PNG…")?.();
    expect(exportSchedule).toHaveBeenCalledWith(selected);
    selected = undefined as never;
    callbacks.get("Export schedule as PNG…")?.();
    expect(exportSchedule).toHaveBeenCalledTimes(1);
  });
});
