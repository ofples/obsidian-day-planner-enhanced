import { get } from "svelte/store";

import { getTimeRangeMatch } from "../parser/parser";

import type { TaskCapture } from "./capture";
import {
  taskAccountSettings,
  type TaskCaptureSettings,
} from "./capture-settings";
import { rewriteTaskNote } from "./reconcile-markdown";
import type { TaskScheduler } from "./schedule";
import type { TaskService } from "./service";
import { TaskReadError, type TaskSnapshot } from "./types";

/** Freeze the old note through the existing journal while preserving the next task. */
export async function freezeTaskOccurrences(
  service: TaskService,
  capture: TaskCapture,
  scheduler: TaskScheduler,
  snapshot: TaskSnapshot,
  settings: TaskCaptureSettings,
  active: () => boolean,
) {
  let changed = false;
  const records = Object.values(service.registry.snapshot().occurrences).filter(
    (record) =>
      record.provider === snapshot.provider &&
      record.accountId === snapshot.account.id &&
      record.phase === "freezing",
  );
  for (const record of records) {
    if (!active()) return;
    try {
      const state = service.registry.snapshot();
      const completion = state.operations.find(
        (operation) => operation.id === record.id,
      );
      if (completion?.status !== "complete") continue;
      const pending = state.schedules.filter(
        (operation) =>
          operation.occurrenceId === record.id &&
          !["complete", "cancelled"].includes(operation.phase),
      );
      if (pending.length) {
        await scheduler.resume();
        const error = get(scheduler.state).operations.find(
          (operation) => operation.occurrenceId === record.id,
        )?.error;
        if (error) throw new TaskReadError(error);
        continue;
      }
      const inspection = await capture.inspectCurrentIdentities();
      for (const [uid, original] of Object.entries(record.before.links).filter(
        ([, link]) => link.taskId === record.before.task.id,
      )) {
        if (!active()) return;
        const current = service.registry.snapshot();
        if (current.occurrences[record.id]?.phase !== "freezing") break;
        const link = current.links[uid];
        if (!link) {
          if (current.occurrences[record.id]!.links[uid]) continue;
          throw new TaskReadError(
            "Restore the historical note link before freezing this occurrence.",
          );
        }
        const candidate = inspection.candidates.find(
          (item) => item.uid === uid,
        );
        if (!candidate)
          throw new TaskReadError(
            "The completed occurrence's note is missing or ambiguous. Restore one original block, then retry its history.",
          );
        if (!(await capture.sourceIsCurrent(candidate))) continue;
        const timed = Boolean(
          getTimeRangeMatch(candidate.raw.split(/\r?\n/)[0] ?? ""),
        );
        const blocks = timed ? await scheduler.scanNotes() : [];
        const block = blocks.find(
          (item) =>
            item.path === candidate.path &&
            item.from === candidate.from &&
            item.raw === candidate.raw,
        );
        if (timed && !block)
          throw new TaskReadError(
            "Restore the completed occurrence's calendar block before freezing its history.",
          );
        if (!active() || !(await capture.sourceIsCurrent(candidate))) continue;
        const task = { ...record.before.task, completed: true };
        if (
          link.provider !== record.provider ||
          link.accountId !== record.accountId ||
          link.taskId !== original.taskId
        )
          throw new TaskReadError(
            "The historical note belongs to another task or account. Review its original link.",
          );
        await scheduler.reconcile({
          linkUid: uid,
          task,
          source: candidate,
          raw: rewriteTaskNote(
            candidate.raw,
            task,
            taskAccountSettings(settings, snapshot),
            ["completed"],
          ),
          interval: block
            ? { start: block.snapshot.start, end: block.snapshot.end }
            : null,
          googleUid: block?.uid,
          mutations: [],
          expectedLink: link,
          occurrenceId: record.id,
        });
      }
    } catch (error) {
      if (!active()) return;
      const updated = await service.registry.change((state) => {
        const saved = state.occurrences[record.id];
        const message =
          error instanceof Error
            ? error.message
            : "The completed occurrence's note needs review.";
        if (saved?.phase === "freezing" && saved.error !== message) {
          saved.error = message;
          return true;
        }
        return false;
      });
      changed ||= updated;
    }
  }
  if (changed && active()) service.publish();
}
