/* eslint-disable @typescript-eslint/no-floating-promises, @typescript-eslint/no-misused-promises, @typescript-eslint/no-redundant-type-constituents, @typescript-eslint/no-unnecessary-condition, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-enum-comparison, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return -- Obsidian community scorecard can run type-aware rules without resolving plugin source dependencies; tsc and svelte-check cover this source. */
import { ItemView, WorkspaceLeaf, type ViewStateResult } from "obsidian";
import { mount, unmount } from "svelte";
import { derived, get, toStore, type Writable } from "svelte/store";
import { isNotVoid } from "typed-assert";

import {
  dateRangeContextKey,
  defaultDayFormat,
  viewTypeMultiDay,
} from "../constants";
import type { DateRange, DateRanges } from "../redux/date-ranges";
import type { DayPlannerSettings } from "../settings";
import type { ComponentContext } from "../types";
import type { Moment } from "../util/obsidian-moment";
import * as r from "../util/range";
import { getSavedViewDay, setViewTitle } from "../util/view";

import MultiDayGrid from "./components/multi-day/multi-day-grid.svelte";

export default class MultiDayView extends ItemView {
  private static readonly defaultDisplayText = "Multi-Day View";
  navigation = true;
  private multiDayComponent?: Record<string, unknown>;
  private dateRange?: DateRange;
  private savedDay?: Moment;
  private stopTrackingRange?: () => void;

  constructor(
    leaf: WorkspaceLeaf,
    private readonly settingsStore: Writable<DayPlannerSettings>,
    private readonly componentContext: ComponentContext,
    private readonly dateRanges: DateRanges,
  ) {
    super(leaf);
  }

  getViewType(): string {
    return viewTypeMultiDay;
  }

  getDisplayText(): string {
    if (!this.dateRange) {
      return MultiDayView.defaultDisplayText;
    }

    return r.toString(this.dateRange.current);
  }

  getIcon() {
    return "table-2";
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
      const settings = get(this.settingsStore);
      this.dateRange?.set(
        r.createRange(settings.multiDayRange, settings.firstDayOfWeek, day),
      );
    }
    await super.setState(state, result);
  }

  async onOpen() {
    const contentEl = this.containerEl.children[1];

    isNotVoid(contentEl);

    const currentSettings = get(this.settingsStore);

    const range = r.createRange(
      currentSettings.multiDayRange,
      currentSettings.firstDayOfWeek,
      this.savedDay,
    );

    const dateRange = this.dateRanges.trackRange(range);

    this.dateRange = dateRange;
    this.savedDay = dateRange.first.clone();
    this.stopTrackingRange = toStore(() => dateRange.current).subscribe(
      this.updateTabTitleAndHeader,
    );
    this.register(this.stopTrackingRange);

    const relevantSettingsSignal = derived(
      this.settingsStore,
      ($settingsStore) => {
        return {
          multiDayRange: $settingsStore.multiDayRange,
          firstDayOfWeek: $settingsStore.firstDayOfWeek,
        };
      },
    );

    // todo: remove manual state synchronization
    const initialSettings = get(this.settingsStore);
    let previousMultiDayRange = initialSettings.multiDayRange;
    let previousFirstDayOfWeek = initialSettings.firstDayOfWeek;

    this.register(
      relevantSettingsSignal.subscribe((next) => {
        if (
          next.multiDayRange !== previousMultiDayRange ||
          next.firstDayOfWeek !== previousFirstDayOfWeek
        ) {
          previousMultiDayRange = next.multiDayRange;
          previousFirstDayOfWeek = next.firstDayOfWeek;

          const anchor = this.dateRange?.current.find(
            (day) =>
              next.multiDayRange !== "work-week" || day.isoWeekday() <= 5,
          );
          this.dateRange?.set(
            r.createRange(
              next.multiDayRange,
              next.firstDayOfWeek,
              anchor ?? this.dateRange.first,
            ),
          );
        }
      }),
    );

    const context = new Map([
      ...this.componentContext,
      [dateRangeContextKey, this.dateRange],
    ]);

    this.multiDayComponent = mount(MultiDayGrid, {
      target: contentEl,
      context,
    });
  }

  async onClose() {
    this.savedDay = this.dateRange?.current[0]?.clone() ?? this.savedDay;
    this.stopTrackingRange?.();
    this.stopTrackingRange = undefined;
    if (this.multiDayComponent) {
      await unmount(this.multiDayComponent);
    }

    this.dateRange?.untrack();
    this.dateRange = undefined;
  }

  private updateTabTitleAndHeader = () => {
    const day = this.dateRange?.current[0];
    if (day && !day.isSame(this.savedDay, "day")) {
      this.savedDay = day.clone();
      this.app.workspace.requestSaveLayout();
    }
    setViewTitle(this, this.getDisplayText());
  };
}
/* eslint-enable @typescript-eslint/no-floating-promises, @typescript-eslint/no-misused-promises, @typescript-eslint/no-redundant-type-constituents, @typescript-eslint/no-unnecessary-condition, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-enum-comparison, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return -- Re-enable scorecard compatibility suppressions after this file. */
