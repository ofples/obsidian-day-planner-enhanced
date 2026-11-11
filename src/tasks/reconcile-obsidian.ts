import type { Plugin } from "obsidian";
import { get, type Writable } from "svelte/store";

import type { DayPlannerSettings } from "../settings";

import type { TaskCapture } from "./capture";
import { TaskReconciler } from "./reconcile";
import type { TaskScheduler } from "./schedule";
import type { TaskService } from "./service";

export function createTaskReconciler(
  plugin: Plugin,
  service: TaskService,
  capture: TaskCapture,
  scheduler: TaskScheduler,
  settings: Writable<DayPlannerSettings>,
) {
  const reconciler = new TaskReconciler(
    service,
    capture,
    scheduler,
    () => get(settings).taskCapture,
  );
  let ready = false;
  plugin.app.workspace.onLayoutReady(() => {
    ready = true;
    void reconciler.scan();
  });
  let previous = get(service.state).snapshot;
  plugin.register(
    service.state.subscribe((state) => {
      reconciler.publish();
      if (
        ready &&
        state.writable &&
        !state.loading &&
        state.snapshot !== previous
      ) {
        previous = state.snapshot;
        void reconciler.scan();
      }
    }),
  );
  plugin.register(
    capture.state.subscribe(() => {
      if (ready && !reconciler.running) void reconciler.scan();
    }),
  );
  let pending = get(scheduler.state).operations.length;
  plugin.register(
    scheduler.state.subscribe((state) => {
      const completed = pending > 0 && state.operations.length === 0;
      pending = state.operations.length;
      if (ready && completed) void reconciler.scan();
    }),
  );
  plugin.registerInterval(
    window.setInterval(() => {
      if (ready) void reconciler.scan();
    }, 30_000),
  );
  plugin.register(() => reconciler.stop());
  return reconciler;
}
