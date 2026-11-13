import { readStructuredDescription } from "./subtasks";

export interface CalendarSnapshot {
  title: string;
  start: string;
  end: string;
  tags?: string[];
  colorId?: string | null;
  subtasks?: string;
  description?: string;
}

export interface GoogleEvent {
  id: string;
  etag: string;
  updated?: string;
  status?: string;
  summary?: string;
  colorId?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  recurringEventId?: string;
  eventType?: string;
  description?: string;
  source?: { title?: string; url?: string };
  location?: string;
  attendees?: Array<{ self?: boolean; responseStatus?: string }>;
  extendedProperties?: { private?: Record<string, string> };
}

export interface GoogleCalendarInfo {
  id: string;
  summary: string;
  backgroundColor?: string;
  selected?: boolean;
  hidden?: boolean;
}

export interface LocalBlock {
  uid: string;
  path: string;
  raw: string;
  snapshot: CalendarSnapshot;
  from?: number;
}

export interface LocalIdentity {
  path: string;
  raw: string;
  snapshot: CalendarSnapshot;
  from: number;
}

export interface SyncRecord {
  eventId: string;
  path: string;
  base: CalendarSnapshot;
  deleted?: boolean;
  pendingDelete?: boolean;
  pendingConflict?: {
    mine: CalendarSnapshot;
    raw: string;
    currentRaw?: string;
    fields: string[];
    detectedAt: string;
  };
  remoteEtag?: string;
  remoteUpdated?: string;
}

export interface CalendarSyncState {
  version: 1 | 2;
  namespace: string;
  calendarId: string;
  records: Record<string, SyncRecord>;
  identities?: Record<string, LocalIdentity>;
  documents?: Record<string, string>;
  eventCache?: {
    timeMin: string;
    timeMax: string;
    syncToken: string;
    events: GoogleEvent[];
  };
  pendingNoteChange?: {
    edits: Array<{ path: string; before: string; after: string }>;
    identities: Record<string, LocalIdentity>;
    documents: Record<string, string>;
  };
  pendingImport?: { uid: string; eventId: string; snapshot: CalendarSnapshot };
  pendingCreate?: {
    uid: string;
    path: string;
    snapshot: CalendarSnapshot;
    eventId?: string;
    currentRaw?: string;
  };
  pendingMove?: {
    source: LocalBlock;
    targetPath: string;
    raw: string;
    snapshot: CalendarSnapshot;
  };
}

export interface CalendarApi {
  changes?(
    timeMin: string,
    timeMax: string,
    token?: string,
  ): Promise<{ events: GoogleEvent[]; syncToken: string; reset?: boolean }>;
  link?(
    event: GoogleEvent,
    uid: string,
    snapshot: CalendarSnapshot,
  ): Promise<GoogleEvent>;
  list(timeMin: string, timeMax: string): Promise<GoogleEvent[]>;
  get(id: string): Promise<GoogleEvent | null>;
  create(
    id: string,
    uid: string,
    snapshot: CalendarSnapshot,
    block?: LocalBlock,
  ): Promise<GoogleEvent>;
  update(event: GoogleEvent, snapshot: CalendarSnapshot): Promise<GoogleEvent>;
  remove(event: GoogleEvent): Promise<void>;
  syncColor?(
    event: GoogleEvent,
    snapshot: CalendarSnapshot,
  ): Promise<GoogleEvent>;
  syncSubtasks?(event: GoogleEvent, block: LocalBlock): Promise<GoogleEvent>;
}

export interface CalendarNotes {
  canSync?(path: string, snapshot: CalendarSnapshot): Promise<boolean>;
  scan(): Promise<LocalBlock[]>;
  isUnchanged(block: LocalBlock): Promise<boolean>;
  canDelete(record: SyncRecord, uid: string, owned?: boolean): Promise<boolean>;
  write(
    uid: string,
    snapshot: CalendarSnapshot,
    previous?: LocalBlock,
    templateRaw?: string,
  ): Promise<LocalBlock>;
  cancel(block: LocalBlock): Promise<void>;
}

export function sameCanonicalSnapshot(
  a: CalendarSnapshot,
  b: CalendarSnapshot,
) {
  return (
    sameSnapshot(a, b) &&
    JSON.stringify(a.tags ?? []) === JSON.stringify(b.tags ?? []) &&
    (a.colorId ?? null) === (b.colorId ?? null) &&
    (a.subtasks ?? "") === (b.subtasks ?? "") &&
    (a.description ?? "") === (b.description ?? "")
  );
}

export function normalizeTitle(title: string) {
  return title
    .replace(/<!--.*?-->/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function snapshotOf(
  event: GoogleEvent,
  untitled = "(Untitled event)",
): CalendarSnapshot | null {
  const start = event.start?.dateTime;
  const end = event.end?.dateTime;
  if (event.status === "cancelled" || !start || !end) return null;
  if (
    !Number.isFinite(Date.parse(start)) ||
    !Number.isFinite(Date.parse(end)) ||
    Date.parse(end) <= Date.parse(start)
  )
    return null;
  // Planner timestamps have minute resolution; never round Google's event silently.
  if (Date.parse(start) % 60_000 !== 0 || Date.parse(end) % 60_000 !== 0)
    return null;
  return {
    title: normalizeTitle(event.summary ?? untitled),
    start: new Date(start).toISOString(),
    end: new Date(end).toISOString(),
  };
}

export function canonicalSnapshotOf(
  event: GoogleEvent,
  base?: CalendarSnapshot,
): CalendarSnapshot | null {
  const snapshot = snapshotOf(event, "");
  if (!snapshot) return null;
  const fields = readStructuredDescription(event.description ?? "");
  let tags = fields?.tags ?? [];
  if (event.extendedProperties?.private?.["dayPlannerTags"]) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(event.extendedProperties.private["dayPlannerTags"]!);
    } catch {
      throw new Error("Google Calendar returned invalid Day Planner tags.");
    }
    if (
      !Array.isArray(parsed) ||
      parsed.some(
        (tag) =>
          typeof tag !== "string" || !/^[\p{L}\p{M}\p{N}_/-]+$/u.test(tag),
      )
    )
      throw new Error("Google Calendar returned invalid Day Planner tags.");
    const metadata = parsed as string[];
    if (!fields) tags = metadata;
    else if (
      base?.tags &&
      JSON.stringify(metadata) !== JSON.stringify(fields.tags)
    ) {
      if (JSON.stringify(fields.tags) === JSON.stringify(base.tags))
        tags = metadata;
      else if (JSON.stringify(metadata) !== JSON.stringify(base.tags))
        throw new Error(
          "Google Calendar tags changed in two different places. Review them before syncing.",
        );
    }
  }
  return {
    ...snapshot,
    tags,
    colorId: event.colorId ?? null,
    subtasks: fields?.subtasks ?? "",
    description: fields?.description ?? event.description ?? "",
  };
}

export function sameSnapshot(a: CalendarSnapshot, b: CalendarSnapshot) {
  return (
    a.title === b.title &&
    Date.parse(a.start) === Date.parse(b.start) &&
    Date.parse(a.end) === Date.parse(b.end)
  );
}
