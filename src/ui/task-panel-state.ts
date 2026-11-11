import type { CaptureIssue } from "../tasks/capture";
import type { ProviderTask } from "../tasks/types";

export type TaskPanelAction =
  | { kind: "create"; parent?: ProviderTask }
  | { kind: "edit"; task: ProviderTask }
  | { kind: "schedule"; task: ProviderTask }
  | { kind: "connect" }
  | { kind: "settings" }
  | { kind: "route"; issue: CaptureIssue }
  | { kind: "unschedule"; task: ProviderTask }
  | {
      kind: "unlink";
      linkUid: string;
      title: string;
      restoreTagOnCancel?: boolean;
    }
  | { kind: "conflict"; id: string; source: boolean };
