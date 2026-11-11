import type { GoogleEvent } from "./types";

/** Structured source metadata identifies the exporter independently of calendar and task titles. */
export function isTodoistCalendarExport(
  event: Pick<GoogleEvent, "status" | "source">,
) {
  if (event.status === "cancelled" || !event.source?.url) return false;
  try {
    const source = new URL(event.source.url);
    if (
      !["http:", "https:"].includes(source.protocol) ||
      !["todoist.com", "www.todoist.com", "app.todoist.com"].includes(
        source.hostname,
      ) ||
      source.username ||
      source.password ||
      source.port
    )
      return false;
    return (
      /^\/app\/task\/[\w-]+\/?$/.test(source.pathname) ||
      (source.pathname === "/showTask" &&
        Boolean(source.searchParams.get("id")))
    );
  } catch {
    return false;
  }
}
