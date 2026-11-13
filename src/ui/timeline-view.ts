/* eslint-disable @typescript-eslint/no-floating-promises, @typescript-eslint/no-misused-promises, @typescript-eslint/no-redundant-type-constituents, @typescript-eslint/no-unnecessary-condition, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-enum-comparison, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return -- Obsidian community scorecard can run type-aware rules without resolving plugin source dependencies; tsc and svelte-check cover this source. */
import { ItemView, Menu, WorkspaceLeaf, type ViewStateResult } from "obsidian";
import { mount, unmount } from "svelte";
import type { Component } from "svelte";
import { get, toStore, writable, type Writable } from "svelte/store";
import { isNotVoid } from "typed-assert";

import {
  dateRangeContextKey,
  defaultDayFormat,
  obsidianContextKey,
  isInSidebarContextKey,
  viewTypeTimeline,
} from "../constants";
import type { DateRange, DateRanges } from "../redux/date-ranges";
import type { PeriodicNotes } from "../service/periodic-notes";
import type { WorkspaceFacade } from "../service/workspace-facade";
import type { DayPlannerSettings } from "../settings";
import type { ComponentContext, ObsidianContext } from "../types";
import {
  handleActiveFileChange,
  handleActiveLeafChange,
} from "../util/handle-active-leaf-change";
import type { Moment } from "../util/obsidian-moment";
import { getSavedViewDay, setViewTitle } from "../util/view";

import TimelineWithControls from "./components/timeline-with-controls.svelte";
import type { OpenTimelineSettingsModal } from "./timeline-settings-modal";
import { addTimelineViewMenuItems } from "./timeline-view-menu";

export default class TimelineView extends ItemView {
  private static readonly defaultDisplayText = "Timeline";
  private static readonly titleFormat = "MMM YYYY";
  private timeline?: Component;
  private dateRange?: DateRange;
  private savedDay?: Moment;
  private stopTrackingRange?: () => void;
  private readonly isInSidebar = writable(false);

  constructor(
    leaf: WorkspaceLeaf,
    private readonly settingsStore: Writable<DayPlannerSettings>,
    private readonly componentContext: ComponentContext,
    private readonly dateRanges: DateRanges,
    private readonly periodicNotes: PeriodicNotes,
    private readonly workspaceFacade: WorkspaceFacade,
    private readonly initWeeklyView: () => Promise<void>,
    private readonly reSync: () => void,
    private readonly openTimelineSettingsModal: OpenTimelineSettingsModal,
  ) {
    super(leaf);
  }

  getViewType(): string {
    return viewTypeTimeline;
  }

  getDisplayText(): string {
    const selectedDay = this.getSelectedDay();

    if (this.isMountedInSidebar() || !selectedDay) {
      return TimelineView.defaultDisplayText;
    }

    return selectedDay.format(TimelineView.titleFormat);
  }

  getIcon() {
    return get(this.settingsStore).timelineIcon;
  }

  getState() {
    return {
      day: (this.dateRange?.current[0] ?? this.savedDay)?.format(
        defaultDayFormat,
      ),
    };
  }

  async setState(state: unknown, result: ViewStateResult) {
    const day = getSavedViewDay(state);
    if (day) {
      this.savedDay = day;
      this.dateRange?.set([day]);
    }
    await super.setState(state, result);
  }

  onPaneMenu(menu: Menu, source: string) {
    super.onPaneMenu(menu, source);

    addTimelineViewMenuItems(menu, {
      exportSchedule: (day) => {
        const context = this.componentContext.get(
          obsidianContextKey,
        ) as ObsidianContext;
        context.exportSchedule(day);
      },
      reSync: this.reSync,
      openReviewSyncConflicts: () => {
        const context = this.componentContext.get(
          obsidianContextKey,
        ) as ObsidianContext;
        context.openReviewSyncConflicts?.();
      },
      initWeeklyView: this.initWeeklyView,
      openTimelineSettingsModal: this.openTimelineSettingsModal,
      settingsStore: this.settingsStore,
      openFileForDay: (day: Moment) => this.workspaceFacade.openFileForDay(day),
      getSelectedDay: this.getSelectedDay,
    });
  }

  async onOpen() {
    const contentEl = this.containerEl.children[1];

    isNotVoid(contentEl);
    contentEl.addClass("planner-timeline-layout");

    const dateRange = this.dateRanges.trackRange([
      this.savedDay?.clone() ?? window.moment(),
    ]);

    this.dateRange = dateRange;
    if (!this.savedDay)
      handleActiveFileChange(
        this.app.workspace.getActiveFile(),
        dateRange,
        this.periodicNotes,
      );
    this.savedDay = dateRange.first.clone();
    this.stopTrackingRange = toStore(() => dateRange.current).subscribe(
      this.updateTabTitleAndHeader,
    );
    this.register(this.stopTrackingRange);
    this.registerEvent(
      this.workspaceFacade.onActiveLeafChange((leaf) => {
        if (!this.dateRange) {
          return;
        }

        handleActiveLeafChange(leaf, this.dateRange, this.periodicNotes);
      }),
    );

    // Note: a leaf can be dragged between the sidebar and the main area
    this.registerEvent(
      this.workspaceFacade.onLayoutChange(this.updateTabTitleAndHeader),
    );

    const context = new Map<string, unknown>([
      ...this.componentContext,
      [dateRangeContextKey, this.dateRange],
      [isInSidebarContextKey, this.isInSidebar],
    ]);

    // @ts-expect-error
    this.timeline = mount(TimelineWithControls, {
      target: contentEl,
      context,
    });
  }

  async onClose() {
    this.savedDay = this.dateRange?.current[0]?.clone() ?? this.savedDay;
    this.stopTrackingRange?.();
    this.stopTrackingRange = undefined;
    if (this.timeline) {
      await unmount(this.timeline);
    }

    this.dateRange?.untrack();
    this.dateRange = undefined;
  }

  private isMountedInSidebar() {
    return this.workspaceFacade.isLeafInSidebar(this.leaf);
  }

  private getSelectedDay = () => {
    if (!this.dateRange) {
      return undefined;
    }

    return this.dateRange.current[0];
  };

  private updateTabTitleAndHeader = () => {
    const day = this.dateRange?.current[0];
    if (day && !day.isSame(this.savedDay, "day")) {
      this.savedDay = day.clone();
      this.app.workspace.requestSaveLayout();
    }
    this.isInSidebar.set(this.isMountedInSidebar());

    setViewTitle(this, this.getDisplayText());
  };
}
/* eslint-enable @typescript-eslint/no-floating-promises, @typescript-eslint/no-misused-promises, @typescript-eslint/no-redundant-type-constituents, @typescript-eslint/no-unnecessary-condition, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-enum-comparison, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return -- Re-enable scorecard compatibility suppressions after this file. */
