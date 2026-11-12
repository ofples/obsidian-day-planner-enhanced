import { describe, expect, test } from "vitest";

import { parseCaptureCandidates } from "../src/tasks/capture-parser";
import { findTaskSourceCopies } from "../src/tasks/source-copies";

const raw = "- [ ] Same #todoist";
const old = parseCaptureCandidates("Tasks.md", raw)[0]!;

describe("copied task source detection", () => {
  test("known identities with the same text are distinct until an extra opted-in copy appears", () => {
    const existing = parseCaptureCandidates("Tasks.md", raw + "\n" + raw);
    existing[0]!.uid = "first";
    existing[1]!.uid = "second";
    const previous = { first: existing[0]!, second: existing[1]! };
    expect(findTaskSourceCopies(existing, previous)).toEqual([]);
    const copies = [...existing, ...parseCaptureCandidates("Copy.md", raw)];
    const before = structuredClone(copies);
    expect(findTaskSourceCopies(copies, previous)).toEqual([
      { uids: ["first", "second"], copies },
    ]);
    expect(copies).toEqual(before);
  });

  test("same-note native block IDs expose edited copies", () => {
    const source = parseCaptureCandidates("Tasks.md", raw + " ^native")[0]!;
    const copies = parseCaptureCandidates(
      "Tasks.md",
      source.raw + "\n- [ ] Renamed #todoist ^native",
    );
    copies[0]!.uid = "original";
    expect(
      findTaskSourceCopies(copies, { original: source })[0]?.copies,
    ).toHaveLength(2);
  });

  test("native IDs are scoped to the note and title similarity supplies no copy identity", () => {
    const source = parseCaptureCandidates("Tasks.md", raw + " ^native")[0]!;
    const copies = [
      { ...source, uid: "original" },
      ...parseCaptureCandidates("Other.md", "- [ ] Renamed #todoist ^native"),
    ];
    expect(findTaskSourceCopies(copies, { original: source })).toEqual([]);
  });

  test("line-ending changes preserve exact copy evidence", () => {
    const source = parseCaptureCandidates(
      "Tasks.md",
      raw + "\n  - [ ] Child",
    )[0]!;
    const copies = [
      { ...source, uid: "original" },
      ...parseCaptureCandidates("Copy.md", source.raw.replace(/\n/g, "\r\n")),
    ];
    expect(
      findTaskSourceCopies(copies, { original: source })[0]?.copies,
    ).toHaveLength(2);
  });

  test("a tagless local checklist sharing a child title creates no copy warning", () => {
    const source = parseCaptureCandidates("Tasks.md", "- [ ] Child")[0]!;
    const candidates = [
      { ...source, uid: "child" },
      ...parseCaptureCandidates("Local.md", source.raw),
    ];
    expect(findTaskSourceCopies(candidates, { child: source })).toEqual([]);
  });

  test("copy expansion includes the same occurrence subtree, not a foreign overlapping child", () => {
    const text = "- [ ] Parent #todoist\n  - [ ] Child #todoist";
    const original = parseCaptureCandidates("Tasks.md", text);
    const copy = parseCaptureCandidates("Copy.md", text);
    original[0]!.uid = "root";
    original[1]!.uid = "foreign-child";
    const previous = {
      root: original[0]!,
      child: { ...original[1]!, uid: "child" },
      "foreign-child": { ...original[1]!, uid: "foreign-child" },
    };
    const owners = new Map([
      ["root", "occurrence-a"],
      ["child", "occurrence-a"],
      ["foreign-child", "occurrence-b"],
    ]);
    const groups = findTaskSourceCopies(
      [...original, ...copy],
      previous,
      owners,
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]!.uids.sort()).toEqual(["child", "root"]);
  });

  test("a unique move reuses the existing matcher without a copy group", () => {
    const candidates = parseCaptureCandidates("Moved.md", raw);
    candidates[0]!.uid = "existing";
    expect(findTaskSourceCopies(candidates, { existing: old })).toEqual([]);
  });
});
