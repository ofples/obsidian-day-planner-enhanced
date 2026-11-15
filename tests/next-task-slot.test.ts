import { afterEach, expect, test } from "vitest";

import { configureTimestampRegExps } from "../src/regexp";
import { defaultSettingsForTests } from "../src/settings";
import { planNextTaskSlot } from "../src/tasks/next-task-slot";

const settings = { ...defaultSettingsForTests, defaultDurationMinutes: 30 };
afterEach(() => configureTimestampRegExps("HH:mm"));
function apply(text: string, line = 0) {
  const plan = planNextTaskSlot(text, line, settings)!;
  const after = text.slice(0, plan.at) + plan.insertion + text.slice(plan.at);
  return { after, selected: after.slice(plan.from, plan.to), plan };
}

test("Enter inserts and selects the next slot including the separating space", () => {
  const { after, selected } = apply("- [ ] 09:00 - 09:30 Work");
  expect(after).toBe("- [ ] 09:00 - 09:30 Work\n- [ ] 09:30 - 10:00 ");
  expect(selected).toBe("09:30 - 10:00 ");
});

test("inserts a sibling after the existing subtree without moving its children", () => {
  const text =
    "- [ ] 09:00 - 09:30 Work\n    Details\n    - [ ] Child\n- [ ] 10:00 - 11:00 Next";
  expect(apply(text).after).toContain(
    "    - [ ] Child\n- [ ] 09:30 - 10:00 \n- [ ] 10:00",
  );
});

test("preserves nested tabs, numbering and CRLF", () => {
  const text = "- Parent\r\n\t1. [x] 10:00 - 10:30 Child\r\n";
  expect(apply(text, 1).after).toContain("\r\n\t2. [ ] 10:30 - 11:00 ");
});

test("start-only timestamps advance by the default duration", () => {
  expect(apply("- 09:00 Work").selected).toBe("09:30 - 10:00 ");
});

test.each([
  "Plain text",
  "- [ ] Untimed",
  "- [ ] 25:00 - 25:30 Bad",
  "- [ ] 23:30 - 24:00 End",
])("keeps native Enter behavior for %s", (text) => {
  expect(planNextTaskSlot(text, 0, settings)).toBeUndefined();
});

test("does not alter code, comments, properties or a disabled setting", () => {
  expect(
    planNextTaskSlot("```md\n- [ ] 09:00 Work\n```", 1, settings),
  ).toBeUndefined();
  expect(
    planNextTaskSlot("%%\n\n- [ ] 09:00 Work\n\n%%", 2, settings),
  ).toBeUndefined();
  expect(
    planNextTaskSlot("---\n- [ ] 09:00 Work\n---", 1, settings),
  ).toBeUndefined();
  expect(
    planNextTaskSlot("- [ ] 09:00 Work", 0, {
      ...settings,
      nextTaskSlotOnEnter: false,
    }),
  ).toBeUndefined();
});
