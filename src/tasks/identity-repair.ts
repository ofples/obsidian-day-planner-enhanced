import { get } from "svelte/store";

import { routeCapture, type TaskCapture } from "./capture";
import type { CaptureCandidate } from "./capture-parser";
import type { TaskCaptureSettings } from "./capture-settings";
import { pendingTaskDeletion } from "./deletion-types";
import { TaskIdentitySourceRepairController } from "./identity-source-repair";
import { pendingIdentityDecision } from "./identity-types";
import {
  historicalIdentityOwner,
  identityDecisionSchema,
  identityDecisionCanCancel,
  matchingIdentityCommand,
  type TaskIdentityDecision,
} from "./identity-types";
import { historicalTaskLinks, pendingTaskOccurrence } from "./occurrence-types";
import {
  isOutstanding,
  operationAffectsTasks,
  resolvedTaskOperation,
} from "./operations";
import type { TaskRegistryState } from "./registry";
import type { TaskService } from "./service";
import { identitySourceKey, taskSourceSchema, type TaskSource } from "./source";
import { suggestTaskSourceTree } from "./source-copies";
import { TaskReadError } from "./types";

export { identitySourceKey } from "./source";
function inside(parent: TaskSource, child: TaskSource) {
  return (
    child.path === parent.path &&
    child.from > parent.from &&
    child.from + child.raw.length <= parent.from + parent.raw.length
  );
}
export interface TaskIdentityReview {
  linkUid: string;
  provider: string;
  accountId: string;
  before: TaskIdentityDecision["before"];
  sources: CaptureCandidate[];
  candidates: CaptureCandidate[];
  fingerprint: string;
  cached: boolean;
  decisionIds?: string[];
}
export interface TaskIdentityChoices {
  linked: Record<string, string>;
  create: string[];
}

function decisionFingerprint(
  review: TaskIdentityReview,
  choices: TaskIdentityChoices,
) {
  return JSON.stringify({
    review: review.fingerprint,
    linked: Object.entries(choices.linked).toSorted(([a], [b]) =>
      a.localeCompare(b),
    ),
    create: choices.create.toSorted(),
  });
}

function identityTaskBusy(
  state: TaskRegistryState,
  owner: { provider: string; accountId: string },
  ids: Set<string>,
) {
  return (
    [...ids].some(
      (id) =>
        pendingTaskDeletion(state, owner, id) ||
        pendingTaskOccurrence(state, owner, id) ||
        pendingIdentityDecision(state, owner, id),
    ) ||
    state.operations.some(
      (op) =>
        op.provider === owner.provider &&
        op.accountId === owner.accountId &&
        operationAffectsTasks(op, ids) &&
        isOutstanding(op),
    ) ||
    state.schedules.some(
      (op) =>
        op.provider === owner.provider &&
        op.accountId === owner.accountId &&
        ids.has(op.task.id) &&
        !["complete", "cancelled"].includes(op.phase),
    )
  );
}

/** Locate a reviewed source without promoting completed occurrence history to an active link. */
function sourceOwner(
  state: TaskRegistryState,
  before: TaskIdentityDecision["before"],
  uid: string,
) {
  const occurrenceId = before.historical?.[uid];
  if (!occurrenceId) return state;
  const occurrence = historicalIdentityOwner(state, before, uid);
  if (!occurrence)
    throw new TaskReadError(
      "This completed occurrence changed. Review its history before assigning sources.",
    );
  return occurrence;
}

export class TaskIdentityRepairController {
  readonly sourceRepair: TaskIdentitySourceRepairController;
  private pending?: Promise<void>;
  private readonly confirmations = new Map<
    string,
    Promise<
      | { kind: "changed"; review: TaskIdentityReview }
      | { kind: "saved"; id: string }
    >
  >();
  constructor(
    private readonly service: TaskService,
    private readonly capture: TaskCapture,
    private readonly settings: () => TaskCaptureSettings,
    private readonly active: () => boolean,
  ) {
    this.sourceRepair = new TaskIdentitySourceRepairController(
      service,
      capture,
      active,
      () => this.resume(),
    );
  }

