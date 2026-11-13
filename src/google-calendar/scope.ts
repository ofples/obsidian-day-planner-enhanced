import type { CalendarSnapshot } from "./types";

/** A configured boundary is inclusive and follows the local daily-note date. */
export function isCalendarDateInScope(
  snapshot: CalendarSnapshot,
  startDate: string,
) {
  if (!startDate) return true;
  const boundary = window.moment(startDate, "YYYY-MM-DD", true);
  const date = window.moment(snapshot.start);
  return (
    boundary.isValid() &&
    date.isValid() &&
    date.format("YYYY-MM-DD") >= startDate
  );
}

/** A top-level sync: off/false disables calendar processing for the note. */
export function isCalendarNoteEnabled(text: string) {
  if (!/^---\s*(?:\r?\n)/.test(text)) return true;
  const frontmatter = text.match(
    /^---[ \t]*\r?\n([\s\S]*?)^---[ \t]*(?:\r?\n|$)/m,
  );
  if (!frontmatter) return false;
  return !frontmatter[1]!
    .split(/\r?\n/)
    .some((line) =>
      /^(?:sync|"sync"|'sync')[ \t]*:[ \t]*(?:false|off|"false"|"off"|'false'|'off')[ \t]*(?:#.*)?$/i.test(
        line,
      ),
    );
}
