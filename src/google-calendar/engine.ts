import { syncCanonicalCalendar } from "./canonical-engine";
import { normalizeLocalSnapshot } from "./markdown";
import {
  canonicalSnapshotOf,
  sameCanonicalSnapshot,
  sameSnapshot,
  snapshotOf,
  type CalendarApi,
  type CalendarSnapshot,
  type CalendarNotes,
  type CalendarSyncState,
  type GoogleEvent,
  type LocalBlock,
} from "./types";

export interface SyncResult {
  pushed: number;
  pulled: number;
  deleted: number;
  conflicts: string[];
  reviewable: CalendarConflict[];
  missingLocal: MissingLocalConflict[];
  deletedRemote: DeletedRemoteConflict[];
}

export interface DeletedRemoteConflict {
  uid: string;
  path: string;
  eventId: string;
  mine: CalendarSnapshot;
  raw: string;
  currentRaw: string;
  detectedAt: string;
}

/** Resolve a remote deletion only after the user explicitly chooses an outcome. */
export async function resolveDeletedRemoteConflict(
  conflict: DeletedRemoteConflict,
  choice: "restore" | "accept",
  state: CalendarSyncState,
  api: CalendarApi,
  notes: CalendarNotes,
  save: () => Promise<void>,
) {
  const record = state.records[conflict.uid];
  const draft = record?.pendingConflict;
  if (
    !record ||
    record.deleted ||
    record.path !== conflict.path ||
    record.eventId !== conflict.eventId ||
    !draft ||
    !draft.fields.includes("deletion") ||
    draft.detectedAt !== conflict.detectedAt ||
    draft.raw !== conflict.raw ||
    !sameCanonicalSnapshot(draft.mine, conflict.mine)
  )
    throw new Error("This conflict changed. Sync again before resolving it.");
  if (state.pendingCreate)
    throw new Error(
      "Another calendar export is pending. Finish it before resolving this conflict.",
    );
  if (notes.canSync && !(await notes.canSync(conflict.path, conflict.mine)))
    throw new Error("This note is outside calendar sync scope.");
  const local = (await notes.scan()).find(
    (block) => block.uid === conflict.uid,
  );
  if (
    !local ||
    local.path !== conflict.path ||
    local.raw !== conflict.currentRaw ||
    !(await notes.isUnchanged(local))
  )
    throw new Error("The note changed. Sync again before resolving it.");
  const oldEvent = await api.get(conflict.eventId);
  if (oldEvent && oldEvent.status !== "cancelled")
    throw new Error(
      "The Google event returned. Sync again before resolving it.",
    );
  if (choice === "accept") {
    await notes.cancel(local);
    record.deleted = true;
    delete record.pendingConflict;
    await save();
    return;
  }
  const eventId = crypto.randomUUID().replace(/-/g, "");
  state.pendingCreate = {
    uid: conflict.uid,
    path: conflict.path,
    snapshot: draft.mine,
    eventId,
    currentRaw: local.raw,
  };
  await save();
  const created = await api.create(eventId, conflict.uid, draft.mine, local);
  if (
    created.id !== eventId ||
    !isCanonicalOwned(created, state.namespace, conflict.uid)
  )
    throw new Error(
      "Google did not confirm ownership of the restored event. Sync again.",
    );
  const confirmed = canonicalSnapshotOf(created, draft.mine);
  if (!confirmed || !sameCanonicalSnapshot(confirmed, draft.mine))
    throw new Error("Google did not confirm the restored event. Sync again.");
  if (
    local.raw !== draft.raw ||
    !sameCanonicalSnapshot(
      { ...normalizeLocalSnapshot(local), colorId: draft.mine.colorId },
      draft.mine,
    )
  ) {
    const restored = await notes.write(
      conflict.uid,
      confirmed,
      local,
      draft.raw,
    );
    record.path = restored.path;
  }
  record.eventId = eventId;
  record.base = confirmed;
  record.remoteEtag = created.etag;
  record.remoteUpdated = created.updated;
  delete record.pendingConflict;
  delete state.pendingCreate;
  await save();
}

