import { removeTimeRangeFromLine } from "../parser/parser";
import type { TimelineTimeBlock } from "../time-block-types";
import { getRenderKey } from "../util/time-block-utils";

type Row<T> = { block: T; key: string };
const content = (block: TimelineTimeBlock) => {
  const [first = "", ...body] = (
    block.source === "ical" ? block.summary : block.text
  ).split(/\r?\n/);
  return [removeTimeRangeFromLine(first).trim(), ...body].join("\n");
};
const path = (block: TimelineTimeBlock) =>
  block.source === "unwritten"
    ? (block.previewPath ?? "")
    : "path" in block
      ? block.path
      : "";
const time = (block: TimelineTimeBlock) => [
  block.startTime.valueOf(),
  "durationMinutes" in block ? block.durationMinutes : null,
];

/** View-local keys survive source-line shifts and optimistic/index handoffs.
 * These keys never participate in note identity or Calendar reconciliation.
 */
export class TimelineRenderKeys<T extends TimelineTimeBlock> {
  private rows: Row<T>[] = [];
  private sequence = 0;
  project(blocks: T[]): Row<T>[] {
    const available = new Set(
      this.rows.filter((row) => row.block.source !== "ical"),
    );
    const assigned = new Map<number, string>();
    const local = blocks
      .map((block, index) => ({ block, index }))
      .filter((row) => row.block.source !== "ical");
    const matchers = [
      (block: TimelineTimeBlock) =>
        JSON.stringify([path(block), content(block), time(block)]),
      (block: TimelineTimeBlock) =>
        JSON.stringify([path(block), content(block)]),
      (block: TimelineTimeBlock) => JSON.stringify([path(block), time(block)]),
      (block: TimelineTimeBlock) => JSON.stringify([block.source, block.id]),
    ];
    for (const identity of matchers) {
      const old = new Map<string, Row<T>[]>();
      for (const row of available) {
        const key = identity(row.block),
          queue = old.get(key) ?? [];
        queue.push(row);
        old.set(key, queue);
      }
      for (const { block, index } of local) {
        if (assigned.has(index)) continue;
        const row = old.get(identity(block))?.shift();
        if (row) {
          assigned.set(index, row.key);
          available.delete(row);
        }
      }
    }
    this.rows = blocks.map((block, index) => ({
      block,
      key:
        block.source === "ical"
          ? `remote:${getRenderKey(block)}`
          : (assigned.get(index) ?? `local:${++this.sequence}`),
    }));
    return this.rows;
  }
}
