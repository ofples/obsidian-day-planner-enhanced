import {
  sameSnapshot,
  snapshotOf,
  type CalendarApi,
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
}

function exportId(namespace: string, uid: string) {
  return `dp${namespace}${uid}`;
}

function isOwned(event: GoogleEvent, namespace: string, uid: string) {
  const properties = event.extendedProperties?.private;
  return (
    event.id === exportId(namespace, uid) &&
    properties?.["dayPlannerVault"] === namespace &&
    properties["dayPlannerBlock"] === uid
  );
}

async function importUid(namespace: string, eventId: string) {
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
}: {
  state: CalendarSyncState;
  api: CalendarApi;
  notes: CalendarNotes;
  save: () => Promise<void>;
  timeMin: string;
  timeMax: string;
  importEvents?: boolean;
}): Promise<SyncResult> {
  const result: SyncResult = {
    pushed: 0,
    pulled: 0,
    deleted: 0,
    conflicts: [],
  };
  // Resolve a lost DELETE response before assigning identities. A block
  // restored in the meantime can then be exported with a fresh ID.
  for (const record of Object.values(state.records)) {
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
        continue;
      }
      if (remoteChanged) {
        conflict("note block was removed while Google was edited");
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