export interface MissingLocalConflict {
  uid: string;
  path: string;
  remote: GoogleEvent;
  remoteSnapshot: CalendarSnapshot;
  base: CalendarSnapshot;
}

/** Explicitly resolve a missing local block without weakening automatic deletion. */
export async function resolveMissingLocalConflict(
  conflict: MissingLocalConflict,
  choice: "restore" | "remove",
  state: CalendarSyncState,
  api: CalendarApi,
  notes: CalendarNotes,
  save: () => Promise<void>,
) {
  const record = state.records[conflict.uid];
  const same =
    record?.base.tags !== undefined ? sameCanonicalSnapshot : sameSnapshot;
  if (notes.canSync && !(await notes.canSync(conflict.path, conflict.base)))
    throw new Error("This note is outside calendar sync scope.");
  if (
    !record ||
    record.deleted ||
    record.pendingDelete ||
    record.path !== conflict.path ||
    record.eventId !== conflict.remote.id ||
    !same(record.base, conflict.base)
  )
    throw new Error("This conflict changed. Sync again before resolving it.");
  const assertMissing = async () => {
    if ((await notes.scan()).some((block) => block.uid === conflict.uid))
      throw new Error(
        "The note task has returned. Sync again before resolving it.",
      );
  };
  await assertMissing();
  const remote = await api.get(record.eventId);
  if (
    !remote ||
    !remote.etag ||
    remote.etag !== conflict.remote.etag ||
    !(record.base.tags !== undefined
      ? isCanonicalOwned(remote, state.namespace, conflict.uid)
      : isOwned(remote, state.namespace, conflict.uid))
  )
    throw new Error(
      "Google changed or ownership could not be verified. Sync again.",
    );
  const canonical = record.base.tags !== undefined;
  const snapshot = canonical
    ? canonicalSnapshotOf(remote, record.base)
    : snapshotOf(remote, "");
  if (!snapshot || !same(snapshot, conflict.remoteSnapshot))
    throw new Error("Google changed. Sync again before resolving it.");
  await assertMissing();
  if (notes.canSync && !(await notes.canSync("", snapshot)))
    throw new Error("The Google event is outside calendar sync scope.");
  if (choice === "restore") {
    const restored = await notes.write(
      conflict.uid,
      snapshot,
      undefined,
      state.identities?.[conflict.uid]?.raw || undefined,
    );
    record.path = restored.path;
    record.base = snapshot;
    await save();
    return;
  }
  record.pendingDelete = true;
  await save();
  try {
    await assertMissing();
  } catch (error) {
    delete record.pendingDelete;
    await save();
    throw error;
  }
  await api.remove(remote);
  record.deleted = true;
  delete record.pendingDelete;
  await save();
}

export interface CalendarConflict {
  uid: string;
  local: LocalBlock;
  remote: GoogleEvent;
  remoteSnapshot: CalendarSnapshot;
  base: CalendarSnapshot;
  mine?: CalendarSnapshot;
  fields?: string[];
  detectedAt?: string;
}

