import { getTimeRangeMatch } from "../parser/parser";

import { captureTitle, type CaptureCandidate } from "./capture-parser";
import type { ProviderTask } from "./types";
import { taskLinkIdentity } from "./weak-links";

export interface WeakSyncHost {
  candidates(): CaptureCandidate[];
  tasks(): ProviderTask[];
  enabled(): boolean;
  read(path: string): Promise<string | null>;
  write(path: string, before: string, after: string): Promise<boolean>;
  getTask(id: string): Promise<ProviderTask | null>;
  change(
    task: ProviderTask,
    change: { title?: string } | "complete" | "reopen",
  ): Promise<void>;
}

type Baseline = {
  title: string;
  completed: boolean;
  remoteTitle: string;
  remoteCompleted: boolean;
  remoteOccurrence: string;
};

function protectedSpans(
  candidate: CaptureCandidate,
  line: string,
): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  const prefix = line.match(/^(?:[-*+]|\d+[.)])\s+\[[^\]]\]\s*/)?.[0];
  if (prefix) spans.push([0, prefix.length]);
  const time = getTimeRangeMatch(line);
  if (time) spans.push([time.startIndex, time.endIndex]);
  for (const tag of candidate.tags)
    spans.push([tag.from - candidate.from, tag.to - candidate.from]);
  for (const match of line.matchAll(/\[[^\]]*\]\([^\n)]*\)/g)) {
    if (taskLinkIdentity(match[0]))
      spans.push([match.index, match.index + match[0].length]);
  }
  return spans;
}
function titleOf(candidate: CaptureCandidate, line: string) {
  const chars = line.split("");
  // Replace only links here; captureTitle removes the time and tags using indexed offsets.
  for (const match of line.matchAll(/\[[^\]]*\]\([^\n)]*\)/g))
    if (taskLinkIdentity(match[0]))
      for (let i = match.index; i < match.index + match[0].length; i++)
        chars[i] = " ";
  return captureTitle(
    { ...candidate, raw: chars.join("") },
    new Set(candidate.tags.map((tag) => tag.name)),
  );
}
function replaceTitle(
  candidate: CaptureCandidate,
  line: string,
  title: string,
) {
  const mask = Array.from({ length: line.length }, () => false);
  for (const [start, end] of protectedSpans(candidate, line))
    for (let i = Math.max(0, start); i < Math.min(line.length, end); i++)
      mask[i] = true;
  const runs: Array<[number, number]> = [];
  let start = 0;
  while (start < line.length) {
    if (mask[start] || /\s/.test(line[start]!)) {
      start++;
      continue;
    }
    let end = start + 1;
    while (end < line.length && !mask[end]) end++;
    while (end > start && /\s/.test(line[end - 1]!)) end--;
    runs.push([start, end]);
    start = end;
  }
  if (!runs.length) return line;
  let result = line;
  for (let i = runs.length - 1; i >= 0; i--) {
    const [from, to] = runs[i]!;
    result = result.slice(0, from) + (i === 0 ? title : "") + result.slice(to);
  }
  return result;
}
const occurrenceOf = (task: ProviderTask) =>
  String(task.completionCount ?? task.due?.date ?? "");

