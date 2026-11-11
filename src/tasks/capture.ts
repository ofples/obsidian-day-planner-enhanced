import { get, writable } from "svelte/store";

import { resolveSourceIdentities } from "../service/source-identity";

import { captureTitle, type CaptureCandidate } from "./capture-parser";
import {
  capturePathEnabled,
  taskAccountSettings,
  type TaskCaptureSettings,
} from "./capture-settings";
import type { TaskDraft } from "./operations";
import type { TaskSource } from "./registry";
import type { TaskService } from "./service";
import { TaskReadError, type TaskSnapshot } from "./types";

export interface CaptureIssue {
  candidate: CaptureCandidate;
  message: string;
}

export function routeCapture(
  candidate: CaptureCandidate,
  snapshot: TaskSnapshot,
  settings: TaskCaptureSettings,
  explicitProject?: string,
): TaskDraft {
  const account = taskAccountSettings(settings, snapshot);
  const tags = candidate.tags.map((tag) => tag.name.toLowerCase());
  const projects = [
    ...new Set(
      tags.flatMap((tag) =>
        account.projectMappings[tag] ? [account.projectMappings[tag]!] : [],
      ),
    ),
  ];
  if (!explicitProject && projects.length > 1)
    throw new TaskReadError(
      "Choose a project for this task. Its tags map to several projects.",
    );
  const projectId = explicitProject ?? projects[0] ?? account.defaultProjectId;
  if (!snapshot.projects.some((project) => project.id === projectId))
    throw new TaskReadError("Choose an available project for this task.");
  const routing = new Set([
    "todoist",
    ...Object.keys(account.projectMappings),
    ...Object.keys(account.labelMappings),
  ]);
  const title = captureTitle(
    candidate,
    new Set(
      candidate.tags
        .filter((tag) => routing.has(tag.name.toLowerCase()))
        .map((tag) => tag.name),
    ),
  );
  if (!title)
    throw new TaskReadError("Enter a task title before sending it to Todoist.");
  return {
    title,
    description: "",
    projectId,
    parentId: null,
    labels: [
      ...new Set(
        tags.flatMap((tag) =>
          account.labelMappings[tag] ? [account.labelMappings[tag]!] : [],
        ),
      ),
    ],
    priority: 1,
    due: null,
  };
}

export class TaskCapture {
  readonly state = writable<{ issues: CaptureIssue[]; error: string }>({
    issues: [],
    error: "",
  });
  private pending?: Promise<void>;
  private again = false;
  private closed = false;

  constructor(
    private readonly service: TaskService,
    private readonly host: {
      candidates(): CaptureCandidate[];
      ready?(): boolean;
      read(path: string): Promise<string | null>;
      stable(candidate: CaptureCandidate): boolean;
      settings(): TaskCaptureSettings;
    },
  ) {}

