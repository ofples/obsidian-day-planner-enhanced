import { flushSync, mount, unmount } from "svelte";
import { writable } from "svelte/store";
import { afterEach, expect, test, vi } from "vitest";

import { dateRangeContextKey, obsidianContextKey } from "../src/constants";
import type { DateRange } from "../src/redux/date-ranges";
import PlannerDayCount from "../src/ui/components/planner-day-count.svelte";

afterEach(() => document.body.replaceChildren());

test("changes the current pane's day count and scopes shortcuts to planner focus", async () => {
  const root = document.createElement("div");
  root.className = "workspace-leaf-content";
  const target = document.createElement("div");
  root.append(target);
  document.body.append(root);
  const day = window.moment("2026-11-15");
  const range = {
    current: [day],
    first: day,
    last: day,
    set: vi.fn(),
    update: vi.fn(),
    untrack: vi.fn(),
  } satisfies DateRange;
  const editOperation = writable<unknown>(undefined);
  const showPlannerDays = vi.fn(async () => {});
  const component = mount(PlannerDayCount, {
    target,
    context: new Map<string, unknown>([
      [dateRangeContextKey, range],
      [obsidianContextKey, { showPlannerDays, editContext: { editOperation } }],
    ]),
  });
  flushSync();
  const select = target.querySelector("select")!;
  select.value = "3";
  select.dispatchEvent(new Event("change", { bubbles: true }));
  expect(showPlannerDays).toHaveBeenLastCalledWith(3, day, select);
  root.dispatchEvent(
    new KeyboardEvent("keydown", { key: "w", bubbles: true, cancelable: true }),
  );
  expect(showPlannerDays).toHaveBeenLastCalledWith(7, day, select);
  root.dispatchEvent(
    new KeyboardEvent("keydown", { key: "d", bubbles: true, cancelable: true }),
  );
  expect(showPlannerDays).toHaveBeenLastCalledWith(1, day, select);
  const input = document.createElement("input");
  root.append(input);
  const calls = showPlannerDays.mock.calls.length;
  input.dispatchEvent(
    new KeyboardEvent("keydown", { key: "2", bubbles: true, cancelable: true }),
  );
  document.body.dispatchEvent(
    new KeyboardEvent("keydown", { key: "3", bubbles: true, cancelable: true }),
  );
  root.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "3",
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    }),
  );
  editOperation.set({ mode: "swap" });
  root.dispatchEvent(
    new KeyboardEvent("keydown", { key: "4", bubbles: true, cancelable: true }),
  );
  expect(showPlannerDays).toHaveBeenCalledTimes(calls);
  await unmount(component);
});
