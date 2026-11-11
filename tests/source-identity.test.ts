import { describe, expect, test, vi } from "vitest";

import {
  resolveSourceIdentities,
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
