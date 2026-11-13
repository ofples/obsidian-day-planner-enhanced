import type { List } from "mdast";

import { fromMarkdown } from "../mdast/mdast";
import { getTimeFromLine } from "../parser/parser";

/** Sort complete timed siblings bottom-up, leaving untimed slots intact. */
export function sortPlannerTasks(
  text: string,
  plannerHeading: string,
  selection?: { from: number; to: number },
) {
  const root = fromMarkdown(text);
  let active = !plannerHeading || Boolean(selection);
  let headingDepth = 0;
  const lists: { list: List; depth: number }[] = [];
  for (const node of root.children) {
    if (node.type === "heading" && !selection) {
      const title = node.children
        .map((child) => ("value" in child ? child.value : ""))
        .join("");
      if (title === plannerHeading) {
        active = true;
        headingDepth = node.depth;
      } else if (node.depth <= headingDepth) active = !plannerHeading;
    }
    if (!active || node.type !== "list") continue;
    const pending = [{ list: node, depth: 0 }];
    while (pending.length) {
      const entry = pending.pop()!;
      lists.push(entry);
      for (const item of entry.list.children)
        for (const child of item.children)
          if (child.type === "list")
            pending.push({ list: child, depth: entry.depth + 1 });
    }
  }
  let result = text;
  for (const { list } of lists.sort((a, b) => b.depth - a.depth)) {
    const items = list.children.flatMap((item) => {
      const from = item.position?.start.offset,
        to = item.position?.end.offset;
      if (
        from === undefined ||
        to === undefined ||
        (selection && (from < selection.from || to > selection.to))
      )
        return [];
      const raw = result.slice(from, to);
      const time = getTimeFromLine({
        line: raw.split(/\r?\n/)[0] ?? "",
        day: window.moment().startOf("day"),
      });
      if (!time?.startTime.isValid()) return [];
      return [
        {
          from,
          to,
          raw,
          minutes: time.startTime.hours() * 60 + time.startTime.minutes(),
        },
      ];
    });
    const sorted = [...items].sort((a, b) => a.minutes - b.minutes);
    for (let index = items.length - 1; index >= 0; index--) {
      const item = items[index]!;
      result =
        result.slice(0, item.from) + sorted[index]!.raw + result.slice(item.to);
    }
  }
  return result;
}
