import { expect, test } from "vitest";
import { withoutDisplayedControlTags } from "../src/util/task-lock";

test("hides real lock tags in rendered text without hiding code or ordinary links", () => {
  expect(
    withoutDisplayedControlTags(
      "Work #locked #frame #project\n- [ ] Child #LOCKED #FRAME",
    ),
  ).toBe("Work #project\n- [ ] Child");
  expect(
    withoutDisplayedControlTags(
      "`#locked` [docs](https://example.com/#locked)",
    ),
  ).toBe("`#locked` [docs](https://example.com/#locked)");
});
