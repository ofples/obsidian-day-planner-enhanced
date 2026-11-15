import { describe, expect, it } from "vitest";
import moment from "moment";
import { detectIndentation } from "../src/util/markdown";
import { indentTaskSubtree } from "../src/tasks/schedule-markdown";
import { renderBlock } from "../src/google-calendar/markdown";
import { defaultSettings } from "../src/settings";
import { fromMarkdown } from "../src/mdast/mdast";

describe("note indentation", () => {
  it.each(["  ", "    ", "\t"])(
    "detects an existing %j nesting step",
    (step) => {
      expect(
        detectIndentation(
          `- Parent\n${step}- Child\n${step}${step}- Grandchild`,
        ),
      ).toBe(step);
    },
  );
  it("ignores frontmatter, comments and fenced examples when detecting nesting", () => {
    const note = [
      "---",
      "example:",
      "- YAML",
      "    - Nested",
      "---",
      "%%",
      "- Comment",
      "    - Nested",
      "%%",
      "<!--",
      "- HTML",
      "    - Nested",
      "-->",
      "```md",
      "- Example",
      "    - Nested",
      "```",
      "- Parent",
      "  - Child",
    ].join("\n");
    expect(detectIndentation(note)).toBe("  ");
  });
  it("uses two spaces when a note has no nested list", () =>
    expect(detectIndentation("- Parent")).toBe("  "));
  it("translates a moved subtree to the destination style at all depths", () => {
    expect(
      indentTaskSubtree(
        "- [ ] Parent\n  - [ ] Child\n    - [ ] Grandchild",
        "",
        "\t",
        "\n",
        "\t",
      ),
    ).toBe("\t- [ ] Parent\n\t\t- [ ] Child\n\t\t\t- [ ] Grandchild");
  });
  it.each(["  ", "    ", "\t"])(
    "renders Google descriptions and nested tasks with %j",
    (step) => {
      Object.assign(window, { moment });
      const snapshot = {
        start: "2026-11-15T09:00:00+05:30",
        end: "2026-11-15T10:00:00+05:30",
        title: "Plan",
        description: "Details",
        subtasks: "- [ ] Child\n  - [ ] Grandchild",
      };
      const raw = renderBlock(
        "uid",
        snapshot,
        defaultSettings,
        undefined,
        `- Existing\n${step}- Child`,
      );
      expect(raw).toContain(
        `\n${step}Details\n${step}- [ ] Child\n${step}${step}- [ ] Grandchild`,
      );
      const parent = fromMarkdown(raw).children[0];
      expect(parent?.type).toBe("list");
      if (parent?.type === "list")
        expect(
          parent.children[0]?.children.some((node) => node.type === "list"),
        ).toBe(true);
    },
  );
});

describe("Google canonical indentation", () => {
  it("treats equivalent nested list indentation as equal", async () => {
    const { sameCanonicalSnapshot } = await import(
      "../src/google-calendar/types"
    );
    const base = {
      start: "2026-11-15T09:00:00+05:30",
      end: "2026-11-15T10:00:00+05:30",
      title: "Plan",
    };
    expect(
      sameCanonicalSnapshot(
        { ...base, subtasks: "- Child\n  - Grandchild" },
        { ...base, subtasks: "- Child\n\t- Grandchild" },
      ),
    ).toBe(true);
  });
  it("round trips multi-line descriptions and nested tasks using tabs", async () => {
    const { normalizeLocalSnapshot } = await import(
      "../src/google-calendar/markdown"
    );
    Object.assign(window, { moment });
    const input = {
      start: "2026-11-15T09:00:00+05:30",
      end: "2026-11-15T10:00:00+05:30",
      title: "Plan",
      description: "First\nSecond",
      subtasks: "- Child\n  - Grandchild",
    };
    const raw = renderBlock(
      "uid",
      input,
      defaultSettings,
      undefined,
      "- Other\n\t- Child",
    );
    const local = normalizeLocalSnapshot({
      uid: "uid",
      path: "note.md",
      raw,
      snapshot: input,
    });
    expect(local.description).toBe(input.description);
    const { sameCanonicalSnapshot } = await import(
      "../src/google-calendar/types"
    );
    expect(sameCanonicalSnapshot(local, input)).toBe(true);
  });
});
