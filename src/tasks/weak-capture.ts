import { get } from "svelte/store";
import { z } from "zod";

import { locateSource } from "../service/source-identity";

import { routeCapture } from "./capture";
import {
  parseCaptureCandidates,
  type CaptureCandidate,
} from "./capture-parser";
import {
  capturePathEnabled,
  type TaskCaptureSettings,
} from "./capture-settings";
import { taskOperationSchema, type TaskOperation } from "./operations";
import type { TaskService } from "./service";
import { TaskReadError } from "./types";
import { formatTaskLink, taskLinkUrl } from "./weak-links";

const receiptSchema = z.object({
  operation: taskOperationSchema,
  path: z.string().min(1),
  from: z.number().int().nonnegative(),
  raw: z.string().min(1),
  after: z.string().optional(),
  taskId: z.string().min(1).optional(),
  serverRetryAt: z.number().optional(),
});
const outboxSchema = z.object({
  version: z.literal(1),
  receipts: z.array(receiptSchema),
});
type Receipt = z.infer<typeof receiptSchema>;

export interface WeakCaptureHost {
  enabled(): boolean;
  candidates(): CaptureCandidate[];
  stable(candidate: CaptureCandidate): boolean;
  inScope?(path: string): boolean;
  settings(): TaskCaptureSettings;
  report?(message: string): void;
  read(path: string): Promise<string | null>;
  write(path: string, before: string, after: string): Promise<boolean>;
  load(): Promise<string | null>;
  save(value: string): Promise<void>;
}

function linkedRaw(candidate: CaptureCandidate, id: string) {
  const line = candidate.raw.split(/\r?\n/, 1)[0] ?? "";
  let first = line;
  for (const tag of candidate.tags
    .filter((tag) => tag.name.toLowerCase() === "todoist")
    .toReversed()) {
    const from = tag.from - candidate.from,
      to = tag.to - candidate.from;
    first = first.slice(0, from) + first.slice(to);
  }
  first = first.replace(/[ \t]+(?=\^[\w-]+\s*$)/, " ").trimEnd();
  const block = first.match(/\s+\^[\w-]+\s*$/)?.[0] ?? "";
  first =
    first.slice(0, first.length - block.length).trimEnd() +
    ` ${formatTaskLink(id)}` +
    block;
  return first + candidate.raw.slice(line.length);
}

