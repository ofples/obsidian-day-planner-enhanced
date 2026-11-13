import { writable } from "svelte/store";

import { hasTaskLock } from "../util/task-lock";

import { scheduleNoteTitle } from "./schedule-markdown";

export const noteTaskDragMime = "application/x-day-planner-note-task+json";
export interface NoteTaskReference {
  path: string;
  line: number;
  text: string;
  durationMinutes?: number;
  title?: string;
}

export class NoteTaskDrag {
  readonly state = writable<NoteTaskReference | null>(null);
  private active?: {
    reference: NoteTaskReference;
    id: string;
    expires: number;
  };
  constructor(private readonly namespace: string) {}

  start(reference: NoteTaskReference, transfer: DataTransfer) {
    if (hasTaskLock(reference.text))
      throw new Error("Unlock this task before moving it.");
    const id = crypto.randomUUID();
    this.active = {
      reference: { ...reference, title: scheduleNoteTitle(reference.text) },
      id,
      expires: Date.now() + 120_000,
    };
    transfer.setData(
      noteTaskDragMime,
      JSON.stringify({ namespace: this.namespace, id }),
    );
    transfer.setData("text/plain", reference.text);
    transfer.effectAllowed = "move";
    this.state.set(this.active.reference);
  }

  current() {
    return this.active && this.active.expires > Date.now()
      ? this.active.reference
      : null;
  }

  accept(transfer: DataTransfer) {
    const payload: unknown = JSON.parse(transfer.getData(noteTaskDragMime));
    if (
      !payload ||
      typeof payload !== "object" ||
      !("namespace" in payload) ||
      !("id" in payload) ||
      payload.namespace !== this.namespace ||
      payload.id !== this.active?.id ||
      !this.current()
    )
      throw new Error(
        "This note drag expired. Start a fresh drag in this vault.",
      );
    return { reference: this.active!.reference, id: this.active!.id };
  }

  cancel() {
    this.active = undefined;
    this.state.set(null);
  }
}
