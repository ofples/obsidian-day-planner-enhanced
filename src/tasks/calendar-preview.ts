import { DateTime } from "luxon";

import { getTimeRangeMatch } from "../parser/parser";
import type { DayPlannerSettings } from "../settings";
import type {
  EditableTimeBlock,
  RemoteTimeBlock,
  WithDuration,
} from "../time-block-types";

import { sameTaskField } from "./operations";
import type { TaskRegistryState } from "./registry";
import { newTaskMarkdown } from "./schedule-markdown";
import { taskOccurrenceKey } from "./schedule-types";
import type { TaskBrowserState } from "./service";
import type { ProviderTask } from "./types";
import { taskLinkIdentity } from "./weak-links";

/** Dated provider tasks are visible without creating notes or calendar events.
 * A canonical Markdown link owns the display after an occurrence is scheduled. */
export function taskCalendarPreviews(
  browser: Pick<TaskBrowserState, "connected" | "snapshot">,
  registry: Pick<TaskRegistryState, "links"> &
    Partial<Pick<TaskRegistryState, "projections">>,
  settings: DayPlannerSettings,
  localBlocks: EditableTimeBlock[] = [],
): WithDuration<RemoteTimeBlock>[] {
  const snapshot = browser.snapshot;
  if (!browser.connected || !snapshot) return [];
  const weakLinks = new Map<string, Set<string | undefined>>();
  if (snapshot.provider === "todoist") {
    for (const block of localBlocks) {
      if (block.source === "unwritten") continue;
      const pending: Array<{
        text: string;
        children?: import("../redux/index/index-slice").ListItemEntryWithChildren[];
      }> = [block];
      while (pending.length) {
        const item = pending.pop()!;
        const link =
          typeof item.text === "string"
            ? taskLinkIdentity(item.text)
            : undefined;
        if (link) {
          const occurrences = weakLinks.get(link.taskId) ?? new Set();
          occurrences.add(link.occurrence);
          weakLinks.set(link.taskId, occurrences);
        }
        if (item.children) pending.push(...item.children);
      }
    }
  }
  const linked = new Map<string, (ProviderTask | null)[]>();
  for (const [uid, link] of Object.entries(registry.links)) {
    if (
      link.provider !== snapshot.provider ||
      link.accountId !== snapshot.account.id ||
      !link.taskId
    )
      continue;
    const represented =
      registry.projections?.[uid]?.interval ||
      getTimeRangeMatch(link.source.raw.split(/\r?\n/)[0] ?? "") ||
      localBlocks.some(
        (block) =>
          block.source !== "unwritten" &&
          block.path === link.source.path &&
          link.source.from >= block.position.start.offset &&
          link.source.from < block.position.end.offset,
      );
    if (!represented) continue;
    const occurrences = linked.get(link.taskId) ?? [];
    occurrences.push(link.base);
    linked.set(link.taskId, occurrences);
  }
  return snapshot.tasks.flatMap((task): WithDuration<RemoteTimeBlock>[] => {
    if (
      task.completed ||
      !task.due ||
      task.id.startsWith("local-") ||
      (weakLinks.has(task.id) &&
        (!task.due.recurring ||
          weakLinks
            .get(task.id)
            ?.has(String(task.completionCount ?? task.due.date)))) ||
      linked
        .get(task.id)
        ?.some(
          (base) =>
            !base ||
            !task.due?.recurring ||
            (base.completionCount !== undefined &&
            task.completionCount !== undefined
              ? taskOccurrenceKey(base) === taskOccurrenceKey(task)
              : sameTaskField(
                  base.due,
                  task.due,
                  "due",
                  snapshot.account.timezone,
                )),
        )
    )
      return [];
    const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(task.due.date);
    const date = DateTime.fromISO(task.due.date, {
      zone: dateOnly
        ? DateTime.local().zoneName
        : (task.due.timezone ?? snapshot.account.timezone),
    });
    if (!date.isValid) return [];
    const startTime = dateOnly
      ? window.moment(task.due.date, "YYYY-MM-DD", true)
      : window.moment(date.toISO());
    if (!startTime.isValid()) return [];
    const durationMinutes = task.duration
      ? task.duration.amount * (task.duration.unit === "day" ? 1440 : 1)
      : settings.defaultDurationMinutes;
    return [
      {
        id: `task:${JSON.stringify([snapshot.provider, snapshot.account.id, task.id, taskOccurrenceKey(task)])}`,
        source: "ical",
        taskSource: {
          provider: snapshot.provider,
          accountId: snapshot.account.id,
          taskId: task.id,
        },
        startTime,
        durationMinutes: dateOnly ? 1440 : durationMinutes,
        isAllDayEvent: dateOnly,
        summary: task.title,
        description: newTaskMarkdown(task, [], snapshot, settings.taskCapture),
        rsvpStatus: "ACCEPTED",
        calendar: {
          name: snapshot.provider,
          url: "",
          color: "var(--interactive-accent)",
        },
      },
    ];
  });
}
