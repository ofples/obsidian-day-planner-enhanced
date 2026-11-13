import { describe, expect, test } from "vitest";
import {
  isCalendarDateInScope,
  isCalendarNoteEnabled,
} from "../src/google-calendar/scope";

describe("calendar sync scope", () => {
  const snapshot = (date: string) => ({
    title: "Task",
    start: window.moment(`${date} 09:00`).toISOString(),
    end: window.moment(`${date} 10:00`).toISOString(),
  });
  test("includes the cutover day and later without changing the legacy blank default", () => {
    expect(isCalendarDateInScope(snapshot("2026-11-13"), "2026-11-14")).toBe(
      false,
    );
    expect(isCalendarDateInScope(snapshot("2026-11-14"), "2026-11-14")).toBe(
      true,
    );
    expect(isCalendarDateInScope(snapshot("2026-11-13"), "")).toBe(true);
    expect(isCalendarDateInScope(snapshot("2026-11-14"), "2026-02-30")).toBe(
      false,
    );
  });
  test.each(["off", "false", "'off'", '"false"', "OFF # explanation"])(
    "excludes top-level sync: %s",
    (value) => {
      expect(isCalendarNoteEnabled(`---\nsync: ${value}\n---\n# Note`)).toBe(
        false,
      );
    },
  );
  test("does not interpret nested keys or ordinary note content as frontmatter", () => {
    expect(isCalendarNoteEnabled("---\nother:\n  sync: off\n---\n# Note")).toBe(
      true,
    );
    expect(isCalendarNoteEnabled("# Note\nsync: off")).toBe(true);
    expect(isCalendarNoteEnabled("---\nsync: true\n---\n")).toBe(true);
    expect(isCalendarNoteEnabled("---\nsync: off\n")).toBe(false);
  });
});
