import type { TaskCapture } from "./capture";
import type { CaptureCandidate } from "./capture-parser";
import { pendingTaskDeletion } from "./deletion-types";
import {
  pendingTaskOccurrence,
  recordExternalTaskOccurrence,
} from "./occurrence-types";
import { taskCaptureTagRemoved } from "./reconcile-markdown";
import type { TaskService } from "./service";
import type { TaskSnapshot } from "./types";

export async function observeExternalTaskOccurrences(
  service: TaskService,
  capture: TaskCapture,
  snapshot: TaskSnapshot,
  active: () => boolean,
) {
  let changed = false;
  let candidates: CaptureCandidate[] | undefined;
  const state = service.registry.snapshot();
  const tasks = new Map(snapshot.tasks.map((task) => [task.id, task]));
  for (const [uid, link] of Object.entries(state.links)) {
    if (!active()) return;
    if (
      link.provider !== snapshot.provider ||
      link.accountId !== snapshot.account.id ||
      !link.taskId ||
      !link.base?.due?.recurring ||
      link.base.completionCount === undefined ||
      pendingTaskOccurrence(state, link, link.taskId) ||
      pendingTaskDeletion(state, link, link.taskId)
    )
      continue;
    const next =
      tasks.get(link.taskId) ?? (await service.readTask(link.taskId));
    if (
      !next ||
      next.completionCount === undefined ||
      next.completionCount <= link.base.completionCount ||
      !active()
    )
      continue;
    candidates ??= capture.candidates();
    const candidate = candidates.find((item) => item.uid === uid);
    if (
      candidate &&
      taskCaptureTagRemoved((link.noteBase ?? link.source).raw, candidate)
    )
      continue;
    const observed = await service.registry.change((state) => {
      if (
        !active() ||
        JSON.stringify(state.links[uid]) !== JSON.stringify(link)
      )
        return false;
      return recordExternalTaskOccurrence(state, snapshot, uid, next);
    });
    changed ||= observed;
  }
  if (changed && active()) service.publish();
}