/** Durable transport receipts only: the Markdown link remains the task identity. */
export class WeakTaskCapture {
  private receipts: Receipt[] = [];
  private loaded = false;
  private pending?: Promise<void>;
  private stopped = false;
  constructor(
    private service: TaskService,
    private host: WeakCaptureHost,
  ) {}
  stop() {
    this.stopped = true;
  }
  scan(manual = false): Promise<void> {
    if (this.stopped || !this.host.enabled()) return Promise.resolve();
    if (this.pending) return this.pending;
    const work = this.run(manual).catch((error: unknown) => {
      this.host.report?.(
        error instanceof Error
          ? error.message
          : "Todoist capture could not continue.",
      );
    });
    this.pending = work;
    return work.finally(() => {
      this.pending = undefined;
    });
  }
  private async save() {
    try {
      await this.host.save(
        JSON.stringify({ version: 1, receipts: this.receipts }),
      );
    } catch (error) {
      this.stopped = true;
      throw error;
    }
  }
  private async send(receipt: Receipt, manual: boolean) {
    const operation = receipt.operation;
    const now = Date.now();
    if ((receipt.serverRetryAt ?? 0) > now) return null;
    if (
      !manual &&
      (operation.attempts >= 3 || (operation.retryAt ?? 0) > now)
    ) {
      if (operation.attempts >= 3)
        this.host.report?.(
          "Todoist capture paused after three attempts. Use Sync to retry.",
        );
      return null;
    }
    if (manual && operation.attempts >= 3) operation.attempts = 0;
    operation.attempts++;
    operation.retryAt = now + 30_000 * 2 ** (operation.attempts - 1);
    await this.save();
    try {
      return await this.service.createWeak(operation);
    } catch (error) {
      if (error instanceof TaskReadError && error.retryAt) {
        receipt.serverRetryAt = error.retryAt;
        operation.retryAt = Math.max(operation.retryAt ?? 0, error.retryAt);
      }
      await this.save();
      throw error;
    }
  }
  private async run(manual: boolean) {
    if (!this.loaded) {
      const raw = await this.host.load();
      if (raw === null) this.receipts = [];
      else
        this.receipts = outboxSchema.parse(JSON.parse(raw) as unknown).receipts;
    }
    this.loaded = true;
    const state = get(this.service.state);
    if (!state.connected || !state.snapshot || !this.host.enabled()) return;
    const snapshot = state.snapshot;
    const candidates = this.host.candidates();
    for (const receipt of [...this.receipts]) {
      if (this.stopped || !this.host.enabled()) return;
      if (
        this.host.inScope?.(receipt.path) === false ||
        !this.host.settings().enabled
      )
        continue;
      if (
        receipt.operation.provider !== snapshot.provider ||
        receipt.operation.accountId !== snapshot.account.id
      )
        continue;
      try {
        if (!receipt.taskId) {
          const task = await this.send(receipt, manual);
          if (!task) continue;
          receipt.taskId = task.id;
          const original = parseCaptureCandidates(receipt.path, receipt.raw)[0];
          if (original) receipt.after = linkedRaw(original, task.id);
          await this.save();
        }
        if (!receipt.after) continue;
        const before = await this.host.read(receipt.path);
        if (before === null) continue;
        const from = locateSource(before, { raw: receipt.raw });
        const afterFrom = locateSource(before, { raw: receipt.after });
        if (from >= 0) {
          const current = candidates.find(
            (candidate) =>
              candidate.path === receipt.path &&
              candidate.from === from &&
              candidate.raw === receipt.raw,
          );
          if (current && !this.host.stable(current)) continue;
          const after =
            before.slice(0, from) +
            receipt.after +
            before.slice(from + receipt.raw.length);
          if (!(await this.host.write(receipt.path, before, after))) continue;
          this.host.report?.("");
        } else if (afterFrom < 0) {
          this.host.report?.(
            "Todoist created a task, but the note changed. Restore its original text to add the link.",
          );
          continue;
        }
        if (
          !candidates.some(
            (candidate) =>
              candidate.path === receipt.path && candidate.raw === receipt.raw,
          )
        ) {
          this.receipts.splice(this.receipts.indexOf(receipt), 1);
          await this.save();
        }
      } catch (error) {
        this.host.report?.(
          error instanceof Error
            ? error.message
            : "Todoist capture failed. Use Sync to retry.",
        );
      }
    }
    for (const candidate of candidates) {
      if (this.stopped || !this.host.enabled()) return;
      if (
        this.host.inScope?.(candidate.path) === false ||
        candidate.completed ||
        candidate.status !== " " ||
        !capturePathEnabled(candidate.path, this.host.settings()) ||
        !this.host.stable(candidate) ||
        [
          ...(candidate.raw.split(/\r?\n/, 1)[0] ?? "").matchAll(
            /\[[^\]]*\]\([^\n)]*\)/g,
          ),
        ].some((match) => taskLinkUrl(match[0])) ||
        !candidate.tags.some((tag) => tag.name.toLowerCase() === "todoist")
      )
        continue;
      if (
        candidates.some(
          (parent) =>
            parent.path === candidate.path &&
            parent.from === candidate.parentFrom &&
            (Boolean(taskLinkUrl(parent.raw)) ||
              parent.tags.some((tag) => tag.name.toLowerCase() === "todoist")),
        )
      )
        continue;
      if (
        this.receipts.some(
          (receipt) =>
            receipt.path === candidate.path &&
            (receipt.raw === candidate.raw || receipt.from === candidate.from),
        )
      )
        continue;
      const before = await this.host.read(candidate.path);
      if (
        before === null ||
        before.slice(candidate.from, candidate.to) !== candidate.raw ||
        !this.host.stable(candidate)
      )
        continue;
      try {
        const draft = routeCapture(candidate, snapshot, this.host.settings());
        const operation: TaskOperation = {
          id: crypto.randomUUID(),
          tempId: crypto.randomUUID(),
          provider: snapshot.provider,
          accountId: snapshot.account.id,
          mutation: { kind: "create", task: draft },
          base: null,
          status: "pending",
          createdAt: new Date().toISOString(),
          attempts: 0,
        };
        this.receipts.push({
          operation,
          path: candidate.path,
          from: candidate.from,
          raw: candidate.raw,
        });
        await this.save();
        const receipt = this.receipts.at(-1)!;
        const task = await this.send(receipt, manual);
        if (!task) continue;
        receipt.taskId = task.id;
        receipt.after = linkedRaw(candidate, task.id);
        await this.save();
        const current = await this.host.read(candidate.path);
        if (current === null) continue;
        const from = locateSource(current, { raw: candidate.raw });
        if (from < 0) {
          this.host.report?.(
            "Todoist created a task, but the note changed. Restore its original text to add the link.",
          );
          continue;
        }
        const moved = parseCaptureCandidates(candidate.path, current).find(
          (item) => item.from === from && item.raw === candidate.raw,
        );
        if (!moved || !this.host.stable(moved)) continue;
        const after =
          current.slice(0, from) +
          receipt.after +
          current.slice(from + candidate.raw.length);
        if (!(await this.host.write(candidate.path, current, after))) continue;
        this.host.report?.("");
      } catch (error) {
        this.host.report?.(
          error instanceof Error
            ? error.message
            : "Todoist capture failed. Use Sync to retry.",
        );
      }
    }
  }
}
