import type { WorkspaceLeaf, ViewStateResult } from "obsidian";
import { flushSync } from "svelte";
import { writable } from "svelte/store";
import { beforeAll, describe, expect, test, vi } from "vitest";

import { createDateRanges, type DateRange } from "../src/redux/date-ranges";
import { selectVisibleDays } from "../src/redux/date-ranges-slice";
import { makeStore, type RootState } from "../src/redux/store";
import { createUseSelector } from "../src/redux/use-selector";
import type { PeriodicNotes } from "../src/service/periodic-notes";
import type { WorkspaceFacade } from "../src/service/workspace-facade";
import {
  defaultSettingsForTests,
  type DayPlannerSettings,
} from "../src/settings";
import type MultiDayViewType from "../src/ui/multi-day-view";
import type TimelineViewType from "../src/ui/timeline-view";
import { getSavedViewDay } from "../src/util/view";

vi.mock("obsidian", async () => {
  class ItemView {
    app: unknown;
    leaf: unknown;
    containerEl = { children: [{}, { addClass: vi.fn() }] };
    disposers: (() => void)[] = [];
    constructor(leaf: { app: unknown }) {
      this.leaf = leaf;
      this.app = leaf.app;
    }
    async setState() {}
    register(fn: () => void) {
      this.disposers.push(fn);
    }
    registerEvent(fn: () => void) {
      this.disposers.push(fn);
    }
    dispose() {
      this.disposers.splice(0).forEach((fn) => fn());
    }
    onPaneMenu() {}
  }
  class FileView {
    constructor(public file: unknown) {}
  }
  return {
    ItemView,
    FileView,
    WorkspaceLeaf: class {},
    Menu: class {},
    moment: (await import("moment")).default,
  };
});
vi.doMock("svelte", async (importOriginal) => ({
  ...(await importOriginal<typeof import("svelte")>()),
  mount: () => ({}),
  unmount: async () => {},
}));
vi.mock("../src/ui/components/multi-day/multi-day-grid.svelte", () => ({
  default: {},
}));
vi.mock("../src/ui/components/timeline-with-controls.svelte", () => ({
  default: {},
}));
vi.mock("../src/ui/timeline-view-menu", () => ({
  addTimelineViewMenuItems: vi.fn(),
}));

let MultiDayView: typeof MultiDayViewType;
let TimelineView: typeof TimelineViewType;
beforeAll(async () => {
  MultiDayView = (await import("../src/ui/multi-day-view")).default;
  TimelineView = (await import("../src/ui/timeline-view")).default;
});
const result = {} as ViewStateResult;
function setup() {
  const store = makeStore({});
  const dateRanges = createDateRanges({
    store,
    useSelector: createUseSelector<RootState>(store),
  });
  const settings = writable<DayPlannerSettings>({
    ...defaultSettingsForTests,
    multiDayRange: "3-days" as const,
    firstDayOfWeek: "monday" as const,
  });
  const requestSaveLayout = vi.fn();
  let activeFile: { day: string } | null = null;
  let activeListener: (leaf: unknown) => void = () => {};
  const workspace = { requestSaveLayout, getActiveFile: () => activeFile };
  const leaf = {
    app: { workspace },
    updateHeader: vi.fn(),
  } as unknown as WorkspaceLeaf;
  const facade = {
    isLeafInSidebar: () => false,
    onActiveLeafChange: (fn: (leaf: unknown) => void) => {
      activeListener = fn;
      return () => {
        activeListener = () => {};
      };
    },
    onLayoutChange: () => () => {},
  };
  const periodic = {
    getDateFromFile: (file: { day: string }) => window.moment(file.day),
  };
  function multi() {
    return new MultiDayView(leaf, settings, new Map(), dateRanges);
  }
  function timeline() {
    return new TimelineView(
      leaf,
      settings,
      new Map(),
      dateRanges,
      periodic as unknown as PeriodicNotes,
      facade as unknown as WorkspaceFacade,
      vi.fn(),
      vi.fn(),
      vi.fn(),
    );
  }
  return {
    store,
    settings,
    requestSaveLayout,
    multi,
    timeline,
    setActive: (day: string) => {
      activeFile = { day };
    },
    follow: (leaf: unknown) => activeListener(leaf),
  };
}
function range(view: unknown): DateRange {
  return (view as { dateRange: DateRange }).dateRange;
}
async function close(view: MultiDayViewType | TimelineViewType) {
  await view.onClose();
  (view as unknown as { dispose(): void }).dispose();
}

