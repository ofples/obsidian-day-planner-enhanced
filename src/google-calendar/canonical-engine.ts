import {
  exportId,
  importUid,
  isOwned,
  isCanonicalOwned,
  type SyncResult,
} from "./engine";
import { normalizeLocalSnapshot } from "./markdown";
import {
  canonicalSnapshotOf,
  sameCanonicalSnapshot,
  type CalendarApi,
  type CalendarNotes,
  type CalendarSnapshot,
  type CalendarSyncState,
  type GoogleEvent,
  type LocalBlock,
} from "./types";

const fields = [
  "title",
  "time",
  "tags",
  "subtasks",
  "description",
  "colorId",
] as const;
type Field = (typeof fields)[number];

function value(snapshot: CalendarSnapshot, field: Field) {
  if (field === "time")
    return [Date.parse(snapshot.start), Date.parse(snapshot.end)];
  if (field === "tags") return snapshot.tags ?? [];
  if (field === "colorId") return snapshot.colorId ?? null;
  return snapshot[field] ?? "";
}

function sameField(a: CalendarSnapshot, b: CalendarSnapshot, field: Field) {
  return JSON.stringify(value(a, field)) === JSON.stringify(value(b, field));
}

function copyField(
  target: CalendarSnapshot,
  source: CalendarSnapshot,
  field: Field,
) {
  switch (field) {
    case "time":
      target.start = source.start;
      target.end = source.end;
      break;
    case "title":
      target.title = source.title;
      break;
    case "tags":
      target.tags = [...(source.tags ?? [])];
      break;
    case "subtasks":
      target.subtasks = source.subtasks ?? "";
      break;
    case "description":
      target.description = source.description ?? "";
      break;
    case "colorId":
      target.colorId = source.colorId ?? null;
      break;
  }
}

/** Apply independent edits while retaining both values for competing fields. */
export function mergeCalendarFields(
  base: CalendarSnapshot,
  local: CalendarSnapshot,
  remote: CalendarSnapshot,
) {
  const merged = { ...remote };
  const mine = { ...remote };
  const conflicts: Field[] = [];
  for (const field of fields) {
    if (sameField(local, base, field)) continue;
    copyField(mine, local, field);
    if (!sameField(remote, base, field) && !sameField(local, remote, field))
      conflicts.push(field);
    else copyField(merged, local, field);
  }
  return { merged, mine, conflicts };
}

function localSnapshot(block: LocalBlock, base?: CalendarSnapshot) {
  return { ...normalizeLocalSnapshot(block), colorId: base?.colorId };
}

function validSnapshot(event: GoogleEvent, base?: CalendarSnapshot) {
  const snapshot = canonicalSnapshotOf(event, base);
  if (
    !snapshot ||
    Date.parse(snapshot.end) - Date.parse(snapshot.start) > 86_400_000
  )
    throw new Error(
      "This Google event needs a supported timed block of at most 24 hours.",
    );
  return snapshot;
}

