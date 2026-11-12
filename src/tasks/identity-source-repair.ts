import { get } from "svelte/store";

import { nativeSourceBlockId } from "../service/source-identity";

import type { TaskCapture, TaskIdentityIssue } from "./capture";
import type { CaptureCandidate } from "./capture-parser";
import {
  historicalIdentityOwner,
  type TaskIdentityDecision,
} from "./identity-types";
import { historicalTaskLinks } from "./occurrence-types";
import type { TaskRegistryState } from "./registry";
import type { TaskService } from "./service";
import { identitySourceKey, taskSourceSchema, type TaskSource } from "./source";
import { suggestTaskSourceTree } from "./source-copies";
import { TaskReadError } from "./types";

export interface TaskSourceRepairReview {
  decision: TaskIdentityDecision;
  links: TaskRegistryState["links"];
  candidates: CaptureCandidate[];
  retained: CaptureCandidate[];
  selected: Record<string, string>;
  fingerprint: string;
  guard: string;
  cached: boolean;
}

function includesSource(parent: TaskSource, child: TaskSource) {
  return (
    parent.path === child.path &&
    child.from >= parent.from &&
    child.from + child.raw.length <= parent.from + parent.raw.length
  );
}

function issueIncludes(issue: TaskIdentityIssue, candidate: CaptureCandidate) {
  return issue.copies
    ? issue.copies.some((copy) => includesSource(copy, candidate))
    : issue.candidate
      ? includesSource(issue.candidate, candidate)
      : issue.path === candidate.path;
}

