import type { Plugin } from "obsidian";
import { get, type Writable } from "svelte/store";

import { taskCalendarDisplayUpdated } from "../redux/ical/ical-slice";
import type { AppStore } from "../redux/store";
import type { DayPlannerSettings } from "../settings";

import {
  taskAccountSettings,
  type TaskCaptureSettings,
} from "./capture-settings";
import type { TaskBrowserState, TaskService } from "./service";

export interface TaskCalendarDisplayPolicy {
  googleCalendarIds: string[];
  icalUrls: string[];
}

export function taskCalendarDisplayPolicy(
  state: Pick<TaskBrowserState, "connected" | "snapshot">,
  settings: TaskCaptureSettings,
): TaskCalendarDisplayPolicy {
  const policy = state.snapshot
    ? taskAccountSettings(settings, state.snapshot).calendarDisplay
    : undefined;
  return state.connected && policy?.enabled
    ? { googleCalendarIds: policy.googleCalendarIds, icalUrls: policy.icalUrls }
    : { googleCalendarIds: [], icalUrls: [] };
}

export function registerTaskCalendarDisplay(
  plugin: Plugin,
  service: TaskService,
  settings: Writable<DayPlannerSettings>,
  store: AppStore,
) {
  let previous = "";
  const publish = () => {
    const policy = taskCalendarDisplayPolicy(
      get(service.state),
      get(settings).taskCapture,
    );
    const serialized = JSON.stringify(policy);
    if (serialized === previous) return;
    previous = serialized;
    store.dispatch(taskCalendarDisplayUpdated(policy));
  };
  plugin.register(service.state.subscribe(publish));
  plugin.register(settings.subscribe(publish));
  plugin.register(() =>
    store.dispatch(
      taskCalendarDisplayUpdated({ googleCalendarIds: [], icalUrls: [] }),
    ),
  );
}
