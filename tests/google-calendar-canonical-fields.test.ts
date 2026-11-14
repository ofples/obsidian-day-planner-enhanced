import { describe, expect, test } from "vitest";
import {
  canonicalSnapshotOf,
  sameCanonicalSnapshot,
  type GoogleEvent,
} from "../src/google-calendar/types";
import { normalizeLocalSnapshot } from "../src/google-calendar/markdown";
import {
  plainCalendarDescription,
  readPlainCalendarDescription,
  structuredDescription,
} from "../src/google-calendar/subtasks";
import { renderBlock } from "../src/google-calendar/markdown";
import { defaultSettings } from "../src/settings";
import moment from "moment";

const times = {
  title: "Plan",
  start: "2026-11-14T09:00:00Z",
  end: "2026-11-14T10:00:00Z",
};
const event = (description: string, tags: string[]): GoogleEvent => ({
  id: "id",
  etag: "etag",
  summary: "Plan",
  start: { dateTime: times.start },
  end: { dateTime: times.end },
  description,
  extendedProperties: {
    private: {
      dayPlannerTags: JSON.stringify(tags),
      dayPlannerSchemaVersion: "3",
    },
  },
});

describe("canonical Calendar fields", () => {
  test("keeps a blank Google summary and rejects non-list subtasks", () => {
    const remote = event(structuredDescription("", [], ""), []);
    expect(canonicalSnapshotOf({ ...remote, summary: undefined })?.title).toBe(
      "",
    );
    expect(() =>
      canonicalSnapshotOf({
        ...remote,
        description:
          "--- Day Planner fields ---\nTags:\nSubtasks:\nNot a list\n--- End Day Planner fields ---",
      }),
    ).toThrow("Markdown list");
  });
  test("parses editable tags and nested checkbox Markdown with freeform description", () => {
    const description = structuredDescription(
      "Bring notes",
      ["work"],
      "- [x] Done\n  - [ ] Next",
    );
    expect(canonicalSnapshotOf(event(description, ["work"]))).toEqual({
      ...times,
      start: new Date(times.start).toISOString(),
      end: new Date(times.end).toISOString(),
      tags: ["work"],
      subtasks: "- [x] Done\n  - [ ] Next",
      description: "Bring notes",
      colorId: null,
      taskUrl: null,
    });
  });

  test("reconciles metadata and editable tag line against baseline", () => {
    const base = { ...times, tags: ["old"] };
    expect(
      canonicalSnapshotOf(
        event(structuredDescription("", ["old"], ""), ["new"]),
        base,
      )?.tags,
    ).toEqual(["new"]);
    expect(
      canonicalSnapshotOf(
        event(structuredDescription("", ["new"], ""), ["old"]),
        base,
      )?.tags,
    ).toEqual(["new"]);
    expect(() =>
      canonicalSnapshotOf(
        event(structuredDescription("", ["one"], ""), ["two"]),
        base,
      ),
    ).toThrow("two different places");
  });

  test("extracts parent tags, preserving child hierarchy and checkbox states", () => {
    const raw = "- 09:00 - 10:00 Plan #work\n  - [x] Done\n    - [ ] Next";
    const snapshot = normalizeLocalSnapshot({
      uid: "a",
      path: "fixture.md",
      raw,
      snapshot: { ...times, title: "Plan #work" },
    });
    expect(snapshot.title).toBe("Plan");
    expect(snapshot.tags).toEqual(["work"]);
    expect(snapshot.subtasks).toBe("- [x] Done\n  - [ ] Next");
    expect(
      sameCanonicalSnapshot(snapshot, { ...snapshot, colorId: null }),
    ).toBe(true);
  });

  test("renders a remote edit without losing unrelated parent text", () => {
    Object.assign(window, { moment });
    const previous =
      "- [ ] 09:00 - 10:00 Plan #old\n  Extra local text\n  - [ ] Before";
    const input = {
      ...times,
      tags: ["new"],
      subtasks: "- [x] Done\n  - [ ] Next",
      description: "Bring notes\nSecond line",
    };
    const raw = renderBlock("uid", input, defaultSettings, previous);
    expect(raw).not.toContain("Extra local text");
    expect(raw).not.toContain("Before");
    const decoded = normalizeLocalSnapshot({
      uid: "uid",
      path: "fixture.md",
      raw,
      snapshot: input,
    });
    expect(decoded.tags).toEqual(input.tags);
    expect(decoded.description).toBe(input.description);
    expect(decoded.subtasks).toBe(input.subtasks);
  });

  test("clean Google descriptions preserve prose and editable nested checklist", () => {
    const body = plainCalendarDescription(
      "Notes\n> Quoted",
      "- [ ] First\n  - [x] Nested",
      "https://app.todoist.com/app/task/abc",
    );
    expect(body).not.toContain("Day Planner fields");
    expect(body).toContain("⬜ First\n  ✅ Nested");
    expect(readPlainCalendarDescription(body)).toEqual({
      description: "Notes\n> Quoted",
      subtasks: "- [ ] First\n  - [x] Nested",
      taskUrl: "https://app.todoist.com/app/task/abc",
    });
  });
  test("plain non-checkbox list children survive a Google round trip", () => {
    const body = plainCalendarDescription(
      "Notes",
      "- First\n  continuation\n  - Nested",
    );
    expect(readPlainCalendarDescription(body)).toEqual({
      description: "Notes",
      subtasks: "- First\n  continuation\n  - Nested",
      taskUrl: null,
    });
  });

  test("reads natural indented prose and authored blockquotes without reserved headings", () => {
    const raw =
      "- [ ] 09:00 - 10:00 Plan\n  First line\n  > Authored quote\n  - [ ] Child";
    const local = normalizeLocalSnapshot({
      uid: "a",
      path: "fixture.md",
      raw,
      snapshot: times,
    });
    expect(local.description).toBe("First line\n> Authored quote");
    expect(local.subtasks).toBe("- [ ] Child");
  });
  test("keeps a Todoist link out of the title and preserves its occurrence marker on a Google pull", () => {
    const previous =
      '- [ ] 09:00 - 10:00 Plan [🔗](https://app.todoist.com/app/task/abc "Todoist occurrence=2026-11-14")\n  Notes';
    const local = normalizeLocalSnapshot({
      uid: "a",
      path: "fixture.md",
      raw: previous,
      snapshot: times,
    });
    expect(local.title).toBe("Plan");
    expect(local.taskUrl).toBe("https://app.todoist.com/app/task/abc");
    const changed = renderBlock(
      "a",
      { ...local, title: "Renamed" },
      defaultSettings,
      previous,
    );
    expect(changed).toContain('"Todoist occurrence=2026-11-14"');
    expect(
      normalizeLocalSnapshot({
        uid: "a",
        path: "fixture.md",
        raw: changed,
        snapshot: { ...times, title: "Renamed" },
      }).taskUrl,
    ).toBe(local.taskUrl);
  });
});
