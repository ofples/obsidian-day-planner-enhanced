import { get, writable } from "svelte/store";
import { z } from "zod";

import type { TaskStorage } from "./types";

const checkpointSchema = z.object({
  version: z.literal(1),
  namespace: z.string(),
  committed: z.string().nullable(),
  pending: z.string().optional(),
  needsReadback: z.boolean().optional(),
  restoredFrom: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
});

export interface TaskStateSummary {
  readable: boolean;
  version: number | null;
  namespace: string | null;
  commands: number;
  links: number;
}

export interface TaskStateRestoreReview {
  fingerprint: string;
  loaded: TaskStateSummary;
  saved: TaskStateSummary;
  canRestore: boolean;
}

type JournalStorage = Pick<
  TaskStorage,
  | "readState"
  | "writeState"
  | "backupState"
  | "readStateCheckpoint"
  | "writeStateCheckpoint"
>;
type JournalFiles = { state: string | null; checkpoint: string | null };

async function fingerprint(files: JournalFiles) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(files)),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function summarize(content: string | null): TaskStateSummary {
  const empty = {
    readable: false,
    version: null,
    namespace: null,
    commands: 0,
    links: 0,
  };
  if (content === null) return empty;
  try {
    const value: unknown = JSON.parse(content);
    const metadata = z
      .object({
        version: z.number().optional(),
        namespace: z.string().optional(),
      })
      .parse(value);
    const parsed = z
      .object({
        version: z.number(),
        namespace: z.string(),
        operations: z.array(z.unknown()),
        links: z.record(z.string(), z.unknown()),
      })
      .safeParse(value);
    if (!parsed.success)
      return {
        ...empty,
        version: metadata.version ?? null,
        namespace: metadata.namespace ?? null,
      };
    return {
      readable: true,
      version: parsed.data.version,
      namespace: parsed.data.namespace,
      commands: parsed.data.operations.length,
      links: Object.keys(parsed.data.links).length,
    };
  } catch {
    return empty;
  }
}

/** Keeps provider intent persistence recoverable across a two-file local write. */
export class TaskStateJournal {
  readonly restoration = writable<TaskStateRestoreReview | null>(null);
  private checkpointText: string | null = null;
  private checkpoint: z.infer<typeof checkpointSchema> | null = null;

  constructor(
    private readonly storage: JournalStorage,
    private readonly namespace: string,
    private readonly stateVersion: number,
    private readonly validateState: (content: string) => void,
  ) {}

  private get supported() {
    return Boolean(
      this.storage.readStateCheckpoint && this.storage.writeStateCheckpoint,
    );
  }

  get needsRestoration() {
    return get(this.restoration) !== null;
  }

  get needsReadback() {
    return this.checkpoint?.needsReadback === true;
  }

  private parseCheckpoint(text: string | null) {
    const checkpoint =
      text === null ? null : checkpointSchema.parse(JSON.parse(text));
    if (checkpoint && checkpoint.namespace !== this.namespace)
      throw new Error(
        "Task checkpoint belongs to another vault. Restore its matching files.",
      );
    return checkpoint;
  }

  private async files() {
    const [state, checkpoint] = await Promise.all([
      this.storage.readState(),
      this.storage.readStateCheckpoint?.() ?? Promise.resolve(null),
    ]);
    return { state, checkpoint };
  }

  private async reviewFiles(files: JournalFiles) {
    const checkpoint = this.parseCheckpoint(files.checkpoint);
    if (checkpoint?.committed !== null && checkpoint?.committed !== undefined)
      this.validateState(checkpoint.committed);
    if (checkpoint?.pending !== undefined)
      this.validateState(checkpoint.pending);
    const loaded = summarize(files.state);
    const saved = summarize(checkpoint?.committed ?? null);
    return {
      fingerprint: await fingerprint(files),
      loaded,
      saved,
      canRestore:
        checkpoint?.committed != null &&
        saved.readable &&
        saved.namespace === this.namespace &&
        saved.version! <= this.stateVersion &&
        (loaded.namespace === null || loaded.namespace === this.namespace) &&
        (loaded.version === null || loaded.version <= this.stateVersion),
    };
  }