  private current(owner: { provider: string; accountId: string }) {
    const state = get(this.service.state);
    return (
      this.active() &&
      state.writable &&
      state.snapshot?.provider === owner.provider &&
      state.snapshot.account.id === owner.accountId
    );
  }

  async review(linkUid: string): Promise<TaskIdentityReview> {
    await this.service.refresh();
    await this.capture.scan();
    const state = this.service.registry.snapshot();
    const historical = historicalTaskLinks(state);
    const knownLinks = Object.fromEntries([
      ...historical.map(({ uid, link }) => [uid, link] as const),
      ...Object.entries(state.links),
    ]);
    const link = knownLinks[linkUid];
    if (!link?.taskId || !this.current(link))
      throw new TaskReadError(
        "Reconnect the original account to review this task link.",
      );
    const currentIssue = get(this.capture.state).identityIssues.find((item) =>
      item.uids.includes(linkUid),
    );
    const previous = Object.values(state.identityDecisions)
      .toReversed()
      .find(
        (record) => record.phase === "complete" && record.before.links[linkUid],
      );
    const previousSources = previous
      ? [
          ...previous.assignments.flatMap((item) =>
            item.kind === "linked" && knownLinks[item.uid]
              ? [knownLinks[item.uid]!.source]
              : [],
          ),
          ...Object.values(state.localSources)
            .filter((local) => local.decisionId === previous.id)
            .map((local) => local.source),
        ]
      : [];
    const issue =
      currentIssue ??
      (previous
        ? {
            path: link.source.path,
            uids: [
              ...Object.keys(previous.before.links),
              ...Object.entries(state.localSources)
                .filter(([, local]) => local.decisionId === previous.id)
                .map(([uid]) => uid),
            ],
            copies: previousSources.filter(
              (source) =>
                !previousSources.some((parent) => inside(parent, source)),
            ),
          }
        : undefined);
    if (!issue)
      throw new TaskReadError(
        "This source is no longer ambiguous. Recheck the current task link.",
      );
    const initialUids = issue.uids.filter((uid) => knownLinks[uid]);
    const parentBaselines = initialUids.map(
      (uid) => knownLinks[uid]!.noteBase ?? knownLinks[uid]!.source,
    );
    const uids = Object.entries(knownLinks)
      .filter(
        ([uid, link]) =>
          initialUids.includes(uid) ||
          parentBaselines.some((parent) =>
            inside(parent, link.noteBase ?? link.source),
          ),
      )
      .map(([uid]) => uid);
    const localSources = Object.fromEntries(
      issue.uids
        .filter((uid) => state.localSources[uid])
        .map((uid) => [uid, state.localSources[uid]!]),
    );
    const links = Object.fromEntries(
      uids
        .map((uid) => [uid, knownLinks[uid]])
        .filter((entry): entry is [string, NonNullable<typeof link>] =>
          Boolean(entry[1]),
        ),
    );
    if (
      issue.uids.some((uid) => !knownLinks[uid] && !state.localSources[uid]) ||
      Object.values(links).some(
        (item) =>
          !item.taskId ||
          item.provider !== link.provider ||
          item.accountId !== link.accountId,
      )
    )
      throw new TaskReadError(
        "Review historical or unavailable source identities through their saved recovery before assigning active links.",
      );
    const inventory = await this.capture.readCurrentCandidates();
    const inspection = await this.capture.inspectCurrentIdentities();
    const sources = issue.copies
      ? inventory.filter((candidate) =>
          issue.copies!.some(
            (copy) => identitySourceKey(copy) === identitySourceKey(candidate),
          ),
        )
      : inventory.filter(
          (candidate) =>
            candidate.path === issue.path &&
            !inspection.candidates.some(
              (known) =>
                known.path === candidate.path &&
                known.from === candidate.from &&
                known.uid &&
                !uids.includes(known.uid),
            ),
        );
    if (
      !sources.length ||
      (issue.copies && sources.length !== issue.copies.length)
    )
      throw new TaskReadError(
        "The note sources changed. Open their current link review again.",
      );
    const candidates = inventory.filter((candidate) =>
      sources.some(
        (source) =>
          identitySourceKey(source) === identitySourceKey(candidate) ||
          inside(source, candidate),
      ),
    );
    for (const candidate of candidates) {
      const known = inspection.candidates.find(
        (item) => identitySourceKey(item) === identitySourceKey(candidate),
      );
      if (!known?.uid) continue;
      if (knownLinks[known.uid] && !links[known.uid]) {
        links[known.uid] = knownLinks[known.uid]!;
        uids.push(known.uid);
      }
      if (state.localSources[known.uid])
        localSources[known.uid] = state.localSources[known.uid]!;
    }
    if (
      Object.values(links).some(
        (item) =>
          !item.taskId ||
          item.provider !== link.provider ||
          item.accountId !== link.accountId,
      ) ||
      Object.values(localSources).some(
        (item) =>
          item.provider !== link.provider || item.accountId !== link.accountId,
      )
    )
      throw new TaskReadError(
        "Reconnect the original account for every affected source before assigning these links.",
      );
    const ids = new Set(Object.values(links).map((item) => item.taskId!));
    if (identityTaskBusy(state, link, ids))
      throw new TaskReadError(
        "Finish this task tree's saved changes before repairing its sources.",
      );
    for (const source of candidates)
      if (!(await this.capture.sourceIsCurrent(source)))
        throw new TaskReadError(
          "Finish editing these note blocks before confirming their task identities.",
        );
    if (!this.current(link))
      throw new TaskReadError("The account changed during source review.");
    const before: TaskIdentityDecision["before"] = {
      links,
      localSources,
      historical: Object.fromEntries(
        historical
          .filter((item) => uids.includes(item.uid))
          .map((item) => [item.uid, item.occurrenceId]),
      ),
      projections: {},
    };
    for (const uid of uids) {
      const projection = sourceOwner(state, before, uid).projections[uid];
      if (projection) before.projections[uid] = projection;
    }
    const browser = get(this.service.state);
    const decisionIds = Object.values(state.identityDecisions)
      .filter((record) =>
        Object.keys(record.before.links).some((uid) => uids.includes(uid)),
      )
      .map((record) => record.id)
      .toSorted();
    const plan = {
      decisionIds,
      linkUid,
      provider: link.provider,
      accountId: link.accountId,
      before,
      sources,
      candidates,
    };
    return {
      ...plan,
      fingerprint: JSON.stringify({ ...plan, settings: this.settings() }),
      cached: Boolean(browser.error),
    };
  }

