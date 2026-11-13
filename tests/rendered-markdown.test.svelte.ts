import { flushSync, mount, unmount } from "svelte";
import { writable } from "svelte/store";
import { afterEach, describe, expect, test, vi } from "vitest";

import { obsidianContextKey } from "../src/constants";
import type { ListItemEntryWithChildren } from "../src/redux/index/index-slice";
import { defaultSettingsForTests } from "../src/settings";
import type { ObsidianContext } from "../src/types";
import RenderedMarkdown from "../src/ui/components/rendered-markdown.svelte";

import { baseTimeBlock } from "./edit/util/fixtures";

function createNestedListItem(
  id: string,
  text: string,
  line: number,
): ListItemEntryWithChildren {
  return {
    id,
    text,
    task: " ",
    symbol: "-",
    path: "path",
    position: {
      start: { line, col: 0, offset: 0 },
      end: { line, col: 0, offset: 0 },
    },
    logEntries: [],
    planEntries: [],
  };
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("RenderedMarkdown", () => {
  test("narrow blocks use a subtask count and a readable stacked header when two lines fit", () => {
    const observed: Array<() => void> = [];
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: () => void) {
          observed.push(callback);
        }
        observe() {}
        disconnect() {}
      },
    );
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      callback(0);
      return 1;
    });
    const target = document.createElement("div");
    document.body.appendChild(target);
    const component = mount(RenderedMarkdown, {
      target,
      context: new Map([
        [
          obsidianContextKey,
          {
            settingsStore: writable(defaultSettingsForTests),
            renderMarkdown: (element: HTMLElement, text: string) => {
              element.textContent = text;
              return () => {};
            },
            toggleCheckboxInFile: vi.fn(),
            openNestedItemsEditModal: vi.fn(),
          },
        ],
      ]),
      props: {
        timeBlock: {
          ...baseTimeBlock,
          durationMinutes: 15,
          children: [createNestedListItem("a", "Long child text", 2)],
        },
      },
    });
    flushSync();
    const layout = target.querySelector<HTMLElement>(".rendered-markdown")!;
    layout.style.fontSize = "11px";
    let width = 169,
      height = 30;
    Object.defineProperties(layout, {
      clientWidth: { get: () => width },
      clientHeight: { get: () => height },
    });
    observed[0]!();
    flushSync();
    expect(layout.classList.contains("narrow-children")).toBe(true);
    expect(layout.classList.contains("ultra-compact")).toBe(false);
    expect(
      target.querySelector('[aria-label="View all 1 subtasks"]'),
    ).not.toBeNull();
    height = 24;
    observed[0]!();
    flushSync();
    expect(layout.classList.contains("ultra-compact")).toBe(true);
    width = 450;
    observed[0]!();
    flushSync();
    expect(layout.classList.contains("narrow-children")).toBe(false);
    unmount(component);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
  test("compact children expose a count button without selecting the block", async () => {
    const target = document.createElement("div");
    document.body.append(target);
    const openNestedItemsEditModal = vi.fn();
    const timeBlock = {
      ...baseTimeBlock,
      durationMinutes: 15,
      children: [
        createNestedListItem("a", "First child", 1),
        createNestedListItem("b", "Second child", 2),
      ],
    };
    const context = new Map<string, unknown>([
      [
        obsidianContextKey,
        {
          renderMarkdown: vi.fn(() => () => {}),
          settingsStore: writable({ ...defaultSettingsForTests, zoomLevel: 1 }),
          toggleCheckboxInFile: vi.fn(),
          openNestedItemsEditModal,
        },
      ],
    ]);
    const component = mount(RenderedMarkdown, {
      target,
      context,
      props: { timeBlock },
    });
    flushSync();
    const button = target.querySelector<HTMLButtonElement>(
      'button[aria-label="View all 2 subtasks"]',
    )!;
    expect(button).not.toBeNull();
    expect(button.textContent).toContain("2");
    const pointer = vi.fn();
    document.addEventListener("pointerup", pointer);
    button.dispatchEvent(new MouseEvent("pointerup", { bubbles: true }));
    expect(pointer).not.toHaveBeenCalled();
    document.removeEventListener("pointerup", pointer);
    button.click();
    expect(openNestedItemsEditModal).toHaveBeenCalledExactlyOnceWith(timeBlock);
    await unmount(component);
  });
  test("short blocks put children inline without changing checkbox targets; roomy and all-day blocks keep lists", () => {
    const target = document.createElement("div");
    const settings = writable({ ...defaultSettingsForTests, zoomLevel: 2 });
    const toggleCheckboxInFile = vi.fn(async () => {});
    const renderMarkdown = (element: HTMLElement, markdown: string) => {
      element.textContent = markdown;
      for (const _ of markdown.matchAll(/\[[^\]]\]/gu)) {
        const item = document.createElement("li");
        item.dataset.task = " ";
        const input = document.createElement("input");
        input.type = "checkbox";
        item.appendChild(input);
        element.appendChild(item);
      }
      return () => element.replaceChildren();
    };
    const context = new Map([
      [
        obsidianContextKey,
        { settingsStore: settings, renderMarkdown, toggleCheckboxInFile },
      ],
    ]);
    const timeBlock = {
      ...baseTimeBlock,
      durationMinutes: 15,
      text: "Admin",
      children: [
        createNestedListItem("a", "Call supplier", 8),
        createNestedListItem("b", "Send message", 12),
      ],
    };
    const props = $state({ timeBlock });
    document.body.appendChild(target);
    const component = mount(RenderedMarkdown, { context, target, props });
    flushSync();
    expect(target.querySelector(".has-inline-children")).not.toBeNull();
    expect(
      target.querySelector(".lines-after-first-wrapper")?.getAttribute("title"),
    ).toContain("Call supplier");
    target
      .querySelector<HTMLInputElement>(".lines-after-first-wrapper input")!
      .click();
    expect(toggleCheckboxInFile).toHaveBeenCalledWith("path", 8);
    settings.set({ ...defaultSettingsForTests, zoomLevel: 5 });
    props.timeBlock = { ...timeBlock, durationMinutes: 60 };
    flushSync();
    expect(target.querySelector(".has-inline-children")).toBeNull();
    props.timeBlock = { ...timeBlock, isAllDayEvent: true };
    flushSync();
    expect(target.querySelector(".has-inline-children")).toBeNull();
    expect(target.textContent).toContain("Send message");
    unmount(component);
  });
  test("filters nested statuses without shifting checkbox source lines or mutating children", () => {
    const target = document.createElement("div");
    const settings = writable(defaultSettingsForTests);
    const toggleCheckboxInFile = vi.fn().mockResolvedValue(undefined);
    const renderMarkdown = vi.fn((element: HTMLElement, markdown: string) => {
      element.textContent = markdown;
      for (const match of markdown.matchAll(/\[[^\]]\]/gu)) {
        const item = document.createElement("li");
        item.dataset.task = match[0].slice(1, -1);
        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.className = "task-list-item-checkbox";
        item.appendChild(checkbox);
        element.appendChild(item);
      }
      return () => element.replaceChildren();
    });
    const context = new Map<string, unknown>([
      [
        obsidianContextKey,
        {
          renderMarkdown,
          settingsStore: settings,
          toggleCheckboxInFile,
        } as unknown as ObsidianContext,
      ],
    ]);
    const cancelled = {
      ...createNestedListItem("cancelled", "Cancelled", 1),
      task: "-",
    };
    const nestedCancelled = {
      ...createNestedListItem("nested-cancelled", "Nested cancelled", 3),
      task: "-",
    };
    const kept = createNestedListItem("kept", "Keep this task", 4);
    const parent = {
      ...createNestedListItem("parent", "Active parent", 2),
      children: [nestedCancelled, kept],
    };
    const children = [cancelled, parent];
    const original = JSON.stringify(children);
    document.body.appendChild(target);
    const component = mount(RenderedMarkdown, {
      target,
      context,
      props: { timeBlock: { ...baseTimeBlock, children } },
    });
    flushSync();
    settings.update((current) => ({ ...current, hiddenTaskStatuses: ["-"] }));
    flushSync();

    expect(target.textContent).not.toContain("Cancelled");
    expect(target.textContent).not.toContain("Nested cancelled");
    expect(target.textContent).toContain("Keep this task");
    expect(
      Array.from(
        target.querySelectorAll<HTMLInputElement>("input"),
        (input) => input.dataset.line,
      ),
    ).toEqual(["0", "2", "4"]);
    target.querySelector<HTMLInputElement>('input[data-line="4"]')!.click();
    expect(toggleCheckboxInFile).toHaveBeenCalledWith("path", 4);
    expect(JSON.stringify(children)).toBe(original);

    settings.set(defaultSettingsForTests);
    flushSync();
    expect(target.textContent).toContain("Cancelled");
    expect(target.textContent).toContain("Nested cancelled");
    unmount(component);
  });

  test.each([
    { durationMinutes: 20, expectedCompact: true, zoomLevel: 1 },
    { durationMinutes: 30, expectedCompact: false, zoomLevel: 1 },
    { durationMinutes: 10, expectedCompact: true, zoomLevel: 2 },
    { durationMinutes: 20, expectedCompact: false, zoomLevel: 2 },
  ])(
    "renders compact=$expectedCompact for a $durationMinutes-minute block at zoom $zoomLevel",
    ({ durationMinutes, expectedCompact, zoomLevel }) => {
      const target = document.createElement("div");
      const context = new Map<string, unknown>([
        [
          obsidianContextKey,
          {
            renderMarkdown: vi.fn(() => vi.fn()),
            settingsStore: writable({
              ...defaultSettingsForTests,
              zoomLevel,
            }),
            toggleCheckboxInFile: vi.fn(),
          } as unknown as ObsidianContext,
        ],
      ]);

      document.body.appendChild(target);

      const component = mount(RenderedMarkdown, {
        context,
        props: {
          timeBlock: {
            ...baseTimeBlock,
            durationMinutes,
          },
        },
        target,
      });

      flushSync();

      expect(
        target
          .querySelector(".time-summary-row")
          ?.classList.contains("is-compact"),
      ).toBe(expectedCompact);

      unmount(component);
    },
  );

  test.each([
    { durationMinutes: 30, expectedStacked: false, zoomLevel: 1 },
    { durationMinutes: 40, expectedStacked: true, zoomLevel: 1 },
    { durationMinutes: 15, expectedStacked: false, zoomLevel: 2 },
    { durationMinutes: 20, expectedStacked: true, zoomLevel: 2 },
  ])(
    "keeps the header top-aligned when stacked=$expectedStacked for $durationMinutes minutes at zoom $zoomLevel",
    ({ durationMinutes, expectedStacked, zoomLevel }) => {
      const target = document.createElement("div");
      const renderMarkdown = vi.fn((element: HTMLElement, markdown: string) => {
        const paragraph = document.createElement("p");

        paragraph.textContent = markdown;
        element.append(paragraph);

        return vi.fn();
      });
      const context = new Map<string, unknown>([
        [
          obsidianContextKey,
          {
            renderMarkdown,
            settingsStore: writable({
              ...defaultSettingsForTests,
              zoomLevel,
            }),
            toggleCheckboxInFile: vi.fn(),
          } as unknown as ObsidianContext,
        ],
      ]);

      document.body.appendChild(target);

      const component = mount(RenderedMarkdown, {
        context,
        props: {
          timeBlock: {
            ...baseTimeBlock,
            durationMinutes,
            text: `00:00 - 00:${String(durationMinutes).padStart(2, "0")} ${"Very long title ".repeat(12)}`,
          },
        },
        target,
      });

      flushSync();

      const summaryRow = target.querySelector(".time-summary-row");
      expect(summaryRow?.classList.contains("is-stacked-header")).toBe(
        expectedStacked,
      );
      expect(summaryRow?.querySelector(".time-block-range")?.textContent).toBe(
        `00:00 - 00:${String(durationMinutes).padStart(2, "0")}`,
      );
      expect(
        summaryRow?.querySelector(".first-line-wrapper")?.textContent,
      ).toContain("Very long title ".repeat(12).trim());

      unmount(component);
    },
  );

  test.each([
    { durationMinutes: 60, expectedStacked: false, nestedItemCount: 1 },
    { durationMinutes: 70, expectedStacked: true, nestedItemCount: 1 },
    { durationMinutes: 80, expectedStacked: false, nestedItemCount: 2 },
    { durationMinutes: 90, expectedStacked: true, nestedItemCount: 2 },
  ])(
    "accounts for $nestedItemCount nested items before rendering stacked=$expectedStacked at $durationMinutes pixels",
    ({ durationMinutes, expectedStacked, nestedItemCount }) => {
      const target = document.createElement("div");
      const context = new Map<string, unknown>([
        [
          obsidianContextKey,
          {
            renderMarkdown: vi.fn(() => vi.fn()),
            settingsStore: writable({
              ...defaultSettingsForTests,
              zoomLevel: 1,
            }),
            toggleCheckboxInFile: vi.fn(),
          } as unknown as ObsidianContext,
        ],
      ]);

      document.body.appendChild(target);

      const component = mount(RenderedMarkdown, {
        context,
        props: {
          timeBlock: {
            ...baseTimeBlock,
            children: Array.from({ length: nestedItemCount }, (_, index) => ({
              children: [],
              id: `nested-item-${index + 1}`,
              logEntries: [],
              path: "path",
              planEntries: [],
              position: {
                end: { col: 0, line: index + 2, offset: 0 },
                start: { col: 0, line: index + 1, offset: 0 },
              },
              symbol: "-",
              text: `Nested item ${index + 1}`,
            })),
            durationMinutes,
          },
        },
        target,
      });

      flushSync();

      expect(
        target
          .querySelector(".time-summary-row")
          ?.classList.contains("is-stacked-header"),
      ).toBe(expectedStacked);

      unmount(component);
    },
  );

  test.each([
    {
      durationMinutes: 30,
      hideTimeRangeInSingleLine: true,
      expectedVisible: false,
    },
    {
      durationMinutes: 50,
      hideTimeRangeInSingleLine: false,
      expectedVisible: true,
    },
    {
      durationMinutes: 40,
      hideTimeRangeInSingleLine: true,
      expectedVisible: true,
    },
  ])(
    "renders the time range visible=$expectedVisible for a $durationMinutes-minute block when hideTimeRangeInSingleLine=$hideTimeRangeInSingleLine",
    ({ durationMinutes, hideTimeRangeInSingleLine, expectedVisible }) => {
      const target = document.createElement("div");
      const context = new Map<string, unknown>([
        [
          obsidianContextKey,
          {
            renderMarkdown: vi.fn(() => vi.fn()),
            settingsStore: writable({
              ...defaultSettingsForTests,
              hideTimeRangeInSingleLine,
            }),
            toggleCheckboxInFile: vi.fn(),
          } as unknown as ObsidianContext,
        ],
      ]);

      document.body.appendChild(target);

      const component = mount(RenderedMarkdown, {
        context,
        props: {
          timeBlock: {
            ...baseTimeBlock,
            durationMinutes,
          },
        },
        target,
      });

      flushSync();

      expect(target.querySelector(".time-block-range") !== null).toBe(
        expectedVisible,
      );

      unmount(component);
    },
  );

  test("renders time block markdown relative to its source file", () => {
    const target = document.createElement("div");
    const renderMarkdown = vi.fn(() => vi.fn());
    const sourcePath = "fixtures/daily/2023-01-01.md";
    const context = new Map<string, unknown>([
      [
        obsidianContextKey,
        {
          renderMarkdown,
          settingsStore: writable(defaultSettingsForTests),
          toggleCheckboxInFile: vi.fn(),
        } as unknown as ObsidianContext,
      ],
    ]);

    document.body.appendChild(target);

    const component = mount(RenderedMarkdown, {
      context,
      props: {
        timeBlock: {
          ...baseTimeBlock,
          path: sourcePath,
          text: "10:00 - 11:00 Review [[Project]]",
        },
      },
      target,
    });

    flushSync();

    expect(renderMarkdown).toHaveBeenCalledOnce();
    expect(renderMarkdown).toHaveBeenCalledWith(
      expect.any(HTMLElement),
      expect.stringContaining("[[Project]]"),
      sourcePath,
    );

    unmount(component);
  });

  test("reactively hides Tasks metadata when the setting is enabled", () => {
    const target = document.createElement("div");
    const renderMarkdown = vi.fn(() => vi.fn());
    const sourcePath = "fixtures/daily/2023-01-01.md";
    const settings = writable({
      ...defaultSettingsForTests,
      hideTasksMetadata: false,
    });
    const context = new Map<string, unknown>([
      [
        obsidianContextKey,
        {
          renderMarkdown,
          settingsStore: settings,
          toggleCheckboxInFile: vi.fn(),
        } as unknown as ObsidianContext,
      ],
    ]);

    document.body.appendChild(target);

    const component = mount(RenderedMarkdown, {
      context,
      props: {
        timeBlock: {
          ...baseTimeBlock,
          path: sourcePath,
          text: "10:00 - 11:00 Review proposal ⏳ 2026-07-27 📅 2026-08-07",
        },
      },
      target,
    });

    flushSync();

    expect(renderMarkdown).toHaveBeenLastCalledWith(
      expect.any(HTMLElement),
      expect.stringContaining("⏳ 2026-07-27"),
      sourcePath,
    );

    settings.update((current) => ({
      ...current,
      hideTasksMetadata: true,
    }));
    flushSync();

    expect(renderMarkdown).toHaveBeenLastCalledWith(
      expect.any(HTMLElement),
      "- [ ] Review proposal",
      sourcePath,
    );

    unmount(component);
  });

  test("does not re-render markdown when an edit hands it an equal time block", () => {
    const target = document.createElement("div");
    const renderMarkdown = vi.fn(() => vi.fn());
    const context = new Map<string, unknown>([
      [
        obsidianContextKey,
        {
          renderMarkdown,
          settingsStore: writable(defaultSettingsForTests),
          toggleCheckboxInFile: vi.fn(),
        } as unknown as ObsidianContext,
      ],
    ]);

    document.body.appendChild(target);

    const props = $state({
      timeBlock: {
        ...baseTimeBlock,
        text: "10:00 - 11:00 Review proposal",
        children: [
          createNestedListItem("child-1", "Read the brief", 1),
          createNestedListItem("child-2", "Leave a comment", 2),
        ],
      },
    });

    const component = mount(RenderedMarkdown, { context, props, target });

    flushSync();

    const callsAfterMount = renderMarkdown.mock.calls.length;

    expect(callsAfterMount).toBeGreaterThan(0);

    // An active edit operation rebuilds every block object on each pointer
    // move, so an unchanged block still arrives as a new reference.
    props.timeBlock = {
      ...baseTimeBlock,
      text: "10:00 - 11:00 Review proposal",
      children: [
        createNestedListItem("child-1", "Read the brief", 1),
        createNestedListItem("child-2", "Leave a comment", 2),
      ],
    };
    flushSync();

    expect(renderMarkdown).toHaveBeenCalledTimes(callsAfterMount);

    unmount(component);
  });

  test("re-renders markdown once the block text actually changes", () => {
    const target = document.createElement("div");
    const renderMarkdown = vi.fn(() => vi.fn());
    const context = new Map<string, unknown>([
      [
        obsidianContextKey,
        {
          renderMarkdown,
          settingsStore: writable(defaultSettingsForTests),
          toggleCheckboxInFile: vi.fn(),
        } as unknown as ObsidianContext,
      ],
    ]);

    document.body.appendChild(target);

    const props = $state({
      timeBlock: { ...baseTimeBlock, text: "10:00 - 11:00 Review proposal" },
    });

    const component = mount(RenderedMarkdown, { context, props, target });

    flushSync();

    const callsAfterMount = renderMarkdown.mock.calls.length;

    props.timeBlock = { ...baseTimeBlock, text: "10:00 - 11:00 Ship release" };
    flushSync();

    expect(renderMarkdown.mock.calls.length).toBeGreaterThan(callsAfterMount);
    expect(renderMarkdown).toHaveBeenLastCalledWith(
      expect.any(HTMLElement),
      "- [ ] Ship release",
      "path",
    );

    unmount(component);
  });
});
