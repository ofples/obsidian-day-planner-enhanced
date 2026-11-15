import { expect, test } from "vitest";

import { frameDropWarning, frameState } from "../src/tasks/frame";

test("only a real frame tag highlights an empty container", () => {
  expect(frameState({ text: "09:00 Admin #frame #karma" })).toMatchObject({
    frame: true,
    empty: true,
  });
  expect(frameState({ text: "Admin `#frame`" }).frame).toBe(false);
  expect(frameState({ text: "Admin #framework" }).frame).toBe(false);
  expect(
    frameState({ text: "Admin #frame", children: [{ text: "Task" }] }).warning,
  ).toBe("");
});

test("matching labels work for checkbox and bullet parents", () => {
  for (const parent of [
    "- [ ] Admin #frame #karma #locked",
    "- 09:00 Admin #frame #karma",
  ]) {
    expect(frameDropWarning(parent, "- [ ] Mop #karma")).toBeUndefined();
    expect(frameDropWarning(parent, "- [ ] Report #work")).toContain("#karma");
  }
});

test("every frame category is required and control tags are ignored", () => {
  expect(
    frameDropWarning(
      "Admin #frame #karma #urgent #todoist",
      "Mop #karma #urgent",
    ),
  ).toBeUndefined();
  expect(
    frameDropWarning("Admin #frame #karma #urgent", "Mop #urgent"),
  ).toContain("#karma and #urgent");
  expect(frameDropWarning("Admin #frame #locked", "Anything")).toBeUndefined();
  expect(frameDropWarning("Admin #karma", "Anything")).toBeUndefined();
});

test("Markdown label mismatches stay visible after adding a child", () => {
  expect(
    frameState({
      text: "Admin #frame #karma",
      children: [{ text: "Report #work" }],
    }),
  ).toMatchObject({ empty: false, warning: expect.stringContaining("labels") });
  expect(frameDropWarning("Admin #frame #karma", "Mop `#karma`")).toBeTruthy();
});