  suggestTree(review: TaskIdentityReview, uid: string, key: string) {
    return suggestTaskSourceTree(
      review.candidates,
      review.before.links,
      uid,
      key,
    );
  }

  private decision(review: TaskIdentityReview, choices: TaskIdentityChoices) {
    const selected = new Set(Object.values(choices.linked));
    if (
      Object.keys(choices.linked).length !==
        Object.keys(review.before.links).length ||
      selected.size !== Object.keys(choices.linked).length ||
      Object.keys(review.before.links).some((uid) => !choices.linked[uid])
    )
      throw new TaskReadError(
        "Assign a distinct note source to every existing task link.",
      );
    const assignments: TaskIdentityDecision["assignments"] = Object.entries(
      choices.linked,
    ).map(([uid, key]) => {
      const candidate = review.candidates.find(
        (item) => identitySourceKey(item) === key,
      );
      if (!candidate)
        throw new TaskReadError("Choose a current note source for each task.");
      return { uid, source: taskSourceSchema.parse(candidate), kind: "linked" };
    });
    const create = new Set(choices.create);
    if (
      create.size !== choices.create.length ||
      [...create].some(
        (key) =>
          selected.has(key) ||
          !review.sources.some((source) => identitySourceKey(source) === key),
      )
    )
      throw new TaskReadError("Choose distinct copied blocks for new tasks.");
    const snapshot = get(this.service.state).snapshot!;
    const newUids = new Map<string, string>();
    const creating = review.candidates.filter((candidate) =>
      review.sources.some(
        (root) =>
          create.has(identitySourceKey(root)) &&
          (identitySourceKey(root) === identitySourceKey(candidate) ||
            inside(root, candidate)),
      ),
    );
    for (const candidate of creating) {
      if (selected.has(identitySourceKey(candidate)))
        throw new TaskReadError(
          "A new task tree includes a source already assigned to an existing task.",
        );
      const uid = crypto.randomUUID().replace(/-/g, "");
      const parent = creating.find(
        (item) =>
          item.path === candidate.path && item.from === candidate.parentFrom,
      );
      const parentUid = parent
        ? newUids.get(identitySourceKey(parent))
        : undefined;
      const parentDraft = parentUid
        ? assignments.find((item) => item.uid === parentUid)!.draft
        : undefined;
      const draft = routeCapture(
        candidate,
        snapshot,
        this.settings(),
        parentDraft?.projectId,
      );
      assignments.push({
        uid,
        source: taskSourceSchema.parse(candidate),
        kind: "create",
        draft,
        parentUid,
        completed: candidate.completed || undefined,
        completionId: candidate.completed ? crypto.randomUUID() : undefined,
      });
      newUids.set(identitySourceKey(candidate), uid);
    }
    for (const candidate of review.candidates) {
      const key = identitySourceKey(candidate);
      if (selected.has(key) || newUids.has(key)) continue;
      assignments.push({
        uid:
          Object.entries(review.before.localSources).find(
            ([, local]) => identitySourceKey(local.source) === key,
          )?.[0] ?? crypto.randomUUID().replace(/-/g, ""),
        source: taskSourceSchema.parse(candidate),
        kind: "local",
      });
    }
    return identityDecisionSchema.parse({
      id: crypto.randomUUID(),
      fingerprint: decisionFingerprint(review, choices),
      provider: review.provider,
      accountId: review.accountId,
      before: review.before,
      assignments,
      phase: creating.length ? "creating" : "complete",
      createdAt: new Date().toISOString(),
    });
  }

