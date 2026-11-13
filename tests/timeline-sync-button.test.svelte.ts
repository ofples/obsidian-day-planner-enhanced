import { flushSync, mount, unmount } from "svelte";
import { writable } from "svelte/store";
import { expect, test, vi } from "vitest";
import {
  dateRangeContextKey,
  isInSidebarContextKey,
  obsidianContextKey,
} from "../src/constants";
import TimelineControls from "../src/ui/components/timeline-controls.svelte";

test("sidebar sync is a separate keyboard button with reactive busy indicator", async () => {
  const selected = window.moment("2030-01-15");
  const syncing = writable(false),
    reSync = vi.fn(),
    target = document.createElement("div");
  document.body.append(target);
  const component = mount(TimelineControls, {
    target,
    context: new Map<string, unknown>([
      [
        dateRangeContextKey,
        { first: selected, last: selected, current: [selected], set: vi.fn() },
      ],
      [isInSidebarContextKey, writable(true)],
      [
        obsidianContextKey,
        {
          reSync,
          googleSyncing: syncing,
          workspaceFacade: {},
          periodicNotes: {},
        },
      ],
    ]),
  });
  flushSync();
  const button = target.querySelector<HTMLButtonElement>(
    'button[aria-label="Sync"]',
  )!;
  expect(button.nextElementSibling?.getAttribute("aria-label")).toBe(
    "More options",
  );
  button.focus();
  expect(document.activeElement).toBe(button);
  button.click();
  expect(reSync).toHaveBeenCalledOnce();
  syncing.set(true);
  flushSync();
  expect(button.getAttribute("aria-busy")).toBe("true");
  expect(button.querySelector(".is-spinning")).not.toBeNull();
  await unmount(component);
  target.remove();
});
