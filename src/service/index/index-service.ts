import type { CachedMetadata } from "obsidian";

import type {
  FileSystemEntry,
  ListItemEntry,
  LogEntry,
  PlanEntry,
} from "../../redux/index/index-slice";
import type { CaptureCandidate } from "../../tasks/capture-parser";

export interface FileWithMetadata {
  path: string;
  text: string;
  metadata: CachedMetadata;
}

export interface FileIndexContribution {
  captureEntries?: CaptureCandidate[];
  listItemEntries?: ListItemEntry[];
  fileEntries?: FileSystemEntry[];
  logEntries?: LogEntry[];
  planEntries?: PlanEntry[];
}

export interface IndexService {
  index(props: FileWithMetadata): FileIndexContribution;
}
