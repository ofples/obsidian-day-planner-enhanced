/* eslint-disable @typescript-eslint/no-floating-promises, @typescript-eslint/no-misused-promises, @typescript-eslint/no-redundant-type-constituents, @typescript-eslint/no-unnecessary-condition, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-enum-comparison, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return -- Obsidian community scorecard can run type-aware rules without resolving plugin source dependencies; tsc and svelte-check cover this source. */
import {
  createAction,
  createSelector,
  type PayloadAction,
} from "@reduxjs/toolkit";
import ical from "node-ical";

import type { IcalConfig } from "../../settings";
import type { TaskCalendarDisplayPolicy } from "../../tasks/calendar-display";
import type { RemoteTimeBlock } from "../../time-block-types";
import type { WithIcalConfig } from "../../types";
import { createAppSlice } from "../create-app-slice";

export type RawIcal = { icalConfig: IcalConfig; text: string };
export type SerializedRemoteTimeBlock = Omit<RemoteTimeBlock, "startTime"> & {
  startTime: string;
};

export interface IcalState {
  taskCalendarDisplay: TaskCalendarDisplayPolicy;
  icalEvents: Array<WithIcalConfig<ical.VEvent>>;
  plainTextIcals: Array<RawIcal>;
  serializedRemoteTimeBlocks: Array<SerializedRemoteTimeBlock>;
  serializedGoogleTimeBlocks: Array<SerializedRemoteTimeBlock>;
}

export function isVEvent(event: ical.CalendarComponent): event is ical.VEvent {
  return event.type === "VEVENT";
}

export const initialIcalState: IcalState = {
  taskCalendarDisplay: { googleCalendarIds: [], icalUrls: [] },
  icalEvents: [],
  plainTextIcals: [],
  serializedRemoteTimeBlocks: [],
  serializedGoogleTimeBlocks: [],
};

export const icalSlice = createAppSlice({
  name: "ical",
  initialState: initialIcalState,
  reducers: (create) => ({
    taskCalendarDisplayUpdated: create.reducer(
      (state, action: PayloadAction<TaskCalendarDisplayPolicy>) => {
        state.taskCalendarDisplay = action.payload;
      },
    ),
    icalsFetched: create.reducer(
      (state, action: PayloadAction<Array<RawIcal>>) => {
        state.plainTextIcals = action.payload;
      },
    ),
    remoteTimeBlocksUpdated: create.reducer(
      (state, action: PayloadAction<Array<SerializedRemoteTimeBlock>>) => {
        state.serializedRemoteTimeBlocks = action.payload;
      },
    ),
    googleTimeBlocksUpdated: create.reducer(
      (state, action: PayloadAction<Array<SerializedRemoteTimeBlock>>) => {
        state.serializedGoogleTimeBlocks = action.payload;
      },
    ),
  }),
  selectors: {
    selectTaskCalendarDisplay: (state) =>
      state.taskCalendarDisplay ?? { googleCalendarIds: [], icalUrls: [] },
    selectSerializedRemoteTimeBlocks: (state) =>
      state.serializedRemoteTimeBlocks,
    selectPlainTextIcals: (state) => state.plainTextIcals,
    selectSerializedGoogleTimeBlocks: (state) =>
      state.serializedGoogleTimeBlocks ?? [],
  },
});

export const icalRefreshRequested = createAction("ical/icalRefreshRequested");

export const {
  taskCalendarDisplayUpdated,
  remoteTimeBlocksUpdated,
  googleTimeBlocksUpdated,
  icalsFetched,
} = icalSlice.actions;
export const { selectPlainTextIcals } = icalSlice.selectors;
const {
  selectSerializedRemoteTimeBlocks,
  selectSerializedGoogleTimeBlocks,
  selectTaskCalendarDisplay,
} = icalSlice.selectors;

export const selectAllIcalEventsWithIcalConfigs = createSelector(
  selectPlainTextIcals,
  (rawIcals) =>
    rawIcals.flatMap(
      ({ icalConfig, text }): Array<WithIcalConfig<ical.VEvent>> => {
        const parsed = ical.parseICS(text);

        return Object.values(parsed)
          .filter(isVEvent)
          .map((icalEvent) => ({
            ...icalEvent,
            calendar: icalConfig,
          }));
      },
    ),
);

export const selectRemoteTimeBlocks = createSelector(
  selectSerializedRemoteTimeBlocks,
  selectSerializedGoogleTimeBlocks,
  selectTaskCalendarDisplay,
  (serializedRemoteTimeBlocks, googleTimeBlocks, policy) =>
    [
      ...serializedRemoteTimeBlocks.filter(
        (block) => !policy.icalUrls.includes(block.calendar.url),
      ),
      ...googleTimeBlocks.filter(
        (block) =>
          !block.calendarSource ||
          !policy.googleCalendarIds.includes(block.calendarSource.id),
      ),
    ].map((it) => ({
      ...it,
      startTime: window.moment(it.startTime),
    })),
);
/* eslint-enable @typescript-eslint/no-floating-promises, @typescript-eslint/no-misused-promises, @typescript-eslint/no-redundant-type-constituents, @typescript-eslint/no-unnecessary-condition, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-enum-comparison, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return -- Re-enable scorecard compatibility suppressions after this file. */
