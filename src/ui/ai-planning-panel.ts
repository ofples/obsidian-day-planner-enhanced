import type { Readable } from "svelte/store";

import type {
  PlanningBatch,
  PlanningBucket,
  PlanningContext,
  PlanningIssue,
  PlanningPreferences,
  PlanningProposal,
  PlanningTask,
} from "../ai-scheduling/types";

export interface PlanningPanelState {
  ready: boolean;
  recoveryRequired?: boolean;
  busy: boolean;
  error: string;
  context: PlanningContext | null;
  draft: {
    context: PlanningContext;
    proposal: PlanningProposal;
    selectedIds: string[];
    acceptedIds: string[];
    rejectedIds: string[];
  } | null;
  taskView: {
    contextId: string;
    tasks: PlanningTask[];
    buckets: PlanningBucket[];
  } | null;
  lastBatch: {
    phase: "prepared" | "applied" | "undoing" | "cleanup" | "undone";
    batch: PlanningBatch;
  } | null;
  issues: PlanningIssue[];
}

export interface PlanningPanelService {
  readonly state: Readable<PlanningPanelState>;
  readonly visible: Readable<boolean>;
  getDefaults(): {
    startDate: string;
    dayCount: number;
    request: string;
    preferences: PlanningPreferences;
  };
  getContext(input?: unknown): Promise<unknown>;
  submitProposal(input: unknown): Promise<unknown>;
  selectAction(id: string, selected: boolean): void | Promise<unknown>;
  dismissAction(id: string): void | Promise<unknown>;
  dismissDraft(): void | Promise<unknown>;
  applySelected(): Promise<unknown>;
  undo(): Promise<unknown>;
  retry(): Promise<unknown>;
  clearTaskView(): void | Promise<unknown>;
  resetSavedState?(): Promise<void>;
  savePreferences(preferences: PlanningPreferences): void | Promise<unknown>;
  show(): void;
  hide(): void;
}
