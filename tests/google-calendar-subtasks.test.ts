import { describe, expect, test } from "vitest";

import {
  renderSubtasks,
  subtasksEnd,
  subtasksStart,
  withSubtasks,
} from "../src/google-calendar/subtasks";

describe("Google Calendar subtask descriptions", () => {
  test("renders nested tasks, completion, links and child times without the parent or private metadata", () => {
    const raw =
      "- [ ] 09:00 - 10:00 Parent ^parent\r\n" +
      "    - [ ] Call [[Project|team]] & review [notes](https://example.com) ^child\r\n" +
      "        - [x] 09:15 - 09:30 Done <!-- private -->\r\n" +
      "    - [-] Waiting\r\n" +
      "    - Plain bullet\r\n" +
      "\r\n        3. Third step";
    expect(renderSubtasks(raw)).toBe(
      "<b>Subtasks</b><ul>" +
        "<li>☐ Call team &amp; review notes<ul><li>☑ 09:15 - 09:30 Done</li></ul></li>" +
        '<li>[-] Waiting</li><li>Plain bullet<ol start="3"><li>Third step</li></ol></li></ul>',
    );
  });
  test("escapes user text for the HTML description", () => {
    expect(
      renderSubtasks('- [ ] Parent\n  - [ ] Compare 1 < 2 & "three"'),
    ).toContain("☐ Compare 1 &lt; 2 &amp; &quot;three&quot;");
  });
  test("has no section for a block with no nested lists", () => {
    expect(renderSubtasks("- [ ] Parent\n\n  A paragraph")).toBe("");
    expect(renderSubtasks("plain text")).toBe("");
  });
  test("preserves existing HTML and updates only the owned section without duplicates", () => {
    const original =
      '<p>Existing <a href="https://example.com">details</a></p>';
    const first = withSubtasks(
      original,
      "<b>Subtasks</b><ul><li>First</li></ul>",
    );
    expect(first).toBe(
      `${original}${subtasksStart}<br><br><b>Subtasks</b><ul><li>First</li></ul>${subtasksEnd}`,
    );
    expect(
      withSubtasks(first, "<b>Subtasks</b><ul><li>First</li></ul>", true),
    ).toBe(first);
    const updated = withSubtasks(first + "<p>Added after</p>", "Updated", true);
    expect(updated).toBe(
      `${original}${subtasksStart}<br><br>Updated${subtasksEnd}<p>Added after</p>`,
    );
    expect(withSubtasks(updated, "", true)).toBe(
      original + "<p>Added after</p>",
    );
    expect(withSubtasks(original, "")).toBe(original);
  });
  test("refuses damaged sections while allowing a fully removed section to be recreated", () => {
    for (const damaged of [
      subtasksStart,
      subtasksEnd,
      subtasksEnd + subtasksStart,
      subtasksStart + subtasksStart + subtasksEnd,
      subtasksStart + subtasksEnd + subtasksEnd,
    ]) {
      expect(() => withSubtasks(damaged, "new")).toThrow("subtask section");
    }
    expect(() =>
      withSubtasks("<b>Subtasks</b><ul><li>Old</li></ul>", "new", true),
    ).toThrow("subtask section");
    expect(withSubtasks("", "new", true)).toBe(
      `${subtasksStart}new${subtasksEnd}`,
    );
  });
});
