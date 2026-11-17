import { DateTime } from "luxon";

import type { PlanningDraft } from "../ai-scheduling/service";
import { withoutDisplayedControlTags } from "../util/task-lock";

export interface ProposalOverlay {
  id: string;
  title: string;
  kind: "schedule" | "move" | "add-to-frame";
  selected: boolean;
  top: number;
  height: number;
}

/** Calculate review-only positions without modifying the timeline's real blocks. */
export function proposalOverlays(
  draft: PlanningDraft | null,
  day: string,
  startHour: number,
  endHour: number,
  zoom: number,
): ProposalOverlay[] {
  if (!draft) return [];
  const { context, proposal, selectedIds, acceptedIds, rejectedIds } = draft;
  const frameCounts = new Map<string, number>();
  return proposal.actions.flatMap((action) => {
    if (acceptedIds.includes(action.id) || rejectedIds.includes(action.id))
      return [];
    const source = [...context.tasks, ...context.blocks].find(
      (item) => item.ref === action.sourceRef,
    );
    const frame =
      action.kind === "add-to-frame"
        ? context.blocks.find((block) => block.ref === action.frameRef)
        : undefined;
    const startValue =
      action.kind === "add-to-frame" ? frame?.start : action.start;
    const endValue = action.kind === "add-to-frame" ? frame?.end : action.end;
    if (!source || !startValue || !endValue) return [];
    const start = DateTime.fromISO(startValue, { setZone: true }).setZone(
      context.timezone,
    );
    const end = DateTime.fromISO(endValue, { setZone: true }).setZone(
      context.timezone,
    );
    if (!start.isValid || !end.isValid || start.toISODate() !== day) return [];
    const startMinutes = start.hour * 60 + start.minute;
    const endMinutes =
      end.toISODate() === day ? end.hour * 60 + end.minute : 1440;
    const clippedStart = Math.max(startMinutes, startHour * 60);
    const clippedEnd = Math.min(endMinutes, endHour * 60);
    if (clippedEnd <= clippedStart) return [];
    const frameOffset = frame ? (frameCounts.get(frame.ref) ?? 0) : 0;
    if (frame) frameCounts.set(frame.ref, frameOffset + 1);
    return [
      {
        id: action.id,
        title: withoutDisplayedControlTags(source.title),
        kind: action.kind,
        selected: selectedIds.includes(action.id),
        top: (clippedStart - startHour * 60) * zoom + frameOffset * 24,
        height: (clippedEnd - clippedStart) * zoom,
      },
    ];
  });
}
