export interface CalendarSnapshot {
  title: string;
  start: string;
  end: string;
}

export interface GoogleEvent {
  id: string;
  etag: string;
  status?: string;
  summary?: string;
  colorId?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  recurringEventId?: string;
  eventType?: string;
  description?: string;
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
}

export interface CalendarSyncState {
  version: 1 | 2;
  namespace: string;
  calendarId: string;
  records: Record<string, SyncRecord>;
  identities?: Record<string, LocalIdentity>;
  documents?: Record<string, string>;
  pendingNoteChange?: {
    edits: Array<{ path: string; before: string; after: string }>;
    identities: Record<string, LocalIdentity>;
    documents: Record<string, string>;
  };
  pendingImport?: { uid: string; eventId: string; snapshot: CalendarSnapshot };
  pendingCreate?: { uid: string; path: string; snapshot: CalendarSnapshot };
  pendingMove?: {
    source: LocalBlock;
    targetPath: string;
    raw: string;
    snapshot: CalendarSnapshot;
  };
}

export interface CalendarApi {
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
  scan(): Promise<LocalBlock[]>;
  isUnchanged(block: LocalBlock): Promise<boolean>;
  canDelete(record: SyncRecord, uid: string, owned?: boolean): Promise<boolean>;
  write(
    uid: string,
    snapshot: CalendarSnapshot,
    previous?: LocalBlock,
  ): Promise<LocalBlock>;
  cancel(block: LocalBlock): Promise<void>;
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

export function sameSnapshot(a: CalendarSnapshot, b: CalendarSnapshot) {
  return a.title === b.title && a.start === b.start && a.end === b.end;
}
