import type { Plugin } from "obsidian";

import type { TaskCapture } from "./capture";
import { TaskDeletionController } from "./deletion";
import type { TaskReconciler } from "./reconcile";
import type { TaskScheduler } from "./schedule";
import type { TaskService } from "./service";

export function createTaskDeletionController(
  plugin: Plugin,
  service: TaskService,
  capture: TaskCapture,
  scheduler: TaskScheduler,
  reconciler: TaskReconciler,
) {
  const controller = new TaskDeletionController(
    service,
    capture,
    scheduler,
    reconciler,
  );
  let ready = false;
  plugin.app.workspace.onLayoutReady(() => {
    ready = true;
    void controller.resume();
  });
  plugin.register(
    service.state.subscribe((state) => {
      controller.publish();
      if (ready && !state.loading) void controller.resume();
    }),
  );
  let previous = "";
  plugin.register(
    scheduler.state.subscribe((state) => {
      const next = JSON.stringify(
        state.operations.map((item) => ({
          id: item.id,
          phase: item.phase,
          error: item.error,
        })),
      );
      if (previous === next) return;
      previous = next;
      if (ready) void controller.resume();
    }),
  );
  plugin.registerInterval(
    window.setInterval(() => {
      if (ready) void controller.resume();
    }, 30_000),
  );
  plugin.register(() => controller.stop());
  return controller;
}