  confirm(review: TaskIdentityReview, choices: TaskIdentityChoices) {
    const key = decisionFingerprint(review, choices);
    const existing = this.confirmations.get(key);
    if (existing) return existing;
    const pending = this.saveConfirmation(review, choices).finally(() => {
      this.confirmations.delete(key);
    });
    this.confirmations.set(key, pending);
    return pending;
  }

  private async saveConfirmation(
    review: TaskIdentityReview,
    choices: TaskIdentityChoices,
  ): Promise<
    | { kind: "changed"; review: TaskIdentityReview }
    | { kind: "saved"; id: string }
  > {
    const repeated = Object.values(
      this.service.registry.snapshot().identityDecisions,
    ).find(
      (record) =>
        record.phase !== "cancelled" &&
        record.fingerprint === decisionFingerprint(review, choices),
    );
    if (repeated) {
      if (!this.current(repeated))
        throw new TaskReadError(
          "Reconnect the original account before resuming this source decision.",
        );
      await this.resume();
      return { kind: "saved", id: repeated.id };
    }
    const fresh = await this.review(review.linkUid);
    if (fresh.fingerprint !== review.fingerprint)
      return { kind: "changed", review: fresh };
    const decision = this.decision(fresh, choices);
    const id = await this.service.registry.change((state) => {
      const repeated = Object.values(state.identityDecisions).find(
        (record) =>
          record.phase !== "cancelled" &&
          record.fingerprint === decision.fingerprint,
      );
      if (repeated) {
        if (!this.current(repeated))
          throw new TaskReadError(
            "The task account changed during source confirmation.",
          );
        return repeated.id;
      }
      const decisionIds = Object.values(state.identityDecisions)
        .filter((record) =>
          Object.keys(record.before.links).some((uid) =>
            Boolean(decision.before.links[uid]),
          ),
        )
        .map((record) => record.id)
        .toSorted();
      if (
        JSON.stringify(decisionIds) !==
          JSON.stringify(fresh.decisionIds ?? []) ||
        !this.current(decision) ||
        identityTaskBusy(
          state,
          decision,
          new Set(
            Object.values(decision.before.links).map((link) => link.taskId!),
          ),
        ) ||
        Object.entries(decision.before.links).some(
          ([uid, link]) =>
            JSON.stringify(
              sourceOwner(state, decision.before, uid).links[uid],
            ) !== JSON.stringify(link),
        ) ||
        Object.entries(decision.before.projections).some(
          ([uid, value]) =>
            JSON.stringify(
              sourceOwner(state, decision.before, uid).projections[uid],
            ) !== JSON.stringify(value),
        )
      )
        throw new TaskReadError(
          "The task links changed before this decision was saved. Review their latest sources.",
        );
      if (
        Object.entries(decision.before.localSources).some(
          ([uid, local]) =>
            JSON.stringify(state.localSources[uid]) !== JSON.stringify(local),
        )
      )
        throw new TaskReadError(
          "The local copy identities changed. Review this decision again.",
        );
      for (const uid of Object.keys(decision.before.localSources))
        delete state.localSources[uid];
      for (const assignment of decision.assignments) {
        if (assignment.kind === "local")
          state.localSources[assignment.uid] = {
            provider: decision.provider,
            accountId: decision.accountId,
            decisionId: decision.id,
            source: assignment.source,
          };
        else if (assignment.kind === "create")
          state.links[assignment.uid] = {
            provider: decision.provider,
            accountId: decision.accountId,
            taskId: null,
            source: assignment.source,
            noteBase: assignment.source,
            base: null,
          };
        else {
          const owner = sourceOwner(state, decision.before, assignment.uid);
          const link = owner.links[assignment.uid]!;
          const moved =
            identitySourceKey(link.source) !==
            identitySourceKey(assignment.source);
          link.source = assignment.source;
          const projection = owner.projections[assignment.uid];
          if (projection && moved) {
            projection.source = assignment.source;
            projection.googleUid = undefined;
            projection.googleEventId = undefined;
          }
          delete state.issues[assignment.uid];
        }
      }
      state.identityDecisions[decision.id] = decision;
      return decision.id;
    });
    this.service.publish();
    await this.capture.scan();
    await this.resume();
    return { kind: "saved", id };
  }

