import { expect, test } from "vitest";

import { sortPlannerTasks } from "../src/util/sort-planner-tasks";

test("sorts complete timed parents while preserving children, untimed slots, headings and CRLF", () => {
  const before =
    "# Elsewhere\r\n- 11:00 Outside\r\n- 08:00 Outside two\r\n# Plan\r\n- [ ] 11:00 Late\r\n  - [x] Child\r\n- Untimed\r\n- 08:00 Early\r\n  - [ ] Other child\r\n# Other\r\n- 10:00 Stay\r\n- 09:00 Stay too\r\n";
  const after = sortPlannerTasks(before, "Plan");
  expect(after).toBe(
    "# Elsewhere\r\n- 11:00 Outside\r\n- 08:00 Outside two\r\n# Plan\r\n- 08:00 Early\r\n  - [ ] Other child\r\n- Untimed\r\n- [ ] 11:00 Late\r\n  - [x] Child\r\n# Other\r\n- 10:00 Stay\r\n- 09:00 Stay too\r\n",
  );
});

test("sorts fully selected parents and timed nested siblings independently", () => {
  const before =
    "# Work\n- 11:00 Late\n  - 16:00 Nested late\n  - 08:00 Nested early\n- 09:00 Early\n- 07:00 Excluded\n";
  const from = before.indexOf("- 11:00");
  const to = before.indexOf("\n- 07:00");
  const result = sortPlannerTasks(before, "Missing", { from, to });
  expect(result).toContain(
    "- 09:00 Early\n- 11:00 Late\n  - 08:00 Nested early\n  - 16:00 Nested late\n- 07:00 Excluded",
  );
  const partial = sortPlannerTasks(before, "Missing", { from: from + 2, to });
  expect(partial).toContain(
    "- 11:00 Late\n  - 08:00 Nested early\n  - 16:00 Nested late\n- 09:00 Early",
  );
});

test("does not alter lists outside the planner section", () => {
  const text = "# Other\n- 12:00 Late\n- 08:00 Early\n";
  expect(sortPlannerTasks(text, "Plan")).toBe(text);
});

test("keeps untimed nested slots and grandchildren attached when sorting children", () => {
  const text =
    "# Plan\n- [ ] 10:00 Parent\n  - [ ] 16:00 Late child\n    - [ ] Late grandchild\n  - [ ] Untimed child\n  - [ ] 08:00 Early child\n    - [ ] Early grandchild\n";
  expect(sortPlannerTasks(text, "Plan")).toBe(
    "# Plan\n- [ ] 10:00 Parent\n  - [ ] 08:00 Early child\n    - [ ] Early grandchild\n  - [ ] Untimed child\n  - [ ] 16:00 Late child\n    - [ ] Late grandchild\n",
  );
});
