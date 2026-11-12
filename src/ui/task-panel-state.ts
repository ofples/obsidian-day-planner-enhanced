import type { CaptureIssue } from "../tasks/capture";
import type { ProviderTask } from "../tasks/types";

export type TaskPanelAction =
  | { kind: "create"; parent?: ProviderTask }
  | { kind: "edit"; task: ProviderTask }
  | { kind: "schedule"; task: ProviderTask }
  | { kind: "connect" }
  | { kind: "settings" }
  | { kind: "calendars" }
  | { kind: "delete"; task: ProviderTask; replaces?: string }
  | { kind: "deleted-record"; id: string }
  | { kind: "occurrence"; id: string }
  | { kind: "identity"; linkUid: string }
  | { kind: "identity-record"; id: string }
  | { kind: "route"; issue: CaptureIssue }
  | { kind: "unschedule"; task: ProviderTask }
  | {
      kind: "unlink";
      linkUid: string;
      title: string;
      restoreTagOnCancel?: boolean;
    }
  | { kind: "conflict"; id: string; source: boolean };
