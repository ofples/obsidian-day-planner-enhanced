import { describe, expect, test, vi } from "vitest";

import { parseCaptureCandidates } from "../src/tasks/capture-parser";

import {
  resolveSourceIdentities,
  sameScheduledSource,
  type SourceIdentity,
} from "../src/service/source-identity";

const source = (path: string, raw: string, from: number) => ({
  path,
  raw,
  from,
});
const options = {
  duplicate: "Duplicate link",
  ambiguous: (path: string) => `Ambiguous in ${path}`,
  matchers: [],
};

describe("shared source identities", () => {
  test("a moved and reserialized schedule preserves all child identities in order", () => {
    const old =
      "- [ ] 09:00 - 10:00 Work #todoist\n  - [ ] Same\n    - [ ] Deep\n  - [ ] Same";
    const nextText =
      "- [ ] 10:00 - 11:00 Work #todoist\n    - [ ] Same\n        - [ ] Deep\n    - [ ] Same";
    const previous = Object.fromEntries(
      parseCaptureCandidates("Old.md", old).map((candidate, index) => [
        String(index),
        candidate,
      ]),
    );
    const next = parseCaptureCandidates("New.md", nextText);
    resolveSourceIdentities(next, previous, {
      ...options,
      preserveNested: true,
      matchers: [sameScheduledSource],
    });
    expect(next.map((candidate) => candidate.uid)).toEqual([
      "0",
      "1",
      "2",
      "3",
    ]);
  });

  test.each([
    [
      "- [ ] 09:00 - 10:00 Work\n  - [ ] First",
      "- [ ] 10:00 - 11:00 Work\n    - [ ] Changed",
    ],
    ["- [ ] 09:00 - 10:00 Work", "- [x] 10:00 - 11:00 Work"],
    ["- [ ] 09:00 - 10:00 #work", "- [ ] 10:00 - 11:00 #work"],
    ["- [ ] Work", "- [ ] 10:00 - 11:00 Work"],
    [
      "- [ ] 09:00 - 10:00 Work\n  - [ ] First\n  - [ ] Second",
      "- [ ] 10:00 - 11:00 Work\n    - [ ] Second\n    - [ ] First",
    ],
  ])(
    "different content supplies no cross-note identity evidence",
    (old, next) => {
      expect(
        sameScheduledSource(
          source("Old.md", old, 0),
          source("New.md", next, 0),
        ),
      ).toBe(false);
    },
  );

  test("two equivalent moved blocks remain unassigned", () => {
    const old = source("Old.md", "- [ ] 09:00 - 10:00 Work", 0);
    const next = parseCaptureCandidates(
      "New.md",
      "- [ ] 10:00 - 11:00 Work\n\n- [ ] 11:00 - 12:00 Work",
    );
    resolveSourceIdentities(
      next,
      { old },
      { ...options, matchers: [sameScheduledSource] },
    );
    expect(next.every((candidate) => !candidate.uid)).toBe(true);
  });

  test("exact-only matching scopes known containers and leaves moved or edited sources unassigned", () => {
    const parent = "- [ ] Parent\n  - [ ] Same";
    const saved = parseCaptureCandidates("Known.md", parent);
    const previous = {
      parent: saved[0]!,
      child: saved[1]!,
      moving: source("Old.md", "- [ ] Moving", 0),
      edited: source("Edited.md", "- [ ] Original", 0),
    };
    const candidates = [
      ...parseCaptureCandidates("Known.md", parent),
      ...parseCaptureCandidates("New.md", "- [ ] Moving"),
      ...parseCaptureCandidates("Edited.md", "- [ ] Changed"),
    ];
    resolveSourceIdentities(candidates, previous, {
      ...options,
      preserveNested: true,
      exactOnly: true,
    });
    expect(candidates.map((candidate) => candidate.uid)).toEqual([
      "parent",
      "child",
      undefined,
      undefined,
    ]);
  });

  test.each(["reorder", "move", "preassigned", "partial-edit"])(
    "nested identities follow exact parent blocks through %s",
    (scenario) => {
      const earlier = "- [x] Earlier\n  - [ ] Same\n    - [ ] Deep";
      const current = "- [ ] Current\n  - [ ] Same\n    - [ ] Deep";
      const previous = Object.fromEntries(
        parseCaptureCandidates("Tasks.md", earlier + "\n\n" + current).map(
          (candidate, index) => [String(index), candidate],
        ),
      );
      const movedCurrent =
        scenario === "partial-edit"
          ? current.replace("Current", "Changed current")
          : current;
      const next = parseCaptureCandidates(
        scenario === "move" ? "Moved.md" : "Tasks.md",
        movedCurrent + "\n\n" + earlier,
      );
      if (scenario === "preassigned") next[3]!.uid = "0";
      const onAmbiguous = vi.fn();
      resolveSourceIdentities(next, previous, {
        ...options,
        preserveNested: true,
        onAmbiguous,
      });
      expect(next.map((candidate) => candidate.uid)).toEqual([
        scenario === "partial-edit" ? undefined : "3",
        "4",
        "5",
        "0",
        "1",
        "2",
      ]);
      if (scenario === "partial-edit")
        expect(onAmbiguous).toHaveBeenCalledExactlyOnceWith("Tasks.md", ["3"]);
    },
  );

  test("changed parents reserve ambiguous identical children for review", () => {
    const text = "- [ ] First\n  - [ ] Same\n\n- [ ] Second\n  - [ ] Same";
    const previous = Object.fromEntries(
      parseCaptureCandidates("Tasks.md", text).map((candidate, index) => [
        String(index),
        candidate,
      ]),
    );
    const next = parseCaptureCandidates(
      "Tasks.md",
      "- [ ] Changed second\n  - [ ] Same\n\n- [ ] Changed first\n  - [ ] Same",
    );
    const onAmbiguous = vi.fn();
    resolveSourceIdentities(next, previous, {
      ...options,
      preserveNested: true,
      onAmbiguous,
    });
    expect(next.map((candidate) => candidate.uid)).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
    expect(onAmbiguous).toHaveBeenCalledExactlyOnceWith("Tasks.md", [
      "0",
      "1",
      "2",
      "3",
    ]);
  });

  test("matched edited parents retain identical children within their own scopes", () => {
    const first = "- [ ] 08:00 - 08:30 First\n  - [ ] Same\n  - [ ] Same";
    const second = "- [ ] 09:00 - 09:30 Second\n  - [ ] Same";
    const previous = Object.fromEntries(
      parseCaptureCandidates("Tasks.md", first + "\n\n" + second).map(
        (candidate, index) => [String(index), candidate],
      ),
    );
    const next = parseCaptureCandidates(
      "Tasks.md",
      second.replace("09:00 - 09:30", "10:00 - 10:30") +
        "\n\n" +
        first.replace("- [ ] 08:00 - 08:30", "- [x] 11:00 - 11:30"),
    );
    resolveSourceIdentities(next, previous, {
      ...options,
      preserveNested: true,
      matchers: [(old, candidate) => old.title === candidate.title],
    });
    expect(next.map((candidate) => candidate.uid)).toEqual([
      "3",
      "4",
      "0",
      "1",
      "2",
    ]);
  });

  test("copied parent blocks retain their original nested IDs for review", () => {
    const text = "- [ ] Parent\n  - [ ] Same";
    const previous = Object.fromEntries(
      parseCaptureCandidates("Tasks.md", text).map((candidate, index) => [
        String(index),
        candidate,
      ]),
    );
    const next = parseCaptureCandidates("Tasks.md", text + "\n\n" + text);
    const onAmbiguous = vi.fn();
    resolveSourceIdentities(next, previous, {
      ...options,
      preserveNested: true,
      onAmbiguous,
    });
    expect(next.every((candidate) => !candidate.uid)).toBe(true);
    expect(onAmbiguous).toHaveBeenCalledExactlyOnceWith("Tasks.md", ["0", "1"]);
  });

  test("strict callers retain their ambiguous-edit rejection", () => {
    expect(() =>
      resolveSourceIdentities(
        [
          source("Tasks.md", "Changed one", 0),
          source("Tasks.md", "Changed two", 20),
        ],
        {
          first: source("Tasks.md", "Old one", 0),
          second: source("Tasks.md", "Old two", 20),
        },
        options,
      ),
    ).toThrow("Ambiguous in Tasks.md");
  });

  test("review callers receive unresolved IDs while safe matches remain assigned", () => {
    const candidates: (SourceIdentity & { uid?: string })[] = [
      source("Tasks.md", "Changed one", 0),
      source("Tasks.md", "Changed two", 20),
      source("Other.md", "Stable", 0),
    ];
    const onAmbiguous = vi.fn();
    resolveSourceIdentities(
      candidates,
      {
        first: source("Tasks.md", "Old one", 0),
        second: source("Tasks.md", "Old two", 20),
        stable: source("Other.md", "Stable", 0),
      },
      { ...options, onAmbiguous },
    );
    expect(onAmbiguous).toHaveBeenCalledExactlyOnceWith("Tasks.md", [
      "first",
      "second",
    ]);
    expect(candidates.map((candidate) => candidate.uid)).toEqual([
      undefined,
      undefined,
      "stable",
    ]);
  });

  test("reports each ambiguous note without claiming a missing link", () => {
    const onAmbiguous = vi.fn();
    resolveSourceIdentities(
      [source("One.md", "Changed one", 5), source("Two.md", "Changed two", 5)],
      {
        one: source("One.md", "Old one", 0),
        two: source("Two.md", "Old two", 0),
        missing: source("Missing.md", "Deleted", 0),
      },
      { ...options, onAmbiguous },
    );
    expect(onAmbiguous.mock.calls).toEqual([
      ["One.md", ["one"]],
      ["Two.md", ["two"]],
    ]);
  });
});