  async load() {
    const files = await this.files();
    this.checkpointText = files.checkpoint;
    this.checkpoint = this.parseCheckpoint(files.checkpoint);
    if (
      this.checkpoint?.committed !== null &&
      this.checkpoint?.committed !== undefined
    )
      this.validateState(this.checkpoint.committed);
    if (this.checkpoint?.pending !== undefined)
      this.validateState(this.checkpoint.pending);
    if (
      this.supported &&
      this.checkpoint &&
      files.state !== this.checkpoint.committed &&
      files.state !== this.checkpoint.pending
    ) {
      this.restoration.set(await this.reviewFiles(files));
      if (this.checkpoint.committed === null)
        throw new Error(
          "Task tracking has no committed checkpoint. Restore its matching backup.",
        );
      return this.checkpoint.committed;
    }
    this.restoration.set(null);
    return files.state;
  }

  /** Call after validating the loaded registry and its vault namespace. */
  async acknowledge(content: string | null) {
    if (!this.supported || get(this.restoration)) return;
    await this.check(content);
    const serialized = this.serialize(content);
    if (serialized !== this.checkpointText)
      await this.saveCheckpoint(serialized);
  }

  private async saveCheckpoint(content: string) {
    await this.storage.writeStateCheckpoint!(content);
    this.checkpointText = content;
    this.checkpoint = this.parseCheckpoint(content);
  }

  private serialize(committed: string | null, pending?: string) {
    return JSON.stringify({
      version: 1,
      namespace: this.namespace,
      committed,
      pending,
      needsReadback: this.checkpoint?.needsReadback || undefined,
      restoredFrom: this.checkpoint?.restoredFrom,
    });
  }

  async check(expected: string | null) {
    if (get(this.restoration))
      throw new Error("Review saved task tracking before syncing.");
    const files = await this.files();
    if (
      files.state === expected &&
      (!this.supported || files.checkpoint === this.checkpointText)
    )
      return;
    if (this.supported) {
      try {
        this.restoration.set(await this.reviewFiles(files));
      } catch {
        this.restoration.set({
          fingerprint: await fingerprint(files),
          loaded: summarize(files.state),
          saved: summarize(this.checkpoint?.committed ?? null),
          canRestore: false,
        });
        throw new Error(
          "The task tracking checkpoint changed to an unreadable or unsupported format. Restore its matching supported backup.",
        );
      }
    }
    throw new Error(
      "Task state changed in another session. Review saved tracking before syncing.",
    );
  }

  async write(expected: string | null, content: string) {
    await this.check(expected);
    if (this.supported)
      await this.saveCheckpoint(this.serialize(expected, content));
    await this.storage.writeState(content);
    if (this.supported) await this.saveCheckpoint(this.serialize(content));
  }

  async acknowledgeReadback(expected: string | null) {
    if (!this.needsReadback) return;
    await this.check(expected);
    await this.saveCheckpoint(
      JSON.stringify({
        version: 1,
        namespace: this.namespace,
        committed: expected,
        restoredFrom: this.checkpoint?.restoredFrom,
      }),
    );
  }

  async reviewRestoration() {
    if (!get(this.restoration))
      throw new Error("Task tracking is already current.");
    const review = await this.reviewFiles(await this.files());
    this.restoration.set(review);
    return review;
  }

  async restore(review: TaskStateRestoreReview) {
    if (
      !get(this.restoration) &&
      this.checkpoint?.restoredFrom === review.fingerprint
    ) {
      const files = await this.files();
      if (
        files.state === this.checkpoint.committed &&
        files.checkpoint === this.checkpointText
      )
        return { kind: "saved" as const };
      this.restoration.set(await this.reviewFiles(files));
    }
    const current = await this.reviewRestoration();
    if (current.fingerprint !== review.fingerprint)
      return { kind: "changed" as const, review: current };
    if (!current.canRestore)
      throw new Error(
        "Restore matching supported task tracking files before continuing.",
      );
    if (!this.storage.backupState)
      throw new Error("Task tracking backup storage is unavailable.");
    const files = await this.files();
    const beforeBackup = await this.reviewFiles(files);
    if (beforeBackup.fingerprint !== current.fingerprint) {
      this.restoration.set(beforeBackup);
      return { kind: "changed" as const, review: beforeBackup };
    }
    const checkpoint = this.parseCheckpoint(files.checkpoint)!;
    if (files.state !== null)
      await this.storage.backupState(files.state, current.loaded.version ?? 0);
    const checked = await this.reviewRestoration();
    if (checked.fingerprint !== current.fingerprint)
      return { kind: "changed" as const, review: checked };
    await this.saveCheckpoint(
      JSON.stringify({
        ...checkpoint,
        needsReadback: true,
        restoredFrom: current.fingerprint,
      }),
    );
    await this.storage.writeState(checkpoint.committed!);
    return { kind: "saved" as const };
  }
}