  async retry(id: string) {
    const decision = this.service.registry.snapshot().identityDecisions[id];
    if (!decision || !this.current(decision))
      throw new TaskReadError(
        "Reconnect the original account before retrying this source decision.",
      );
    const uids = new Set(
      decision.assignments
        .filter((item) => item.kind === "create")
        .map((item) => item.uid),
    );
    for (const command of this.service.registry
      .snapshot()
      .operations.filter(
        (op) =>
          ((op.sourceUid && uids.has(op.sourceUid)) ||
            decision.assignments.some((item) => item.completionId === op.id)) &&
          ["failed", "pending", "sent", "acknowledged"].includes(op.status),
      ))
      await this.service.retryOperation(command.id);
    await this.resume();
  }

  async cancel(id: string) {
    await this.service.registry.change((state) => {
      const decision = state.identityDecisions[id];
      if (!decision || decision.phase !== "creating" || !this.current(decision))
        throw new TaskReadError(
          "Review the current source decision before cancelling it.",
        );
      const uids = new Set(
        decision.assignments
          .filter((item) => item.kind === "create")
          .map((item) => item.uid),
      );
      const commands = state.operations.filter(
        (op) =>
          (op.sourceUid && uids.has(op.sourceUid)) ||
          decision.assignments.some((item) => item.completionId === op.id),
      );
      if (!identityDecisionCanCancel(state, decision))
        throw new TaskReadError(
          "Task creation has started. Finish this decision's saved recovery.",
        );
      const localCopies = decision.repairs.length
        ? [
            ...Object.values(state.localSources)
              .filter((local) => local.decisionId === id)
              .map((local) => local.source),
            ...decision.assignments
              .filter((item) => item.kind === "create")
              .flatMap((item) =>
                state.links[item.uid] ? [state.links[item.uid]!.source] : [],
              ),
          ]
        : [];
      for (const command of commands) {
        command.status = "cancelled";
        command.error = undefined;
      }
      for (const [uid, local] of Object.entries(state.localSources))
        if (local.decisionId === id) delete state.localSources[uid];
      for (const assignment of decision.assignments)
        if (assignment.kind === "create") delete state.links[assignment.uid];
      for (const [uid, link] of Object.entries(decision.before.links))
        sourceOwner(state, decision.before, uid).links[uid] = link;
      for (const [uid, projection] of Object.entries(
        decision.before.projections,
      ))
        sourceOwner(state, decision.before, uid).projections[uid] = projection;
      Object.assign(state.localSources, decision.before.localSources);
      const kept = new Set([
        ...Object.values(decision.before.links).map((link) =>
          identitySourceKey(link.source),
        ),
        ...Object.values(state.localSources).map((local) =>
          identitySourceKey(local.source),
        ),
      ]);
      for (const source of localCopies) {
        const key = identitySourceKey(source);
        if (kept.has(key)) continue;
        kept.add(key);
        state.localSources[crypto.randomUUID().replaceAll("-", "")] = {
          provider: decision.provider,
          accountId: decision.accountId,
          decisionId: id,
          source,
        };
      }
      decision.phase = "cancelled";
      decision.error = undefined;
    });
    this.service.publish();
    await this.capture.scan();
  }

