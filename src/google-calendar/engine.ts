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
    const remote =
      byEvent.get(record.eventId) ?? (await api.get(record.eventId));
    let colorEvent = remote;
    const remoteDeleted = !remote || remote.status === "cancelled";
    const remoteSnapshot = remote && snapshotOf(remote);
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
      if (localChanged) {
        conflict("Google deleted this event while the note was edited");
        continue;
      }
      if (local) await notes.cancel(local);
      record.deleted = true;
      await save();
      result.deleted++;
      continue;
    }
    if (!remoteSnapshot) {
      conflict("event is no longer a supported timed event");
      continue;
    }
    if (!local) {
      if (!(await notes.canDelete(record, uid))) {
        conflict(
          "source note is missing, out of scope, or the sync marker was changed",
        );
        continue;
      }
      if (remoteChanged) {
        conflict("note block was removed while Google was edited");
        continue;
      }
      await api.remove(remote);
      record.deleted = true;
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
      record.base = snapshotOf(updated) ?? local.snapshot;
      result.pushed++;
    } else if (remoteChanged && !localChanged) {
      const updated = await notes.write(uid, remoteSnapshot, local);
      record.path = updated.path;
      record.base = remoteSnapshot;
      result.pulled++;
    } else {
      record.base = local.snapshot;
    }
    if (!(remoteChanged && !localChanged)) record.path = local.path;
    await save();
    if (
      api.syncColor &&
      colorEvent &&
      (await api.syncColor(colorEvent, record.base)) !== colorEvent
    )
      result.pushed++;
  }

  for (const local of locals) {
    if (state.records[local.uid]) continue;
    if (pendingImportUids.has(local.uid)) continue;
    if (local.snapshot.start < timeMin || local.snapshot.start >= timeMax)
      continue;
    if (!(await notes.isUnchanged(local))) continue;
    // Deterministic Google IDs survive a timeout/crash after a successful POST.
    const eventId = `dp${state.namespace}${local.uid}`;
    let event: GoogleEvent | null =
      byEvent.get(eventId) ?? (await api.get(eventId));
    if (!event) event = await api.create(eventId, local.uid, local.snapshot);
    const existing = snapshotOf(event);
    if (!existing || !sameSnapshot(existing, local.snapshot)) {
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
    linkedEvents.add(event.id);
    await save();
    result.pushed++;
    await api.syncColor?.(event, local.snapshot);
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
    await api.syncColor?.(event, snapshot);
  }
  return result;
}
