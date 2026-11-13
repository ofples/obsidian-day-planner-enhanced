import type { Nodes, Paragraph } from "mdast";

import { fromMarkdown } from "../mdast/mdast";
import { protectWikilinks } from "../mdast/wikilink";
import { getTimeRangeMatch } from "../parser/parser";
import type {
  FileWithMetadata,
  IndexService,
} from "../service/index/index-service";
import { exportPlainText } from "../util/schedule-export";
import { isCompleted } from "../util/time-block-utils";

import type { TaskSource } from "./registry";

export interface CaptureTag {
  name: string;
  from: number;
  to: number;
}

export interface CaptureCandidate extends TaskSource {
  insideTimedBlock?: boolean;
  line: number;
  to: number;
  completed: boolean;
  status: string;
  tags: CaptureTag[];
  parentFrom?: number;
  uid?: string;
}

function maskComments(text: string) {
  return text.replace(/%%[\s\S]*?(?:%%|$)/g, (comment) =>
    comment.replace(/[^\r\n]/g, " "),
  );
}

function paragraphTags(
  paragraph: Paragraph,
  text: string,
  firstLineEnd: number,
): CaptureTag[] {
  const tags: CaptureTag[] = [];
  const pending: Nodes[] = [paragraph];
  while (pending.length) {
    const node = pending.pop()!;
    if (node.type === "text") {
      const from = node.position?.start.offset ?? 0;
      const to = Math.min(node.position?.end.offset ?? 0, firstLineEnd);
      const raw = text.slice(from, to);
      for (const match of raw.matchAll(/(^|[\s(])#([\p{L}\p{M}\p{N}_/-]+)/gu)) {
        const offset = from + match.index + match[1]!.length;
        tags.push({
          name: match[2]!,
          from: offset,
          to: offset + match[2]!.length + 1,
        });
      }
    } else if (
      ["paragraph", "strong", "emphasis", "delete"].includes(node.type) &&
      "children" in node
    )
      pending.push(...node.children);
  }
  return tags.toSorted((a, b) => a.from - b.from);
}

export function captureTitle(
  candidate: CaptureCandidate,
  routingTags: Set<string>,
) {
  let line = maskComments(candidate.raw.split(/\r?\n/)[0] ?? "");
  for (const tag of candidate.tags) {
    if (!routingTags.has(tag.name)) continue;
    const from = tag.from - candidate.from;
    const to = tag.to - candidate.from;
    line = line.slice(0, from) + " ".repeat(to - from) + line.slice(to);
  }
  const range = getTimeRangeMatch(line);
  if (range)
    line = line.slice(0, range.startIndex) + line.slice(range.endIndex);
  return exportPlainText(line).replace(/\s+/g, " ").trim();
}

/** The canonical index calls this once per changed document, outside row rendering. */
export function parseCaptureCandidates(
  path: string,
  text: string,
): CaptureCandidate[] {
  const withoutProperties = text.replace(
    /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/,
    (properties) => properties.replace(/[^\r\n]/g, " "),
  );
  const masked = protectWikilinks(maskComments(withoutProperties));
  const result: CaptureCandidate[] = [];
  const pending: {
    node: Nodes;
    parentFrom?: number;
    timedAncestor?: boolean;
  }[] = [{ node: fromMarkdown(masked) }];
  while (pending.length) {
    const { node, parentFrom, timedAncestor } = pending.pop()!;
    let parent = parentFrom;
    let timed = timedAncestor;
    if (node.type === "listItem") {
      const from = node.position?.start.offset;
      const to = node.position?.end.offset;
      const paragraph = node.children[0];
      if (
        from !== undefined &&
        to !== undefined &&
        paragraph?.type === "paragraph"
      ) {
        const raw = text.slice(from, to);
        timed ||= Boolean(getTimeRangeMatch(raw.split(/\r?\n/)[0] ?? ""));
        const status = raw.match(
          /^(?:[-*+]|\d+[.)])\s+\[([^\]])\](?:\s|$)/,
        )?.[1];
        if (status !== undefined) {
          const candidate: CaptureCandidate = {
            path,
            raw,
            from,
            to,
            title: "",
            line: node.position!.start.line - 1,
            completed: isCompleted(status),
            status,
            tags: paragraphTags(
              paragraph,
              masked,
              from + (raw.split(/\r?\n/)[0]?.length ?? 0),
            ),
            parentFrom,
            ...(timedAncestor ? { insideTimedBlock: true } : {}),
          };
          candidate.title = captureTitle(candidate, new Set(["todoist"]));
          result.push(candidate);
          parent = from;
        }
      }
    }
    if ("children" in node)
      for (const child of node.children.toReversed())
        pending.push({ node: child, parentFrom: parent, timedAncestor: timed });
  }
  return result;
}

export class TaskCaptureIndexService implements IndexService {
  index({ path, text }: FileWithMetadata) {
    return { captureEntries: parseCaptureCandidates(path, text) };
  }
}
