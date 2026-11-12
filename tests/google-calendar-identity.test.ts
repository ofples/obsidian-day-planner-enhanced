import { describe, expect, test } from "vitest";
import {
  resolveIdentities,
  type IdentityCandidate,
} from "../src/google-calendar/identity";
import type { LocalIdentity } from "../src/google-calendar/types";

const block = (
  title: string,
  from = 0,
  start = "09:00",
  end = "10:00",
): LocalIdentity => ({
  path: "Daily/2026-11-11.md",
  from,
  raw: `- [ ] ${start} - ${end} ${title}`,
  snapshot: {
    title,
    start: `2026-11-11T${start}:00Z`,
    end: `2026-11-11T${end}:00Z`,
  },
});
const candidate = (value: LocalIdentity): IdentityCandidate => ({
  ...value,
  eligible: true,
});

describe("external calendar identity", () => {
  test("a cross-day move with normalized nested indentation keeps its event identity", () => {
    const old = {
      ...block("Work"),
      raw: "- [ ] 09:00 - 10:00 Work\n  - [ ] Child",
    };
    const next = candidate({
      ...block("Work", 20, "10:00", "11:00"),
      path: "Daily/2026-11-12.md",
      raw: "- [ ] 10:00 - 11:00 Work\n    - [ ] Child",
    });
    resolveIdentities([next], { original: old });
    expect(next.uid).toBe("original");
  });

  test("reordering retains exact block identities", () => {
    const previous = { first: block("First"), second: block("Second", 40) };
    const next = [candidate(block("Second")), candidate(block("First", 50))];
    resolveIdentities(next, previous);
    expect(next.map((item) => item.uid)).toEqual(["second", "first"]);
  });
  test("a time change matches the unique title after surrounding edits", () => {
    const previous = { first: block("First") };
    const edited = candidate({
      ...block("First", 99),
      raw: "- [ ] 11:00 - 12:00 First",
      snapshot: {
        ...block("First").snapshot,
        start: "2026-11-11T11:00:00Z",
        end: "2026-11-11T12:00:00Z",
      },
    });
    resolveIdentities([edited], previous);
    expect(edited.uid).toBe("first");
  });
  test("simultaneous renames to the same title retain IDs through time range and start", () => {
    const previous = {
      first: block("First", 0, "19:30", "20:00"),
      second: block("Second", 80, "20:30", "20:45"),
    };
    const next = [
      candidate(block("Renamed", 0, "19:30", "20:00")),
      candidate(block("Renamed", 100, "20:30", "21:00")),
    ];
    resolveIdentities(next, previous);
    expect(next.map((item) => item.uid)).toEqual(["first", "second"]);
  });
  test("reordering and swapping time ranges keeps each unique title linked", () => {
    const previous = {
      first: block("First"),
      second: block("Second", 40, "10:00", "11:00"),
    };
    const next = [
      candidate(block("Second")),
      candidate(block("First", 60, "10:00", "11:00")),
    ];
    resolveIdentities(next, previous);
    expect(next.map((item) => item.uid)).toEqual(["second", "first"]);
  });
  test("repeated titles use unique time evidence when one occurrence is resized", () => {
    const previous = {
      first: block("Same"),
      second: block("Same", 40, "10:00", "11:00"),
    };
    const next = [
      candidate(block("Same", 0, "10:30", "11:00")),
      candidate(block("Same", 60, "09:00", "09:30")),
    ];
    resolveIdentities(next, previous);
    expect(next.map((item) => item.uid)).toEqual(["second", "first"]);
  });
  test("identical copies keep existing IDs in order as copies are added or removed", () => {
    const previous = { second: block("Same", 60), first: block("Same") };
    const added = [0, 50, 100].map((from) => candidate(block("Same", from)));
    resolveIdentities(added, previous);
    expect(added.map((item) => item.uid)).toEqual([
      "first",
      "second",
      undefined,
    ]);
    const removed = [candidate(block("Same"))];
    resolveIdentities(removed, previous);
    expect(removed[0]?.uid).toBe("first");
  });
  test("fully changed blocks stay unmatched even at the same position", () => {
    const previous = { first: block("First"), second: block("Second", 80) };
    const next = [
      candidate({
        ...block("New one"),
        snapshot: {
          title: "New one",
          start: "2026-11-12T03:00:00Z",
          end: "2026-11-12T04:00:00Z",
        },
      }),
      candidate({
        ...block("New two", 80),
        snapshot: {
          title: "New two",
          start: "2026-11-12T05:00:00Z",
          end: "2026-11-12T06:00:00Z",
        },
      }),
    ];
    resolveIdentities(next, previous);
    expect(next.map((item) => item.uid)).toEqual([undefined, undefined]);
    resolveIdentities(next.slice(0, 1), { first: previous.first });
    expect(next[0]?.uid).toBeUndefined();
  });
});
