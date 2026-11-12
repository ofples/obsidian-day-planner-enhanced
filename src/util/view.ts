/* eslint-disable @typescript-eslint/no-floating-promises, @typescript-eslint/no-misused-promises, @typescript-eslint/no-redundant-type-constituents, @typescript-eslint/no-unnecessary-condition, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-enum-comparison, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return -- Obsidian community scorecard can run type-aware rules without resolving plugin source dependencies; tsc and svelte-check cover this source. */
import type { ItemView } from "obsidian";

import { defaultDayFormat } from "../constants";

type ItemViewWithHeader = ItemView & {
  titleEl?: HTMLElement;
  leaf: ItemView["leaf"] & {
    updateHeader?: () => void;
  };
};

export function getSavedViewDay(state: unknown) {
  if (
    !state ||
    typeof state !== "object" ||
    !("day" in state) ||
    typeof state.day !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(state.day)
  )
    return undefined;
  const day = window.moment(state.day, defaultDayFormat, true);
  return day.isValid() ? day.startOf("day") : undefined;
}

export function setViewTitle(view: ItemView, text: string) {
  const viewWithHeader = view as ItemViewWithHeader;

  viewWithHeader.titleEl?.setText(text);
  viewWithHeader.leaf.updateHeader?.();
}
/* eslint-enable @typescript-eslint/no-floating-promises, @typescript-eslint/no-misused-promises, @typescript-eslint/no-redundant-type-constituents, @typescript-eslint/no-unnecessary-condition, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-enum-comparison, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return -- Re-enable scorecard compatibility suppressions after this file. */