  resume(): Promise<void> {
    if (this.pending) return this.pending;
    const pending = this.run();
    this.pending = pending;
    return pending.finally(() => {
      this.pending = undefined;
    });
  }
  private async run() {
    for (const decision of Object.values(
      this.service.registry.snapshot().identityDecisions,
    )) {
      if (decision.phase !== "creating" || !this.current(decision)) continue;
      try {
        await this.process(decision);
      } catch (failure) {
        if (!this.current(decision)) return;
        const error =
          failure instanceof Error
            ? failure.message
            : "Could not finish this source decision. Retry its saved recovery.";
        await this.service.registry.change((state) => {
          if (
            this.current(decision) &&
            state.identityDecisions[decision.id]?.phase === "creating"
          )
            state.identityDecisions[decision.id]!.error = error;
        });
        this.service.publish();
      }
    }
  }
  private async process(decision: TaskIdentityDecision) {
    for (const uid of Object.keys(decision.before.historical ?? {}))
      sourceOwner(this.service.registry.snapshot(), decision.before, uid);
    for (const assignment of decision.assignments.filter(
      (item) => item.kind === "create",
    )) {
      if (!this.current(decision)) return;
      let state = this.service.registry.snapshot();
      let command = state.operations.find(
        (op) =>
          op.sourceUid === assignment.uid && op.mutation.kind === "create",
      );
      if (command && !matchingIdentityCommand(state, command))
        throw new TaskReadError(
          "Restore the original source decision and create command before resuming.",
        );
      if (command?.status === "cancelled" && !command.resolutionIds)
        throw new TaskReadError(
          "This saved creation was cancelled. Review its source decision before continuing.",
        );
      if (!command) {
        await this.capture.scan();
        const inspection = await this.capture.inspectCurrentIdentities();
        const source = inspection.candidates.find(
          (candidate) => candidate.uid === assignment.uid,
        );
        if (!source || !(await this.capture.sourceIsCurrent(source)))
          throw new TaskReadError(
            "Finish editing or repair the selected source identity before retrying its saved task creation.",
          );
        if (!this.current(decision)) return;
        state = this.service.registry.snapshot();
        const parentId = assignment.parentUid
          ? state.links[assignment.parentUid]?.taskId
          : assignment.draft!.parentId;
        if (assignment.parentUid && !parentId)
          throw new TaskReadError(
            "Verify the copied parent task before creating its children.",
          );
        let draft = assignment.effectiveDraft ?? assignment.draft!;
        if (assignment.parentUid && !assignment.effectiveDraft) {
          const projectId =
            get(this.service.state).snapshot?.tasks.find(
              (task) => task.id === parentId,
            )?.projectId ?? state.links[assignment.parentUid]?.base?.projectId;
          if (!projectId)
            throw new TaskReadError(
              "Refresh the verified parent project before creating this child.",
            );
          if (projectId !== draft.projectId) {
            draft = { ...draft, projectId };
            const effectiveDraft = draft;
            await this.service.registry.change((current) => {
              if (
                !this.current(decision) ||
                current.identityDecisions[decision.id]?.phase !== "creating"
              )
                throw new TaskReadError(
                  "The source decision changed before its child creation was saved.",
                );
              current.identityDecisions[decision.id]!.assignments.find(
                (item) => item.uid === assignment.uid,
              )!.effectiveDraft = effectiveDraft;
            });
          }
        }
        command = await this.service.mutate(
          {
            kind: "create",
            task: { ...draft, parentId: parentId ?? null },
          },
          {
            uid: assignment.uid,
            value: taskSourceSchema.parse(source),
            decisionId: decision.id,
          },
        );
      }
      await this.service.refresh();
      if (!this.current(decision)) return;
      state = this.service.registry.snapshot();
      const commandId = command.id;
      command = state.operations.find((op) => op.id === commandId)!;
      const result = resolvedTaskOperation(state.operations, command.id);
      if (
        result.status !== "complete" ||
        !result.task ||
        result.task.id !== state.links[assignment.uid]?.taskId
      )
        throw new TaskReadError(
          command.error ?? "Waiting for the saved task creation to verify.",
        );
    }
    for (const assignment of decision.assignments
      .toReversed()
      .filter((item) => item.kind === "create" && item.completed)) {
      if (!this.current(decision)) return;
      const state = this.service.registry.snapshot(),
        link = state.links[assignment.uid];
      if (!link?.taskId)
        throw new TaskReadError(
          "Verify this source's created task before completing it.",
        );
      let command = state.operations.find(
        (op) => op.id === assignment.completionId,
      );
      if (!command) {
        const task = await this.service.readTask(link.taskId);
        if (!task || !this.current(decision))
          throw new TaskReadError(
            "Refresh this copied task before completing it.",
          );
        command = await this.service.mutate(
          { kind: "complete", taskId: task.id },
          undefined,
          {
            id: assignment.completionId!,
            base: task,
            provider: decision.provider,
            accountId: decision.accountId,
            identityDecisionId: decision.id,
          },
        );
      }
      await this.service.refresh();
      const result = this.service.registry
        .snapshot()
        .operations.find((op) => op.id === assignment.completionId);
      const resolved =
        result &&
        resolvedTaskOperation(
          this.service.registry.snapshot().operations,
          result.id,
        );
      if (resolved?.status !== "complete" || !resolved.task)
        throw new TaskReadError(
          result?.error ?? "Waiting for copied task completion to verify.",
        );
    }
    await this.service.registry.change((state) => {
      if (!this.current(decision)) return;
      const saved = state.identityDecisions[decision.id]!;
      if (
        saved.assignments.some((item) => {
          if (item.kind !== "create") return false;
          const command = state.operations.find(
            (op) => op.sourceUid === item.uid && op.mutation.kind === "create",
          );
          return (
            !command ||
            resolvedTaskOperation(state.operations, command.id).status !==
              "complete" ||
            (item.completionId &&
              resolvedTaskOperation(state.operations, item.completionId)
                .status !== "complete")
          );
        })
      )
        return;
      saved.phase = "complete";
      saved.error = undefined;
    });
    this.service.publish();
  }
}