/** Resolve only the exact versions shown to the user; never advance a stale baseline. */
export async function resolveCalendarConflict(
  conflict: CalendarConflict,
  choice: "note" | "google",
  state: CalendarSyncState,
  api: CalendarApi,
  notes: CalendarNotes,
  save: () => Promise<void>,
) {
  const record = state.records[conflict.uid];
  const same =
    record?.base.tags !== undefined ? sameCanonicalSnapshot : sameSnapshot;
  if (
    !record ||
    record.deleted ||
    record.eventId !== conflict.remote.id ||
    !same(record.base, conflict.base)
  )
    throw new Error("This conflict changed. Sync again before resolving it.");
  if (notes.canSync && !(await notes.canSync(record.path, record.base)))
    throw new Error("This note is outside calendar sync scope.");
  const canonical = record.base.tags !== undefined;
  const blocks = await notes.scan();
  const scanned = blocks.find((block) => block.uid === conflict.uid);
  const local =
    scanned && canonical
      ? {
          ...scanned,
          snapshot: {
            ...normalizeLocalSnapshot(scanned),
            colorId: record.base.colorId,
          },
        }
      : scanned;
  if (
    !local ||
    local.path !== conflict.local.path ||
    local.raw !== conflict.local.raw ||
    !(await notes.isUnchanged(local))
  )
    throw new Error("The note changed. Sync again before resolving it.");
  const remote = await api.get(record.eventId);
  if (
    !remote ||
    remote.etag !== conflict.remote.etag ||
    !(record.base.tags !== undefined
      ? isCanonicalOwned(remote, state.namespace, conflict.uid)
      : isOwned(remote, state.namespace, conflict.uid))
  )
    throw new Error(
      "Google changed or ownership could not be verified. Sync again.",
    );
  const snapshot = canonical
    ? canonicalSnapshotOf(remote, record.base)
    : snapshotOf(remote, "");
  if (!snapshot || !same(snapshot, conflict.remoteSnapshot))
    throw new Error("Google changed. Sync again before resolving it.");
  if (!(await notes.isUnchanged(local)))
    throw new Error("The note changed. Sync again before resolving it.");
  const desired =
    choice === "note" ? (conflict.mine ?? local.snapshot) : snapshot;
  if (notes.canSync && !(await notes.canSync("", desired)))
    throw new Error("The selected event is outside calendar sync scope.");
  if (choice === "note") {
    const updated = await api.update(remote, desired);
    const verified = canonical
      ? canonicalSnapshotOf(updated, desired)
      : snapshotOf(updated, "");
    if (!verified || !same(verified, desired))
      throw new Error(
        "Google did not confirm the selected note version. Sync again.",
      );
    if (canonical && !same(local.snapshot, desired)) {
      const cached = await notes.write(conflict.uid, desired, local);
      record.path = cached.path;
    }
    record.base = verified;
    record.remoteEtag = updated.etag;
    record.remoteUpdated = updated.updated;
  } else {
    const updated = await notes.write(conflict.uid, snapshot, local);
    record.path = updated.path;
    record.base = snapshot;
  }
  delete record.pendingConflict;
  await save();
}

/** Recover an owned write's baseline before a newer projection supersedes it. */
export async function recoverCalendarProjection({
  state,
  api,
  save,
  uid,
  path,
  snapshot,
  base,
}: {
  state: CalendarSyncState;
  api: CalendarApi;
  save: () => Promise<void>;
  uid: string;
  path: string;
  snapshot: CalendarSnapshot;
  base?: CalendarSnapshot;
}) {
  const record = state.records[uid];
  if (record?.deleted) return;
  if (record?.base.tags !== undefined) return;
  const eventId = record?.eventId ?? exportId(state.namespace, uid);
  const event = await api.get(eventId);
  if (!event) return;
  if (!record && !isOwned(event, state.namespace, uid))
    throw new Error(
      "Review this event's calendar ownership before recovering its export.",
    );
  const current = snapshotOf(
    event,
    isOwned(event, state.namespace, uid) ? "" : undefined,
  );
  if (
    record &&
    (!current ||
      !sameSnapshot(current, snapshot) ||
      (!sameSnapshot(record.base, snapshot) &&
        (!base || !sameSnapshot(record.base, base))))
  )
    return;
  if (!record && !current && event.status !== "cancelled")
    throw new Error("Review this event's times before recovering its export.");
  state.records[uid] = { eventId, path, base: snapshot };
  await save();
}

export function exportId(namespace: string, uid: string) {
  return `dp${namespace}${uid}`;
}

export function isOwned(event: GoogleEvent, namespace: string, uid: string) {
  const properties = event.extendedProperties?.private;
  return (
    event.id === exportId(namespace, uid) &&
    properties?.["dayPlannerVault"] === namespace &&
    properties["dayPlannerBlock"] === uid
  );
}

