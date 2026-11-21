import { flushSync, mount, unmount } from "svelte";
import { writable } from "svelte/store";
import { expect, test, vi } from "vitest";
import {
  dateRangeContextKey,
  isInSidebarContextKey,
  obsidianContextKey,
} from "../src/constants";
import TimelineControls from "../src/ui/components/timeline-controls.svelte";

test.each([true, false])(
  "timeline sync is a keyboard refresh control (sidebar=%s)",
  async (sidebar) => {
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
          {
            first: selected,
            last: selected,
            current: [selected],
            set: vi.fn(),
          },
        ],
        [isInSidebarContextKey, writable(sidebar)],
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
    if (sidebar)
      expect(button.nextElementSibling?.getAttribute("aria-label")).toBe(
        "More options",
      );
    expect(button.querySelector("svg")).not.toBeNull();
    expect(button.textContent?.trim()).toBe("");
    expect(button.querySelector(".is-spinning")).toBeNull();
    button.focus();
    expect(document.activeElement).toBe(button);
    button.click();
    expect(reSync).toHaveBeenCalledOnce();
    syncing.set(true);
    flushSync();
    expect(button.getAttribute("aria-busy")).toBe("true");
    expect(button.querySelector(".is-spinning")).not.toBeNull();
    syncing.set(false);
    flushSync();
    expect(button.querySelector(".is-spinning")).toBeNull();
    await unmount(component);
    target.remove();
  },
);