async function repairFingerprint(value: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function hasSourceEvidence(source: TaskSource, candidates: CaptureCandidate[]) {
  const blockId = nativeSourceBlockId(source.raw);
  return candidates.some(
    (candidate) =>
      source.raw.replace(/\r\n/g, "\n") ===
        candidate.raw.replace(/\r\n/g, "\n") ||
      (source.path === candidate.path &&
        (source.title === candidate.title ||
          (Boolean(blockId) &&
            nativeSourceBlockId(candidate.raw) === blockId))),
  );
}

function repairGuard(state: TaskRegistryState, decision: TaskIdentityDecision) {
  const uids = new Set(decision.assignments.map((item) => item.uid));
  return JSON.stringify({
    decision: state.identityDecisions[decision.id],
    bindings: Object.fromEntries(
      [...uids].map((uid) => [
        uid,
        state.links[uid] ?? state.localSources[uid],
      ]),
    ),
    projections: Object.fromEntries(
      [...uids].map((uid) => [uid, state.projections[uid]]),
    ),
    owners: [
      ...Object.entries(state.links).map(([uid, link]) => [
        uid,
        link.source,
        link.provider,
        link.accountId,
        link.taskId,
      ]),
      ...Object.entries(state.localSources).map(([uid, local]) => [
        uid,
        local.source,
        local.decisionId,
      ]),
      ...historicalTaskLinks(state).map((item) => [
        item.uid,
        item.link.source,
        item.occurrenceId,
      ]),
      ...Object.entries(state.detached)
        .filter(([, item]) => !item.restoredAt)
        .map(([uid, item]) => [uid, item.link.source, item.reason]),
    ],
    reservations: state.schedules
      .filter((op) => ["pending", "prepared"].includes(op.phase))
      .map((op) => op.plan?.links),
    commands: state.operations.filter(
      (op) =>
        op.identityDecisionId === decision.id ||
        (op.sourceUid && uids.has(op.sourceUid)),
    ),
    historical: Object.entries(decision.before.historical ?? {}).map(
      ([uid, id]) => [uid, id, state.occurrences[id]],
    ),
  });
}

/** Rebind the saved create identities while retaining their existing provider commands. */
export class TaskIdentitySourceRepairController {
  constructor(
    private readonly service: TaskService,
    private readonly capture: TaskCapture,
    private readonly active: () => boolean,
    private readonly resume: () => Promise<void>,
  ) {}

  private current(decision: TaskIdentityDecision) {
    const browser = get(this.service.state);
    return (
      this.active() &&
      browser.writable &&
      browser.snapshot?.provider === decision.provider &&
      browser.snapshot.account.id === decision.accountId
    );
  }

  async review(id: string): Promise<TaskSourceRepairReview> {
    await this.service.refresh();
    await this.capture.scan();
    const state = this.service.registry.snapshot(),
      decision = state.identityDecisions[id];
    if (!decision || decision.phase !== "creating" || !this.current(decision))
      throw new TaskReadError(
        "Open an unfinished source decision in its original account before repairing its selected blocks.",
      );
    for (const uid of Object.keys(decision.before.historical ?? {}))
      if (!historicalIdentityOwner(state, decision.before, uid))
        throw new TaskReadError(
          "Review this completed occurrence's ownership before repairing its copied sources.",
        );
    const uids = new Set(
      decision.assignments
        .filter((item) => item.kind === "create")
        .map((item) => item.uid),
    );
    const links: TaskRegistryState["links"] = {};
    for (const uid of uids) {
      const link = state.links[uid];
      if (
        !link ||
        link.provider !== decision.provider ||
        link.accountId !== decision.accountId
      )
        throw new TaskReadError(
          "Restore the saved copied-task identities before selecting their sources.",
        );
      links[uid] = link;
    }
    const inventory = await this.capture.readCurrentCandidates(),
      inspection = this.capture.inspectIdentities(inventory);
    const owned = new Set([
      ...uids,
      ...Object.entries(state.localSources)
        .filter(([, local]) => local.decisionId === id)
        .map(([uid]) => uid),
    ]);
    const proven = new Set(
      inspection.inventory.flatMap((candidate) =>
        candidate.uid ? [candidate.uid] : [],
      ),
    );
    const historical = new Map(
      historicalTaskLinks(state).map((item) => [item.uid, item.link.source]),
    );
    const unavailable = inspection.identityIssues.filter((issue) =>
      issue.uids.some(
        (uid) =>
          !owned.has(uid) &&
          !proven.has(uid) &&
          (!historical.has(uid) ||
            state.links[uid] ||
            hasSourceEvidence(historical.get(uid)!, inventory)),
      ),
    );
    const candidates = inventory.filter((candidate) => {
      const known = inspection.inventory.find(
        (source) => identitySourceKey(source) === identitySourceKey(candidate),
      );
      return (
        (!known?.uid || owned.has(known.uid)) &&
        !unavailable.some((issue) => issueIncludes(issue, candidate))
      );
    });
    const relevant = inspection.identityIssues.filter((issue) =>
      issue.uids.some((uid) => uids.has(uid)),
    );
    const retained = candidates.filter(
      (candidate) =>
        relevant.some((issue) => issueIncludes(issue, candidate)) ||
        inspection.inventory.some(
          (source) =>
            source.uid &&
            uids.has(source.uid) &&
            identitySourceKey(source) === identitySourceKey(candidate),
        ),
    );
    const selected = Object.fromEntries(
      [...uids].map((uid) => {
        const source = inspection.inventory.find(
          (candidate) => candidate.uid === uid,
        );
        return [
          uid,
          source &&
          candidates.some(
            (candidate) =>
              identitySourceKey(candidate) === identitySourceKey(source),
          )
            ? identitySourceKey(source)
            : "",
        ];
      }),
    );
    for (const candidate of retained)
      if (!(await this.capture.sourceIsCurrent(candidate)))
        throw new TaskReadError(
          "Finish editing the candidate note blocks before repairing their links.",
        );
    if (!this.current(decision))
      throw new TaskReadError(
        "The account changed during source repair review.",
      );
    const current = this.service.registry.snapshot();
    const plan = { decision, links, candidates, retained, selected };
    const guard = repairGuard(current, decision);
    const fingerprint = await repairFingerprint(
      JSON.stringify({ plan, guard }),
    );
    if (!this.current(decision))
      throw new TaskReadError(
        "The account changed during source repair review.",
      );
    return {
      ...plan,
      cached: Boolean(get(this.service.state).error),
      guard,
      fingerprint,
    };
  }

  suggestTree(review: TaskSourceRepairReview, uid: string, key: string) {
    return suggestTaskSourceTree(review.candidates, review.links, uid, key);
  }

  async confirm(
    review: TaskSourceRepairReview,
    selected: Record<string, string>,
  ): Promise<
    | { kind: "changed"; review: TaskSourceRepairReview }
    | { kind: "saved"; id: string }
  > {
    const input = JSON.stringify({
      review: review.fingerprint,
      selected: Object.entries(selected).toSorted(([a], [b]) =>
        a.localeCompare(b),
      ),
    });
    const fingerprint = await repairFingerprint(input);
    const prior =
      this.service.registry.snapshot().identityDecisions[review.decision.id];
    if (
      prior?.repairs.some(
        (repair) =>
          repair.fingerprint === fingerprint || repair.fingerprint === input,
      )
    ) {
      if (!this.current(prior))
        throw new TaskReadError(
          "Reconnect the original account before resuming this source repair.",
        );
      await this.resume();
      return { kind: "saved", id: prior.id };
    }
    const fresh = await this.review(review.decision.id);
    if (fresh.fingerprint !== review.fingerprint)
      return { kind: "changed", review: fresh };
    const uids = Object.keys(fresh.links),
      keys = new Set(Object.values(selected));
    if (
      Object.keys(selected).length !== uids.length ||
      keys.size !== uids.length ||
      uids.some((uid) => !selected[uid])
    )
      throw new TaskReadError(
        "Assign a distinct current note block to every copied task.",
      );
    const after: Record<string, TaskSource> = {};
    for (const uid of uids) {
      const candidate = fresh.candidates.find(
        (candidate) => identitySourceKey(candidate) === selected[uid],
      );
      if (!candidate)
        throw new TaskReadError(
          "Choose an available note block from this source review.",
        );
      if (!(await this.capture.sourceIsCurrent(candidate)))
        throw new TaskReadError(
          "Finish editing the selected note block before saving its source link.",
        );
      after[uid] = taskSourceSchema.parse(candidate);
    }
    await this.service.registry.change((state) => {
      const decision = state.identityDecisions[fresh.decision.id];
      if (
        decision?.repairs.some((repair) => repair.fingerprint === fingerprint)
      )
        return;
      if (!decision || !this.current(decision) || decision.phase !== "creating")
        throw new TaskReadError(
          "The source decision changed before its repair was saved.",
        );
      if (repairGuard(state, decision) !== fresh.guard)
        throw new TaskReadError(
          "Task recovery changed while saving this repair. Review its current sources again.",
        );
      const locals: Record<string, TaskSource> = {};
      for (const candidate of fresh.retained) {
        if (keys.has(identitySourceKey(candidate))) continue;
        const uid = crypto.randomUUID().replaceAll("-", "");
        const source = taskSourceSchema.parse(candidate);
        locals[uid] = source;
        state.localSources[uid] = {
          provider: decision.provider,
          accountId: decision.accountId,
          decisionId: decision.id,
          source,
        };
      }
      for (const [uid, local] of Object.entries(state.localSources))
        if (
          local.decisionId === decision.id &&
          keys.has(identitySourceKey(local.source))
        )
          delete state.localSources[uid];
      const before = Object.fromEntries(
        uids.map((uid) => [uid, state.links[uid]!.source]),
      );
      for (const [uid, source] of Object.entries(after)) {
        state.links[uid]!.source = source;
        const projection = state.projections[uid];
        if (
          projection &&
          identitySourceKey(projection.source) !== identitySourceKey(source)
        ) {
          projection.source = source;
          projection.googleUid = undefined;
          projection.googleEventId = undefined;
        }
        delete state.issues[uid];
      }
      decision.repairs.push({
        id: crypto.randomUUID(),
        fingerprint,
        createdAt: new Date().toISOString(),
        before,
        after,
        locals,
      });
      decision.error = undefined;
    });
    this.service.publish();
    await this.capture.scan();
    await this.resume();
    return { kind: "saved", id: fresh.decision.id };
  }
}
