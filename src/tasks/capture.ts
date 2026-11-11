import { get, writable } from "svelte/store";

import {
  nativeSourceBlockId,
  resolveSourceIdentities,
} from "../service/source-identity";

import {
  captureTitle,
  parseCaptureCandidates,
  type CaptureCandidate,
} from "./capture-parser";
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
  kind?: "identity";
  candidate: CaptureCandidate;
  message: string;
  deletionId?: string;
}
export interface TaskIdentityIssue {
  path: string;
  uids: string[];
  message: string;
  candidate?: CaptureCandidate;
}

function restoresSource(source: TaskSource, candidate: TaskSource) {
  const blockId = nativeSourceBlockId(source.raw);
  return blockId
    ? nativeSourceBlockId(candidate.raw) === blockId
    : source.raw.replace(/\r\n/g, "\n") ===
        candidate.raw.replace(/\r\n/g, "\n");
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
  readonly state = writable<{
    issues: CaptureIssue[];
    identityIssues: TaskIdentityIssue[];
    error: string;
  }>({
    issues: [],
    identityIssues: [],
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
      paths?(): string[];
      stableMissing?(): boolean;
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

  inspectIdentities(input = this.host.candidates()) {
    const candidates = structuredClone(input);
    const identityIssues: TaskIdentityIssue[] = [];
    const state = this.service.registry.snapshot();
    const detached = Object.entries(state.detached).filter(
      ([, item]) => !item.restoredAt,
    );
    const blocked = new Set<CaptureCandidate>();
    for (const [uid, item] of detached) {
      const matches = candidates.filter((candidate) =>
        restoresSource(item.link.source, candidate),
      );
      if (!matches.length) continue;
      const competing = [
        ...Object.entries(state.links),
        ...detached.map(([id, value]) => [id, value.link] as const),
      ].filter(([, link]) => restoresSource(link.source, matches[0]!));
      if (matches.length === 1 && competing.length === 1) matches[0]!.uid = uid;
      else {
        for (const candidate of matches) blocked.add(candidate);
        if (
          !identityIssues.some(
            (issue) =>
              issue.candidate?.path === matches[0]!.path &&
              issue.candidate.from === matches[0]!.from,
          )
        )
          identityIssues.push({
            path: matches[0]!.path,
            uids: competing.map(([id]) => id),
            candidate: matches[0],
            message:
              "Several blocks could restore this task link. Keep one original block, then recheck its link.",
          });
      }
    }
    const previous = Object.fromEntries(
      Object.entries(state.links).map(([uid, link]) => [uid, link.source]),
    );
    for (const operation of state.schedules) {
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
      resolveSourceIdentities<TaskSource>(
        candidates.filter((candidate) => !blocked.has(candidate)),
        previous,
        {
          duplicate:
            "Several note tasks share the same link. Review their identities before capture.",
          ambiguous: (path) =>
            `Task links are ambiguous in ${path}. Restore the previous task text before capturing more tasks there.`,
          matchers: [
            (old, next) => old.path === next.path && old.title === next.title,
          ],
          onAmbiguous: (path, uids) => {
            identityIssues.push({
              path,
              uids,
              message:
                "Several note tasks could match this task. Review its note link.",
            });
          },
        },
      );
    } catch (error) {
      throw new TaskReadError(
        error instanceof Error
          ? error.message
          : "Task links need review before capture.",
      );
    }
    const ambiguousPaths = new Set(identityIssues.map((issue) => issue.path));
    return {
      candidates: candidates.filter(
        (candidate) =>
          !blocked.has(candidate) &&
          (candidate.uid || !ambiguousPaths.has(candidate.path)),
      ),
      identityIssues,
    };
  }

  candidates() {
    return this.inspectIdentities().candidates;
  }

  async inspectCurrentIdentities() {
    const initial = this.inspectIdentities();
    const links = this.service.registry.snapshot().links;
    const assigned = new Set(
      initial.candidates.map((candidate) => candidate.uid),
    );
    if (
      !Object.entries(links).some(
        ([uid, link]) => link.taskId && link.base && !assigned.has(uid),
      )
    )
      return { ...initial, documents: undefined };
    const inventory = this.host.paths?.();
    const paths = [
      ...new Set([
        ...(inventory ??
          this.host.candidates().map((candidate) => candidate.path)),
        ...Object.values(links).map((link) => link.source.path),
      ]),
    ];
    const documents = new Map<string, string | null>();
    const unavailable = new Set<string>();
    for (const path of paths) {
      try {
        documents.set(path, await this.host.read(path));
      } catch {
        unavailable.add(path);
      }
    }
    const changedInventory =
      this.host.paths &&
      JSON.stringify(inventory!.toSorted()) !==
        JSON.stringify(this.host.paths().toSorted());
    const candidates = [...documents].flatMap(([path, text]) =>
      text === null ? [] : parseCaptureCandidates(path, text),
    );
    const inspection = this.inspectIdentities(candidates);
    if (unavailable.size || changedInventory) {
      const uncertain = new Set(
        Object.entries(links)
          .filter(
            ([uid, link]) =>
              unavailable.has(link.source.path) ||
              !inspection.candidates.some((candidate) => candidate.uid === uid),
          )
          .map(([uid]) => uid),
      );
      return {
        candidates: inspection.candidates.filter(
          (candidate) => candidate.uid && !uncertain.has(candidate.uid),
        ),
        identityIssues: [
          ...inspection.identityIssues,
          ...Object.entries(links)
            .filter(([uid]) => uncertain.has(uid))
            .map<TaskIdentityIssue>(([uid, link]) => ({
              path: link.source.path,
              uids: [uid],
              message:
                "A note is unavailable or still indexing. Recheck its link after the notes are ready.",
            })),
        ],
        documents: undefined,
      };
    }
    return { ...inspection, documents };
  }

  async missingSource(
    uid: string,
    inspection: Awaited<ReturnType<TaskCapture["inspectCurrentIdentities"]>>,
  ) {
    if (!this.ready() || this.host.stableMissing?.() === false)
      return undefined;
    if (
      inspection.candidates.some((candidate) => candidate.uid === uid) ||
      inspection.identityIssues.some((issue) => issue.uids.includes(uid))
    )
      return null;
    const link = this.service.registry.snapshot().links[uid];
    if (!link || !inspection.documents?.has(link.source.path)) return null;
    const document = inspection.documents.get(link.source.path)!;
    if (
      (await this.host.read(link.source.path)) !== document ||
      this.host.stableMissing?.() === false
    )
      return undefined;
    return { document };
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
    if (!browser.writable || !browser.snapshot || this.host.ready?.() === false)
      return;
    const { candidates, identityIssues } =
      await this.inspectCurrentIdentities();
    const issues: CaptureIssue[] = identityIssues.flatMap((issue) =>
      issue.candidate
        ? [
            {
              kind: "identity",
              candidate: issue.candidate,
              message: issue.message,
            },
          ]
        : [],
    );
    const detached = this.service.registry.snapshot().detached;
    for (const candidate of candidates) {
      const uid = candidate.uid;
      if (!uid || !detached[uid] || detached[uid]!.restoredAt) continue;
      const state = this.service.registry.snapshot();
      const item = state.detached[uid];
      if (
        !uid ||
        !item ||
        item.restoredAt ||
        state.links[uid] ||
        !(await this.sourceIsCurrent(candidate))
      )
        continue;
      if (item.reason === "deleted") {
        issues.push({
          kind: "identity",
          candidate,
          deletionId: item.deletionId,
          message:
            "This task was deleted. Review its saved details before creating another task from this block.",
        });
        continue;
      }
      if (
        item.link.provider !== browser.snapshot.provider ||
        item.link.accountId !== browser.snapshot.account.id ||
        state.schedules.some(
          (operation) =>
            operation.provider === item.link.provider &&
            operation.accountId === item.link.accountId &&
            operation.task.id === item.link.taskId &&
            !["complete", "cancelled"].includes(operation.phase),
        ) ||
        Object.values(state.links).some(
          (link) =>
            link.provider === item.link.provider &&
            link.accountId === item.link.accountId &&
            link.taskId === item.link.taskId,
        )
      ) {
        issues.push({
          kind: "identity",
          candidate,
          message:
            "Reconnect the original account and finish this task's saved link recovery before restoring this note.",
        });
        continue;
      }
      await this.service.registry.change((current) => {
        const currentBrowser = get(this.service.state);
        if (
          this.closed ||
          !currentBrowser.writable ||
          currentBrowser.snapshot?.provider !== item.link.provider ||
          currentBrowser.snapshot.account.id !== item.link.accountId ||
          JSON.stringify(current.detached[uid]) !== JSON.stringify(item) ||
          current.links[uid] ||
          current.schedules.some(
            (operation) =>
              operation.provider === item.link.provider &&
              operation.accountId === item.link.accountId &&
              operation.task.id === item.link.taskId &&
              !["complete", "cancelled"].includes(operation.phase),
          ) ||
          Object.values(current.links).some(
            (link) =>
              link.provider === item.link.provider &&
              link.accountId === item.link.accountId &&
              link.taskId === item.link.taskId,
          )
        )
          throw new TaskReadError(
            "This restored task link changed. Recheck its latest source.",
          );
        current.links[uid] = {
          ...item.link,
          source: {
            path: candidate.path,
            raw: candidate.raw,
            from: candidate.from,
            title: candidate.title,
          },
        };
        if (item.projection)
          current.projections[uid] = {
            ...item.projection,
            source: current.links[uid]!.source,
            googleUid: undefined,
            googleEventId: undefined,
          };
        current.detached[uid]!.restoredAt = new Date().toISOString();
        delete current.issues[uid];
      });
    }
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
    if (!this.closed) this.state.set({ issues, identityIssues, error: "" });
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