export async function syncCanonicalCalendar({
  state,
  api,
  notes,
  save,
  timeMin,
  timeMax,
  importEvents,
}: {
  state: CalendarSyncState;
  api: CalendarApi;
  notes: CalendarNotes;
  save: () => Promise<void>;
  timeMin: string;
  timeMax: string;
  importEvents: boolean;
}): Promise<SyncResult> {
  const result: SyncResult = {
    pushed: 0,
    pulled: 0,
    deleted: 0,
    conflicts: [],
    reviewable: [],
    missingLocal: [],
    deletedRemote: [],
  };
  const allowed = async (path: string, snapshot: CalendarSnapshot) =>
    !notes.canSync || (await notes.canSync(path, snapshot));
  const locals = await notes.scan();
  const byUid = new Map<string, LocalBlock>();
  for (const block of locals) {
    if (byUid.has(block.uid))
      throw new Error(
        "Two note blocks share a Google event identity. Review their links before syncing.",
      );
    byUid.set(block.uid, block);
  }
  const recordsByEvent = new Map<string, string>();
  for (const [uid, record] of Object.entries(state.records)) {
    if (recordsByEvent.has(record.eventId))
      throw new Error(
        "Two note identities share one Google event. Review their links before syncing.",
      );
    recordsByEvent.set(record.eventId, uid);
  }
  let events: GoogleEvent[];
  if (api.changes) {
    const cache = state.eventCache;
    const reusable = cache?.timeMin === timeMin && cache.timeMax === timeMax;
    const changes = await api.changes(
      timeMin,
      timeMax,
      reusable ? cache.syncToken : undefined,
    );
    const merged = new Map(
      reusable && !changes.reset
        ? cache.events.map((event) => [event.id, event] as const)
        : [],
    );
    for (const event of changes.events) merged.set(event.id, event);
    events = [...merged.values()];
    state.eventCache = {
      timeMin,
      timeMax,
      syncToken: changes.syncToken,
      events,
    };
    await save();
  } else events = await api.list(timeMin, timeMax);
  const byEvent = new Map(events.map((event) => [event.id, event]));
  const remember = (event: GoogleEvent) => {
    byEvent.set(event.id, event);
    if (state.eventCache) state.eventCache.events = [...byEvent.values()];
    return event;
  };

  if (state.pendingImport) {
    const pending = state.pendingImport;
    if (!(await allowed("", pending.snapshot)))
      throw new Error(
        "A pending import is outside sync scope. Review it before syncing.",
      );
    const event = await api.get(pending.eventId);
    if (event && event.status !== "cancelled") {
      remember(event);
      const snapshot = validSnapshot(event, pending.snapshot);
      if (!(await allowed("", snapshot)))
        throw new Error("The pending Google event moved outside sync scope.");
      const previous = byUid.get(pending.uid);
      if (!isCanonicalOwned(event, state.namespace, pending.uid))
        throw new Error(
          "The pending Google event link changed. Review it before retrying.",
        );
      const local = previous ?? (await notes.write(pending.uid, snapshot));
      byUid.set(pending.uid, local);
      state.records[pending.uid] = {
        eventId: event.id,
        path: local.path,
        base: previous ? pending.snapshot : snapshot,
        remoteEtag: event.etag,
        remoteUpdated: event.updated,
      };
      recordsByEvent.set(event.id, pending.uid);
    }
    delete state.pendingImport;
    await save();
  }
  if (state.pendingCreate) {
    const pending = state.pendingCreate;
    if (!(await allowed(pending.path, pending.snapshot)))
      throw new Error(
        "A pending export is outside sync scope. Review it before syncing.",
      );
    const id = pending.eventId ?? exportId(state.namespace, pending.uid);
    let event = await api.get(id);
    if (event) remember(event);
    if (pending.eventId && !event) {
      const local = byUid.get(pending.uid);
      if (
        !local ||
        local.path !== pending.path ||
        local.raw !== pending.currentRaw ||
        !(await notes.isUnchanged(local))
      )
        throw new Error(
          "The pending restored task changed. Review the note before retrying.",
        );
      event = await api.create(id, pending.uid, pending.snapshot, local);
      remember(event);
    }
    if (event && event.status !== "cancelled") {
      if (
        !(pending.eventId
          ? isCanonicalOwned(event, state.namespace, pending.uid)
          : isOwned(event, state.namespace, pending.uid))
      )
        throw new Error(
          "The pending event identity belongs to another source.",
        );
      if (
        pending.eventId &&
        !sameCanonicalSnapshot(
          validSnapshot(event, pending.snapshot),
          pending.snapshot,
        )
      )
        throw new Error(
          "The pending restored event changed. Review it before retrying.",
        );
      let path = pending.path;
      if (pending.eventId) {
        const local = byUid.get(pending.uid);
        const draft = state.records[pending.uid]?.pendingConflict;
        if (!local || !draft || !(await notes.isUnchanged(local)))
          throw new Error(
            "The pending restored task changed. Review the note before retrying.",
          );
        if (
          !sameCanonicalSnapshot(
            localSnapshot(local, pending.snapshot),
            pending.snapshot,
          )
        ) {
          if (local.path !== pending.path || local.raw !== pending.currentRaw)
            throw new Error(
              "The pending restored task changed. Review the note before retrying.",
            );
          const restored = await notes.write(
            pending.uid,
            pending.snapshot,
            local,
            draft.raw,
          );
          byUid.set(pending.uid, restored);
          path = restored.path;
        } else path = local.path;
      }
      state.records[pending.uid] = {
        eventId: id,
        path,
        base: pending.snapshot,
        remoteEtag: event.etag,
        remoteUpdated: event.updated,
      };
      recordsByEvent.set(id, pending.uid);
    }
    if (pending.eventId && (!event || event.status === "cancelled"))
      throw new Error(
        "The pending restored event is unavailable. Review it before retrying.",
      );
    delete state.pendingCreate;
    await save();
  }

  const missingPaths = new Set<string>();
  for (const [uid, record] of Object.entries(state.records)) {
    if (record.deleted || !(await allowed(record.path, record.base))) continue;
    const local = byUid.get(uid);
    const conflict = (message: string) =>
      result.conflicts.push(
        `${record.path}: ${record.base.title} — ${message}`,
      );
    try {
      let event =
        byEvent.get(record.eventId) ?? (await api.get(record.eventId));
      if (!event || event.status === "cancelled") {
        if (local) {
          const mine = localSnapshot(local, record.base);
          if (
            record.pendingConflict ||
            !sameCanonicalSnapshot(mine, record.base)
          ) {
            if (record.pendingConflict) {
              if (
                record.pendingConflict.fields.includes("deletion") &&
                record.pendingConflict.currentRaw !== local.raw
              ) {
                conflict(
                  "The displayed note changed after the deletion conflict. Review its saved draft before retrying.",
                );
                continue;
              }
              if (!record.pendingConflict.fields.includes("deletion")) {
                record.pendingConflict.fields.push("deletion");
                record.pendingConflict.currentRaw = local.raw;
              }
            } else
              record.pendingConflict = {
                mine,
                raw: local.raw,
                fields: ["deletion"],
                detectedAt: new Date().toISOString(),
                currentRaw: local.raw,
              };
            await save();
            conflict(
              "Google deleted this event. The local draft is saved for review.",
            );
            const draft = record.pendingConflict;
            result.deletedRemote.push({
              uid,
              path: record.path,
              eventId: record.eventId,
              mine: draft.mine,
              raw: draft.raw,
              currentRaw: local.raw,
              detectedAt: draft.detectedAt,
            });
            continue;
          }
          if (!(await notes.isUnchanged(local)))
            throw new Error(
              "The note changed during sync. Try again after editing.",
            );
          await notes.cancel(local);
        }
        record.deleted = true;
        delete record.pendingDelete;
        await save();
        result.deleted++;
        continue;
      }
      const remote = validSnapshot(event, record.base);
      if (!(await allowed("", remote))) {
        conflict("Google moved this event outside the enabled note dates.");
        continue;
      }
      if (!isCanonicalOwned(event, state.namespace, uid)) {
        if (!api.link)
          throw new Error(
            "This Google event needs its planner link verified before editing.",
          );
        event = await api.link(event, uid, remote);
        remember(event);
      }
      if (!local) {
        missingPaths.add(record.path);
        if (record.pendingDelete) delete record.pendingDelete;
        if (
          isCanonicalOwned(event, state.namespace, uid) &&
          (await notes.canDelete(record, uid, true)) &&
          sameCanonicalSnapshot(remote, record.base)
        ) {
          record.pendingDelete = true;
          await save();
          await api.remove(event);
          record.deleted = true;
          delete record.pendingDelete;
          await save();
          result.deleted++;
        } else {
          conflict(
            "The note block is missing. Choose whether to restore it or remove the Google event.",
          );
          if (isCanonicalOwned(event, state.namespace, uid) && event.etag)
            result.missingLocal.push({
              uid,
              path: record.path,
              remote: event,
              remoteSnapshot: remote,
              base: { ...record.base },
            });
        }
        continue;
      }
      if (!(await notes.isUnchanged(local)))
        throw new Error(
          "The note changed during sync. Try again after editing.",
        );
      const current = localSnapshot(local, record.base);
      // A future legacy link is adopted from Google before any structured write.
      const base =
        record.base.tags === undefined
          ? {
              ...remote,
              title: record.base.title,
              start: record.base.start,
              end: record.base.end,
            }
          : record.base;
      const change = mergeCalendarFields(base, current, remote);
      if (record.pendingConflict) {
        const saved = record.pendingConflict;
        const mine = { ...remote };
        const competing: Field[] = [];
        for (const field of fields) {
          if (
            saved.fields.includes(field) &&
            !sameField(saved.mine, remote, field)
          ) {
            copyField(mine, saved.mine, field);
            competing.push(field);
          }
          if (
            !sameField(current, record.base, field) &&
            !sameField(current, remote, field)
          ) {
            copyField(mine, current, field);
            if (
              !sameField(current, remote, field) &&
              !competing.includes(field)
            )
              competing.push(field);
          }
        }
        change.merged = { ...remote };
        change.mine = mine;
        change.conflicts = competing;
      }
      const confirmed = await api.update(event, change.merged);
      remember(confirmed);
      if (
        !sameCanonicalSnapshot(
          validSnapshot(confirmed, change.merged),
          change.merged,
        )
      )
        throw new Error(
          "Google did not confirm the pending edits. Sync again.",
        );
      if (confirmed !== event) result.pushed++;
      const accepted = validSnapshot(confirmed, change.merged);
      if (change.conflicts.length) {
        record.pendingConflict = {
          mine: change.mine,
          raw: record.pendingConflict?.raw ?? local.raw,
          fields: change.conflicts,
          detectedAt:
            record.pendingConflict?.detectedAt ?? new Date().toISOString(),
        };
        await save();
      }
      let cached = local;
      if (!sameCanonicalSnapshot(current, accepted)) {
        cached = await notes.write(uid, accepted, local);
        result.pulled++;
      }
      record.path = cached.path;
      record.base = accepted;
      record.remoteEtag = confirmed.etag;
      record.remoteUpdated = confirmed.updated;
      if (!change.conflicts.length) delete record.pendingConflict;
      await save();
      if (record.pendingConflict) {
        conflict(
          `Competing edits to ${record.pendingConflict.fields.join(", ")}. Google is shown and your Obsidian draft is saved.`,
        );
        result.reviewable.push({
          uid,
          local: { ...cached, snapshot: accepted },
          remote: confirmed,
          remoteSnapshot: accepted,
          base: accepted,
          mine: record.pendingConflict.mine,
          fields: record.pendingConflict.fields,
          detectedAt: record.pendingConflict.detectedAt,
        });
      }
    } catch (error) {
      conflict(
        error instanceof Error ? error.message : "Calendar sync needs review.",
      );
    }
  }

  for (const local of locals) {
    if (
      state.records[local.uid] ||
      !(await allowed(local.path, local.snapshot))
    )
      continue;
    if (missingPaths.has(local.path)) {
      result.conflicts.push(
        `${local.path}: Link the missing event before exporting unmatched note blocks.`,
      );
      continue;
    }
    if (
      local.snapshot.start < timeMin ||
      local.snapshot.start >= timeMax ||
      !(await notes.isUnchanged(local))
    )
      continue;
    const snapshot = normalizeLocalSnapshot(local);
    const id = exportId(state.namespace, local.uid);
    let event = byEvent.get(id) ?? (await api.get(id));
    if (!event) {
      state.pendingCreate = { uid: local.uid, path: local.path, snapshot };
      await save();
      event = await api.create(id, local.uid, snapshot, local);
      remember(event);
    }
    if (!isOwned(event, state.namespace, local.uid))
      throw new Error("The event identity belongs to another source.");
    const accepted = validSnapshot(event, snapshot);
    let cached = local;
    if (!sameCanonicalSnapshot(localSnapshot(local, accepted), accepted))
      cached = await notes.write(local.uid, accepted, local);
    state.records[local.uid] = {
      eventId: event.id,
      path: cached.path,
      base: accepted,
      remoteEtag: event.etag,
      remoteUpdated: event.updated,
    };
    delete state.pendingCreate;
    recordsByEvent.set(event.id, local.uid);
    await save();
    result.pushed++;
  }

  if (!importEvents) return result;
  for (const event of events) {
    if (
      recordsByEvent.has(event.id) ||
      event.status === "cancelled" ||
      (event.eventType && event.eventType !== "default")
    )
      continue;
    try {
      const snapshot = canonicalSnapshotOf(event);
      if (!snapshot || !(await allowed("", snapshot))) continue;
      if (
        Date.parse(snapshot.end) <= Date.parse(timeMin) ||
        Date.parse(snapshot.start) >= Date.parse(timeMax)
      )
        continue;
      if (Date.parse(snapshot.end) - Date.parse(snapshot.start) > 86_400_000)
        continue;
      const owner = event.extendedProperties?.private?.["dayPlannerVault"];
      if (owner && owner !== state.namespace) continue;
      const uid = await importUid(state.namespace, event.id);
      const linked = api.link ? await api.link(event, uid, snapshot) : event;
      remember(linked);
      state.pendingImport = { uid, eventId: event.id, snapshot };
      await save();
      const previous = byUid.get(uid);
      const cached = await notes.write(uid, snapshot, previous);
      state.records[uid] = {
        eventId: event.id,
        path: cached.path,
        base: snapshot,
        remoteEtag: linked.etag,
        remoteUpdated: linked.updated,
      };
      delete state.pendingImport;
      recordsByEvent.set(event.id, uid);
      await save();
      result.pulled++;
    } catch (error) {
      result.conflicts.push(
        `${event.summary ?? "Google event"} — ${error instanceof Error ? error.message : "Import needs review."}`,
      );
    }
  }
  return result;
}
