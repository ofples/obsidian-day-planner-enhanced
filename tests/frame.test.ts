import { expect, test } from "vitest";

import {
  calendarFrameChild,
  frameDropWarning,
  frameHeading,
  frameState,
  renameCalendarFrameChild,
} from "../src/tasks/frame";

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

test("one direct child supplies the frame heading and retains descriptions and labels", () => {
  const block = {
    text: "09:00 Karma #frame #locked #karma\nParent instructions",
    children: [
      { text: "09:10 - 09:20 Mop the floor #karma #urgent\nBring the mop" },
    ],
  };
  expect(frameHeading(block)).toBe(
    "Mop the floor #frame #locked #karma #urgent\nParent instructions\nBring the mop",
  );
  expect(frameHeading({ ...block, children: [] })).toBe(block.text);
  expect(
    frameHeading({
      ...block,
      children: [...block.children, { text: "Other task" }],
    }),
  ).toBe(block.text);
  expect(
    frameHeading({ text: "A `#frame` example", children: block.children }),
  ).toBe("A `#frame` example");
});

test("Google frame titles count direct children and preserve child metadata during a rename", () => {
  const subtasks =
    '- [x] 09:10 - 09:20 Mop #karma [🔗](https://app.todoist.com/app/task/abc "Todoist occurrence=1") <!-- private --> ^anchor\n  - [ ] Grandchild';
  const value = { tags: ["frame"], subtasks };
  expect(calendarFrameChild(value)?.title).toBe("Mop");
  const changed = renameCalendarFrameChild(value, "Buy supplies");
  expect(changed).toContain(
    '- [x] 09:10 - 09:20 Buy supplies #karma [🔗](https://app.todoist.com/app/task/abc "Todoist occurrence=1") <!-- private --> ^anchor',
  );
  expect(changed).toContain("\n  - [ ] Grandchild");
  expect(
    calendarFrameChild({ ...value, subtasks: "- [ ] One\n- [ ] Two" }),
  ).toBeUndefined();
  expect(calendarFrameChild({ tags: ["framework"], subtasks })).toBeUndefined();
});