describe("planner view date state", () => {
  test.each(["multi", "timeline"] as const)(
    "%s restores state before and after opening, tracks navigation, and cleans up",
    async (kind) => {
      const h = setup();
      const view = h[kind]();
      await view.setState({ day: "2024-02-29" }, result);
      expect(view.getState()).toEqual({ day: "2024-02-29" });
      await view.onOpen();
      flushSync();
      expect(view.getState()).toEqual({ day: "2024-02-29" });
      expect(h.requestSaveLayout).not.toHaveBeenCalled();
      range(view).set([window.moment("2024-03-02")]);
      flushSync();
      expect(view.getState()).toEqual({ day: "2024-03-02" });
      expect(h.requestSaveLayout).toHaveBeenCalledTimes(1);
      range(view).set([window.moment("2024-03-02T20:00")]);
      flushSync();
      expect(h.requestSaveLayout).toHaveBeenCalledTimes(1);
      await view.setState({ day: "2024-03-05" }, result);
      flushSync();
      expect(view.getState()).toEqual({ day: "2024-03-05" });
      const oldRange = range(view);
      await close(view);
      flushSync();
      expect(selectVisibleDays(h.store.getState())).toEqual([]);
      expect(view.getState()).toEqual({ day: "2024-03-05" });
      const count = h.requestSaveLayout.mock.calls.length;
      oldRange.set([window.moment("2024-04-01")]);
      flushSync();
      expect(h.requestSaveLayout).toHaveBeenCalledTimes(count);
      await view.onOpen();
      flushSync();
      expect(view.getState()).toEqual({ day: "2024-03-05" });
      await close(view);
    },
  );

  test.each([
    undefined,
    null,
    {},
    { day: "2025-02-29" },
    { day: "2024-2-29" },
    { day: "2024-02-29<script>" },
    { day: 3 },
  ])("invalid or legacy state %j falls back safely", async (state) => {
    const h = setup();
    const view = h.timeline();
    h.setActive("2026-05-03");
    await view.setState(state, result);
    await view.onOpen();
    flushSync();
    expect(view.getState()).toEqual({ day: "2026-05-03" });
    await close(view);
  });

  test("each leaf tracks and saves its own day", async () => {
    const h = setup();
    const a = h.multi();
    const b = h.multi();
    await a.setState({ day: "2026-01-02" }, result);
    await b.setState({ day: "2026-02-03" }, result);
    await a.onOpen();
    await b.onOpen();
    flushSync();
    range(a).set([window.moment("2026-01-04")]);
    flushSync();
    expect(a.getState().day).toBe("2026-01-04");
    expect(b.getState().day).toBe("2026-02-03");
    expect(h.requestSaveLayout).toHaveBeenCalledTimes(1);
    await close(a);
    await close(b);
  });

  test("settings changes preserve the viewed period across range modes and week start", async () => {
    const h = setup();
    const view = h.multi();
    await view.setState({ day: "2026-07-15" }, result);
    await view.onOpen();
    flushSync();
    h.settings.update((s) => ({ ...s, multiDayRange: "full-week" }));
    flushSync();
    expect(view.getState().day).toBe("2026-07-13");
    h.settings.update((s) => ({ ...s, firstDayOfWeek: "sunday" }));
    flushSync();
    expect(view.getState().day).toBe("2026-07-12");
    h.settings.update((s) => ({ ...s, multiDayRange: "work-week" }));
    flushSync();
    expect(view.getState().day).toBe("2026-07-13");
    h.settings.update((s) => ({ ...s, multiDayRange: "3-days" }));
    flushSync();
    expect(view.getState().day).toBe("2026-07-13");
    await close(view);
  });

  test("timeline restores saved day over active file, then follows later daily leaf changes", async () => {
    const { FileView } = await import("obsidian");
    const h = setup();
    h.setActive("2026-01-01");
    const view = h.timeline();
    await view.setState({ day: "2026-03-04" }, result);
    await view.onOpen();
    flushSync();
    expect(view.getState().day).toBe("2026-03-04");
    const FakeFileView = FileView as unknown as new (file: {
      day: string;
    }) => object;
    h.follow({ view: new FakeFileView({ day: "2026-04-05" }) });
    flushSync();
    expect(view.getState().day).toBe("2026-04-05");
    expect(h.requestSaveLayout).toHaveBeenCalledTimes(1);
    await close(view);
  });

  test("strict local day parsing accepts leap days and rejects impossible dates", () => {
    const day = getSavedViewDay({ day: "2024-02-29" });
    expect(day?.format("YYYY-MM-DD HH:mm")).toBe("2024-02-29 00:00");
    expect(getSavedViewDay({ day: "2023-02-29" })).toBeUndefined();
  });
});