export function isCanonicalOwned(
  event: GoogleEvent,
  namespace: string,
  uid: string,
) {
  const properties = event.extendedProperties?.private;
  return (
    properties?.["dayPlannerVault"] === namespace &&
    properties["dayPlannerBlock"] === uid
  );
}

export async function importUid(namespace: string, eventId: string) {
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${namespace}:${eventId}`),
  );
  return Array.from(new Uint8Array(hash))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 32);
}

/** Three-way comparison; failed/ambiguous operations never advance the baseline. */
export async function syncCalendar({
  state,
  api,
  notes,
  save,
  timeMin,
  timeMax,
  importEvents = true,
  canonical = false,
}: {
  state: CalendarSyncState;
  api: CalendarApi;
  notes: CalendarNotes;
  save: () => Promise<void>;
  timeMin: string;
  timeMax: string;
  importEvents?: boolean;
  canonical?: boolean;
}): Promise<SyncResult> {
  if (canonical)
    return syncCanonicalCalendar({
      state,
      api,
      notes,
      save,
      timeMin,
      timeMax,
      importEvents,
    });
  const result: SyncResult = {
    pushed: 0,
    pulled: 0,
    deleted: 0,
    conflicts: [],
    reviewable: [],
    missingLocal: [],
    deletedRemote: [],
  };
  // Resolve a lost DELETE response before assigning identities. A block
  // restored in the meantime can then be exported with a fresh ID.
  for (const record of Object.values(state.records)) {
    if (notes.canSync && !(await notes.canSync(record.path, record.base)))
      continue;
    if (!record.pendingDelete) continue;
    const remote = await api.get(record.eventId);
    if (remote && remote.status !== "cancelled") continue;
    record.deleted = true;
    delete record.pendingDelete;
    await save();
    result.deleted++;
  }
  const locals = await notes.scan();
  const byUid = new Map<string, LocalBlock>();
  for (const block of locals) {
    if (byUid.has(block.uid))
      throw new Error(
        "Duplicate Google sync IDs. Remove the ID comment from copied blocks before syncing.",
      );
    byUid.set(block.uid, block);
  }
  // Finish an interrupted import even when the event has since left the window.
  if (state.pendingImport) {
    const pending = state.pendingImport;
    if (notes.canSync && !(await notes.canSync("", pending.snapshot)))
      throw new Error(
        "A pending calendar import is outside sync scope. Review it before syncing.",
      );
    const local =
      byUid.get(pending.uid) ??
      (await notes.write(pending.uid, pending.snapshot));
    state.records[pending.uid] = {
      eventId: pending.eventId,
      path: local.path,
      base: pending.snapshot,
    };
    if (!byUid.has(pending.uid)) {
      byUid.set(pending.uid, local);
      locals.push(local);
    }
    delete state.pendingImport;
    await save();
  }
  // Fetch every page before making changes; absence from a window is never deletion.
  const events = await api.list(timeMin, timeMax);
  const byEvent = new Map(events.map((event) => [event.id, event]));
  if (state.pendingCreate) {
    const { uid, path, snapshot } = state.pendingCreate;
    if (notes.canSync && !(await notes.canSync(path, snapshot)))
      throw new Error(
        "A pending calendar export is outside sync scope. Review it before syncing.",
      );
    const eventId = exportId(state.namespace, uid);
    const remote = byEvent.get(eventId) ?? (await api.get(eventId));
    if (remote) {
      if (
        remote.status !== "cancelled" &&
        !isOwned(remote, state.namespace, uid)
      )
        throw new Error(
          "An event with the pending export ID belongs to another source.",
        );
      // Compare any later changes against the snapshot that was sent.
      state.records[uid] = { eventId, path, base: snapshot };
    }
    delete state.pendingCreate;
    await save();
  }
  const linkedEvents = new Set(
    Object.values(state.records).map((record) => record.eventId),
  );
  const importedIds = new Map<string, string>();
  for (const event of events) {
    if (
      !linkedEvents.has(event.id) &&
      !event.extendedProperties?.private?.["dayPlannerVault"]
    ) {
      importedIds.set(event.id, await importUid(state.namespace, event.id));
    }
  }
  const pendingImportUids = new Set(importedIds.values());

  for (const [uid, record] of Object.entries(state.records)) {
    if (record.deleted) continue;
    if (notes.canSync && !(await notes.canSync(record.path, record.base)))
      continue;
    const local = byUid.get(uid);
    let descriptionBlock = local;
    const remote =
      byEvent.get(record.eventId) ?? (await api.get(record.eventId));
    let colorEvent = remote;
    const remoteDeleted = !remote || remote.status === "cancelled";
    const owned = remote !== null && isOwned(remote, state.namespace, uid);
    // Google may omit the summary of a time-only block.
    const untitled = owned ? "" : undefined;
    const remoteSnapshot = remote && snapshotOf(remote, untitled);
    if (
      remoteSnapshot &&
      notes.canSync &&
      !(await notes.canSync("", remoteSnapshot))
    )
      continue;
    const localChanged = local && !sameSnapshot(local.snapshot, record.base);
    const remoteChanged =
      remoteSnapshot && !sameSnapshot(remoteSnapshot, record.base);
    const conflict = (reason: string) =>
      result.conflicts.push(`${record.path}: ${record.base.title} — ${reason}`);

    if (local && !(await notes.isUnchanged(local))) {
      conflict("note changed during sync; retry");
      continue;
    }
    if (remoteDeleted) {
      if (localChanged && !record.pendingDelete) {
        conflict("Google deleted this event while the note was edited");
        continue;
      }
      if (local && !record.pendingDelete) await notes.cancel(local);
      record.deleted = true;
      delete record.pendingDelete;
      await save();
      result.deleted++;
      continue;
    }
    if (record.pendingDelete) {
      // A fresh comparison below will reauthorize a DELETE if still needed.
      delete record.pendingDelete;
      await save();
    }
    if (!remoteSnapshot) {
      conflict("event is no longer a supported timed event");
      continue;
    }
    if (!local) {
      if (record.eventId === exportId(state.namespace, uid) && !owned) {
        conflict("the event's Day Planner ownership could not be verified");
        continue;
      }
      if (!(await notes.canDelete(record, uid, owned))) {
        conflict(
          "local deletion is disabled or the removed block could not be verified",
        );
        if (owned && remote.etag)
          result.missingLocal.push({
            uid,
            path: record.path,
            remote,
            remoteSnapshot,
            base: { ...record.base },
          });
        continue;
      }
      if (remoteChanged) {
        conflict("note block was removed while Google was edited");
        if (owned && remote.etag)
          result.missingLocal.push({
            uid,
            path: record.path,
            remote,
            remoteSnapshot,
            base: { ...record.base },
          });
        continue;
      }
      record.pendingDelete = true;
      await save();
      await api.remove(remote);
      record.deleted = true;
      delete record.pendingDelete;
      await save();
      result.deleted++;
      continue;
    }
    if (
      localChanged &&
      remoteChanged &&
      !sameSnapshot(local.snapshot, remoteSnapshot)
    ) {
      conflict(
        "both sides changed; make title and times match on both sides, then sync again",
      );
      if (owned)
        result.reviewable.push({
          uid,
          local,
          remote,
          remoteSnapshot,
          base: { ...record.base },
        });
      continue;
    }
    if (localChanged && !remoteChanged) {
      const updated = await api.update(remote, local.snapshot);
      colorEvent = updated;
      record.base = snapshotOf(updated, untitled) ?? local.snapshot;
      result.pushed++;
    } else if (remoteChanged && !localChanged) {
      const updated = await notes.write(uid, remoteSnapshot, local);
      descriptionBlock = updated;
      record.path = updated.path;
      record.base = remoteSnapshot;
      result.pulled++;
    } else {
      record.base = local.snapshot;
    }
    if (!(remoteChanged && !localChanged)) record.path = local.path;
    await save();
    if (api.syncColor && colorEvent) {
      const colored = await api.syncColor(colorEvent, record.base);
      if (colored !== colorEvent) result.pushed++;
      colorEvent = colored;
    }
    if (api.syncSubtasks && colorEvent && descriptionBlock) {
      if (!(await notes.isUnchanged(descriptionBlock))) {
        conflict("note changed while preparing subtasks; retry");
        continue;
      }
      if ((await api.syncSubtasks(colorEvent, descriptionBlock)) !== colorEvent)
        result.pushed++;
    }
  }

  for (const local of locals) {
    if (notes.canSync && !(await notes.canSync(local.path, local.snapshot)))
      continue;
    if (state.records[local.uid]) continue;
    if (pendingImportUids.has(local.uid)) continue;
    if (local.snapshot.start < timeMin || local.snapshot.start >= timeMax)
      continue;
    if (!(await notes.isUnchanged(local))) continue;
    // Deterministic Google IDs survive a timeout/crash after a successful POST.
    const eventId = exportId(state.namespace, local.uid);
    let event: GoogleEvent | null =
      byEvent.get(eventId) ?? (await api.get(eventId));
    if (!event) {
      state.pendingCreate = {
        uid: local.uid,
        path: local.path,
        snapshot: local.snapshot,
      };
      await save();
      event = await api.create(eventId, local.uid, local.snapshot, local);
    }
    const existing = snapshotOf(event, "");
    if (
      !isOwned(event, state.namespace, local.uid) ||
      !existing ||
      !sameSnapshot(existing, local.snapshot)
    ) {
      if (state.pendingCreate)
        throw new Error(
          "Google did not return the expected event for a pending export.",
        );
      result.conflicts.push(
        `${local.path}: ${local.snapshot.title} — an existing event differs; no overwrite`,
      );
      continue;
    }
    state.records[local.uid] = {
      eventId: event.id,
      path: local.path,
      base: local.snapshot,
    };
    delete state.pendingCreate;
    linkedEvents.add(event.id);
    await save();
    result.pushed++;
    event = (await api.syncColor?.(event, local.snapshot)) ?? event;
    if (await notes.isUnchanged(local)) await api.syncSubtasks?.(event, local);
  }

  if (!importEvents) return result;
  for (const event of events) {
    if (
      linkedEvents.has(event.id) ||
      event.extendedProperties?.private?.["dayPlannerVault"]
    )
      continue;
    const snapshot = snapshotOf(event);
    if (snapshot && notes.canSync && !(await notes.canSync("", snapshot)))
      continue;
    if (!snapshot && event.start?.dateTime && event.status !== "cancelled") {
      result.conflicts.push(
        `${event.summary ?? event.id} — event times must be valid and aligned to whole minutes`,
      );
    }
    if (!snapshot || (event.eventType && event.eventType !== "default"))
      continue;
    // Stable across crashes before saving the import mapping.
    const uid = importedIds.get(event.id);
    if (!uid) continue;
    if (
      Date.parse(snapshot.end) - Date.parse(snapshot.start) >
      24 * 60 * 60 * 1000
    ) {
      result.conflicts.push(
        `${snapshot.title} — timed events longer than 24 hours are not supported`,
      );
      continue;
    }
    const previous = byUid.get(uid);
    if (previous && !sameSnapshot(previous.snapshot, snapshot)) {
      result.conflicts.push(
        `${previous.path}: imported event differs after interrupted sync`,
      );
      continue;
    }
    state.pendingImport = { uid, eventId: event.id, snapshot };
    await save();
    const local = previous ?? (await notes.write(uid, snapshot));
    state.records[uid] = {
      eventId: event.id,
      path: local.path,
      base: snapshot,
    };
    delete state.pendingImport;
    await save();
    result.pulled++;
    const colored = (await api.syncColor?.(event, snapshot)) ?? event;
    if (await notes.isUnchanged(local))
      await api.syncSubtasks?.(colored, local);
  }
  return result;
}
