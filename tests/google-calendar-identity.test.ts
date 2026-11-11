import { describe, expect, test } from "vitest";
import {
  resolveIdentities,
  type IdentityCandidate,
} from "../src/google-calendar/identity";
import type { LocalIdentity } from "../src/google-calendar/types";

const block = (title: string, from = 0): LocalIdentity => ({
  path: "Daily/2026-11-11.md",
  from,
  raw: `- [ ] 09:00 - 10:00 ${title}`,
  snapshot: {
    title,
    start: "2026-11-11T09:00:00Z",
    end: "2026-11-11T10:00:00Z",
  },
});
const candidate = (value: LocalIdentity): IdentityCandidate => ({
  ...value,
  eligible: true,
});

describe("external calendar identity", () => {
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
  test("a changed duplicate count stops instead of assigning the wrong event", () => {
    const previous = { first: block("Same") };
    const next = [candidate(block("Same")), candidate(block("Same", 80))];
    expect(() => resolveIdentities(next, previous)).toThrow("ambiguous");
    expect(next.every((item) => !item.uid)).toBe(true);
  });
  test("ambiguous simultaneous rewrites preserve all existing identities", () => {
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
    expect(() => resolveIdentities(next, previous)).toThrow("ambiguous");
    expect(Object.keys(previous)).toEqual(["first", "second"]);
  });
});