/** A deliberately in-memory baseline: startup observations never become local edits. */
export class WeakTaskSync {
  private baseline = new Map<string, Baseline>();
  private running = false;
  private again = false;
  private stopped = false;
  private missing = new Map<string, ProviderTask | null>();
  constructor(private readonly host: WeakSyncHost) {}
  stop() {
    this.stopped = true;
  }
  async scan(): Promise<void> {
    if (this.stopped || !this.host.enabled()) return;
    if (this.running) {
      this.again = true;
      return;
    }
    this.running = true;
    try {
      do {
        this.again = false;
        await this.run();
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- Other scans and stop can update these flags while run awaits.
      } while (this.again && !this.stopped);
    } finally {
      this.running = false;
    }
  }
  private async run() {
    const candidates = this.host.candidates();
    const tasks = new Map(this.host.tasks().map((task) => [task.id, task]));
    const fetched = this.missing;
    const seen = new Set<string>();
    const ordinals = new Map<string, number>();
    const acted = new Set<string>();
    for (const candidate of candidates) {
      if (this.stopped || !this.host.enabled()) return;
      const line = candidate.raw.split(/\r?\n/, 1)[0] ?? "";
      const identity = taskLinkIdentity(line);
      if (!identity) continue;
      const group = `${candidate.path}\0${identity.url}`;
      const ordinal = ordinals.get(group) ?? 0;
      ordinals.set(group, ordinal + 1);
      const key = `${group}\0${ordinal}`;
      seen.add(key);
      let task = tasks.get(identity.taskId);
      if (task) fetched.delete(identity.taskId);
      if (!task) {
        if (!fetched.has(identity.taskId)) {
          try {
            fetched.set(
              identity.taskId,
              await this.host.getTask(identity.taskId),
            );
          } catch {
            fetched.set(identity.taskId, null);
          }
        }
        task = fetched.get(identity.taskId) ?? undefined;
      }
      if (!task) continue;
      const title = titleOf(candidate, line);
      const current = {
        title,
        completed: candidate.completed,
        remoteTitle: task.title,
        remoteCompleted: task.completed,
        remoteOccurrence: occurrenceOf(task),
      };
      const previous = this.baseline.get(key);
      this.baseline.set(key, current);
      if (!previous) continue;
      const localTitle = title !== previous.title;
      const remoteTitle = task.title !== previous.remoteTitle;
      const localCompletion = candidate.completed !== previous.completed;
      const remoteCompletion = task.completed !== previous.remoteCompleted;
      const actionKey = `${identity.url}\0${identity.occurrence ?? ""}`;
      try {
        if (
          localTitle &&
          !remoteTitle &&
          title &&
          !acted.has(`${actionKey}:title`)
        ) {
          acted.add(`${actionKey}:title`);
          await this.host.change(task, { title });
        }
        const occurrenceMatches =
          !task.due?.recurring ||
          (identity.occurrence !== undefined &&
            identity.occurrence === occurrenceOf(task));
        if (
          localCompletion &&
          occurrenceMatches &&
          !acted.has(`${actionKey}:completion`)
        ) {
          acted.add(`${actionKey}:completion`);
          await this.host.change(
            task,
            candidate.completed ? "complete" : "reopen",
          );
        }
        const pullTitle = remoteTitle && !localTitle;
        const advanced = Boolean(
          task.due?.recurring &&
            identity.occurrence &&
            previous.remoteOccurrence === identity.occurrence &&
            current.remoteOccurrence !== previous.remoteOccurrence &&
            (Number.isFinite(Number(identity.occurrence)) &&
            Number.isFinite(Number(current.remoteOccurrence))
              ? Number(current.remoteOccurrence) > Number(identity.occurrence)
              : current.remoteOccurrence > identity.occurrence),
        );
        const pullCompletion =
          !localCompletion &&
          (advanced ||
            (remoteCompletion && (!task.due?.recurring || occurrenceMatches)));
        const completed = advanced || task.completed;
        if (pullTitle || pullCompletion) {
          const before = await this.host.read(candidate.path);
          if (
            before === null ||
            before.slice(candidate.from, candidate.from + line.length) !== line
          )
            continue;
          let afterLine = line;
          if (pullTitle) {
            afterLine = replaceTitle(candidate, line, task.title);
          }
          if (pullCompletion)
            afterLine = afterLine.replace(
              /^(\s*(?:[-*+]|\d+[.)])\s+\[)[^\]](\])/,
              `$1${completed ? "x" : " "}$2`,
            );
          const after =
            before.slice(0, candidate.from) +
            afterLine +
            before.slice(candidate.from + line.length);
          if (await this.host.write(candidate.path, before, after))
            this.baseline.set(key, {
              ...current,
              title: pullTitle ? task.title : title,
              completed: pullCompletion ? completed : candidate.completed,
            });
        }
      } catch {
        /* Best effort; a later user edit can retry. */
      }
    }
    for (const key of this.baseline.keys())
      if (!seen.has(key)) this.baseline.delete(key);
  }
}
