import { describe, expect, it } from "vitest";
import {
  canonicalTaskUrl,
  formatTaskLink,
  taskLinkIdentity,
  taskLinkUrl,
} from "../src/tasks/weak-links";

describe("weak task links", () => {
  it("canonicalizes supported aliases as the same identity", () => {
    expect(canonicalTaskUrl("https://todoist.com/showTask?id=abc-1")).toBe(
      "https://app.todoist.com/app/task/abc-1",
    );
    expect(
      taskLinkUrl(
        "[one](https://todoist.com/showTask?id=abc-1) [two](https://app.todoist.com/app/task/abc-1)",
      ),
    ).toBe("https://app.todoist.com/app/task/abc-1");
  });
  it("rejects ambiguous and unsafe links", () => {
    expect(
      taskLinkIdentity(
        "[a](https://app.todoist.com/app/task/a) [b](https://app.todoist.com/app/task/b)",
      ),
    ).toBeUndefined();
    expect(
      canonicalTaskUrl("https://app.todoist.com.evil.test/app/task/a"),
    ).toBeUndefined();
    expect(canonicalTaskUrl("http://todoist.com/app/task/a")).toBeUndefined();
    expect(
      canonicalTaskUrl("https://u@todoist.com/app/task/a"),
    ).toBeUndefined();
  });
  it("round trips occurrence tooltip", () => {
    expect(taskLinkIdentity(formatTaskLink("abc", "2026-11-14"))).toEqual({
      url: "https://app.todoist.com/app/task/abc",
      taskId: "abc",
      occurrence: "2026-11-14",
    });
  });
});