  scan(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.pending) {
      this.again = true;
      return this.pending;
    }
    const operation = this.scanStable().catch((error: unknown) => {
      this.state.update((state) => ({
        ...state,
        error:
          error instanceof TaskReadError
            ? error.message
            : "Task links need review before capture can continue.",
      }));
    });
    this.pending = operation;
    return operation.finally(() => {
      this.pending = undefined;
      if (this.again && !this.closed) {
        this.again = false;
        void this.scan();
      }
    });
  }

  candidates() {
    const candidates = structuredClone(this.host.candidates());
    const previous = Object.fromEntries(
      Object.entries(this.service.registry.snapshot().links).map(
        ([uid, link]) => [uid, link.source],
      ),
    );
    for (const operation of this.service.registry.snapshot().schedules) {
      if (!["pending", "prepared"].includes(operation.phase)) continue;
      for (const link of operation.plan?.links ?? []) {
        if (
          Object.values(previous).some(
            (source) =>
              source.path === link.source.path &&
              source.from === link.source.from &&
              source.raw === link.source.raw,
          )
        )
          continue;
        previous[`reserved:${operation.id}:${link.uid}`] = link.source;
      }
    }
    try {
      resolveSourceIdentities<TaskSource>(candidates, previous, {
        duplicate:
          "Several note tasks share the same link. Review their identities before capture.",
        ambiguous: (path) =>
          `Task links are ambiguous in ${path}. Restore the previous task text before capturing more tasks there.`,
        matchers: [
          (old, next) => old.path === next.path && old.title === next.title,
        ],
      });
    } catch (error) {
      throw new TaskReadError(
        error instanceof Error
          ? error.message
          : "Task links need review before capture.",
      );
    }
    return candidates;
  }

  ready() {
    return !this.closed && this.host.ready?.() !== false;
  }

  async sourceIsCurrent(candidate: CaptureCandidate) {
    if (
      this.closed ||
      this.host.ready?.() === false ||
      !this.host.stable(candidate)
    )
      return false;
    const text = await this.host.read(candidate.path);
    return (
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- Plugin unload can change this field while the document read is awaited.
      !this.closed &&
      this.host.stable(candidate) &&
      text?.slice(candidate.from, candidate.to) === candidate.raw
    );
  }

  private async scanStable() {
    const browser = get(this.service.state);
    if (
      !browser.writable ||
      !browser.snapshot ||
      !this.host.settings().enabled ||
      this.host.ready?.() === false
    )
      return;
    const candidates = this.candidates();
    const links = this.service.registry.snapshot().links;
    const changed = candidates.filter(
      (candidate) =>
        candidate.uid &&
        links[candidate.uid] &&
        ["path", "raw", "from", "title"].some(
          (field) =>
            candidate[field as keyof TaskSource] !==
            links[candidate.uid!]!.source[field as keyof TaskSource],
        ),
    );
    for (const candidate of changed) {
      if (!(await this.sourceIsCurrent(candidate))) continue;
      await this.service.registry.change((state) => {
        const link = state.links[candidate.uid!];
        if (link)
          link.source = {
            path: candidate.path,
            raw: candidate.raw,
            from: candidate.from,
            title: candidate.title,
          };
      });
    }
    const issues: CaptureIssue[] = [];
    for (const candidate of candidates) {
      if (this.closed || !get(this.service.state).writable) return;
      if (
        candidate.uid ||
        candidate.completed ||
        candidate.status !== " " ||
        !capturePathEnabled(candidate.path, this.host.settings()) ||
        !candidate.tags.some((tag) => tag.name.toLowerCase() === "todoist") ||
        !(await this.sourceIsCurrent(candidate))
      )
        continue;
      try {
        await this.create(candidate, undefined, candidates);
      } catch (error) {
        if (!(error instanceof TaskReadError)) throw error;
        issues.push({ candidate, message: error.message });
      }
    }
    if (!this.closed) this.state.set({ issues, error: "" });
  }

  async create(
    candidate: CaptureCandidate,
    explicitProject?: string,
    matched = this.candidates(),
  ) {
    const browser = get(this.service.state);
    const snapshot = browser.snapshot;
    if (!snapshot || !browser.writable)
      throw new TaskReadError("Connect Todoist before capturing tasks.");
    const current = matched.find(
      (item) =>
        item.path === candidate.path &&
        item.from === candidate.from &&
        item.raw === candidate.raw,
    );
    if (!current || current.uid || !(await this.sourceIsCurrent(current)))
      throw new TaskReadError(
        "This note task changed or is already linked. Refresh before routing it.",
      );
    const latest = get(this.service.state).snapshot;
    if (
      latest?.provider !== snapshot.provider ||
      latest.account.id !== snapshot.account.id
    )
      throw new TaskReadError(
        "The task account changed. Review routing again before sending this note task.",
      );
    if (
      !explicitProject &&
      !capturePathEnabled(current.path, this.host.settings())
    )
      throw new TaskReadError("Automatic capture is disabled for this note.");
    const draft = routeCapture(
      current,
      snapshot,
      this.host.settings(),
      explicitProject,
    );
    const parent = matched.find(
      (item) => item.path === current.path && item.from === current.parentFrom,
    );
    if (
      parent &&
      (parent.uid ||
        parent.tags.some((tag) => tag.name.toLowerCase() === "todoist"))
    ) {
      const link = parent.uid
        ? this.service.registry.snapshot().links[parent.uid]
        : undefined;
      if (!link?.taskId)
        throw new TaskReadError(
          "Waiting for the parent task to finish creating.",
        );
      if (
        link.provider !== snapshot.provider ||
        link.accountId !== snapshot.account.id
      )
        throw new TaskReadError(
          "The parent task belongs to another account. Review its link before capturing this child.",
        );
      const remoteParent = snapshot.tasks.find(
        (task) => task.id === link.taskId,
      );
      if (!remoteParent)
        throw new TaskReadError(
          "Refresh the parent task before capturing this child.",
        );
      draft.parentId = remoteParent.id;
      draft.projectId = remoteParent.projectId;
    }
    const uid = crypto.randomUUID().replace(/-/g, "");
    // Publish the provisional identity in this scan as soon as its intent is durable.
    const operation = await this.service.mutate(
      { kind: "create", task: draft },
      { uid, value: current },
    );
    current.uid = operation.sourceUid;
    return operation;
  }

  stop() {
    this.closed = true;
  }
}
