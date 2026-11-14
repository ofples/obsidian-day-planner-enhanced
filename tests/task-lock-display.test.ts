import { expect, test } from "vitest";
import { withoutDisplayedLockTags } from "../src/util/task-lock";

test("hides real lock tags in rendered text without hiding code or ordinary links", () => {
  expect(
    withoutDisplayedLockTags("Work #locked #project\n- [ ] Child #LOCKED"),
  ).toBe("Work #project\n- [ ] Child");
  expect(
    withoutDisplayedLockTags("`#locked` [docs](https://example.com/#locked)"),
  ).toBe("`#locked` [docs](https://example.com/#locked)");
});
