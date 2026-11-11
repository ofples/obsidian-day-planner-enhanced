import chroma from "chroma-js";

import type { DayPlannerSettings } from "../settings";

import type { CalendarSnapshot } from "./types";

export type EventColors = Record<string, { background: string }>;

export const eventColorOptions: Record<string, string> = {
  "": "Automatic match",
  default: "Calendar default",
  "1": "Lavender",
  "2": "Sage",
  "3": "Grape",
  "4": "Flamingo",
  "5": "Banana",
  "6": "Tangerine",
  "7": "Peacock",
  "8": "Graphite",
  "9": "Blueberry",
  "10": "Basil",
  "11": "Tomato",
};

/** Google exposes a fixed event palette. Use light-mode colors as the stable
 * reference so switching the Obsidian theme does not recolor the calendar. */
export function plannerEventColor(
  snapshot: CalendarSnapshot,
  settings: DayPlannerSettings,
  palette: EventColors,
): string | null {
  const override = settings.colorOverrides.find((entry) =>
    snapshot.title.includes(entry.text),
  );
  const mapped = override
    ? settings.googleCalendar.colorMappings[override.text]
    : settings.googleCalendar.fallbackColorId;
  if (mapped === "default") return null;
  if (mapped && palette[mapped]) return mapped;
  let color = override?.color;
  if (!override && settings.timelineColored) {
    const hour = new Date(snapshot.start).getHours();
    color = chroma
      .scale([settings.timelineStartColor, settings.timelineEndColor])
      .mode("lab")((hour - settings.startHour) / (24 - settings.startHour))
      .hex();
  }
  if (!color || !chroma.valid(color)) return null;
  let closest: string | null = null;
  let distance = Infinity;
  for (const [id, entry] of Object.entries(palette)) {
    if (!chroma.valid(entry.background)) continue;
    const difference = chroma.deltaE(color, entry.background);
    if (difference < distance) {
      closest = id;
      distance = difference;
    }
  }
  return closest;
}
