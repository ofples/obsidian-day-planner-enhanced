import type { Nodes } from "mdast";

import { fromMarkdown } from "../mdast/mdast";

import { resolveSourceTask } from "./source-references";
import {
  taskSourceReferenceSchema,
  type TaskSourceReference,
} from "./source-types";
import type { TaskSnapshot } from "./types";
import { canonicalTaskUrl, formatTaskLink } from "./weak-links";

export function canonicalSourceUrl(value: string): string | undefined {
  const todoist = canonicalTaskUrl(value);
  if (todoist) return todoist;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.port)
      return;
    if (url.hostname === "tasks.google.com") return url.href;
    if (url.hostname !== "github.com") return;
    if (
      /^\/[\w-]+\/[\w.-]+\/(issues|pull)\/[1-9]\d*\/?$/.test(url.pathname) ||
      /^\/(users|orgs)\/[\w-]+\/projects\/[1-9]\d*\/?$/.test(url.pathname)
    ) {
      url.search = "";
      url.hash = "";
      url.pathname = url.pathname.replace(/\/$/, "");
      return url.href;
    }
  } catch {
    /* Unrecognized links stay ordinary Markdown. */
  }
}

function referenceHint(title: string | null) {
  if (!title?.startsWith("dp-task-v1:") || title.length > 4000) return;
  try {
    const parsed: unknown = JSON.parse(
      decodeURIComponent(title.slice("dp-task-v1:".length)),
    );
    if (!Array.isArray(parsed) || parsed.length !== 3) return;
    const parts = parsed as unknown[];
    const ref = taskSourceReferenceSchema.safeParse({
      provider: parts[0],
      accountId: parts[1],
      itemId: parts[2],
    });
    return ref.success ? ref.data : undefined;
  } catch {
    return;
  }
}

function sourceLinks(raw: string) {
  const pending: Nodes[] = [fromMarkdown(raw.split(/\r?\n/, 1)[0] ?? "")];
  const links: Array<{
    url: string;
    from: number;
    to: number;
    title: string | null;
  }> = [];
  while (pending.length) {
    const node = pending.pop()!;
    if (node.type === "link") {
      const url = canonicalSourceUrl(node.url);
      const chain =
        node.children.length === 1 &&
        node.children[0]?.type === "text" &&
        node.children[0].value === "🔗";
      if (
        url &&
        node.position &&
        (canonicalTaskUrl(url) || chain || referenceHint(node.title ?? null))
      )
        links.push({
          url,
          from: node.position.start.offset!,
          to: node.position.end.offset!,
          title: node.title ?? null,
        });
    }
    if ("children" in node) pending.push(...node.children);
  }
  return links.sort((a, b) => a.from - b.from);
}

export function sourceLinkIdentity(raw: string) {
  const links = sourceLinks(raw);
  if (links.length === 0 || new Set(links.map((link) => link.url)).size !== 1)
    return;
  const link = links[0]!;
  return {
    url: link.url,
    reference: referenceHint(link.title),
    occurrence: canonicalTaskUrl(link.url)
      ? (link.title ?? "").match(/(?:^|\s)occurrence=([^\s]+)/)?.[1]
      : undefined,
  };
}

export function sourceLinkUrl(raw: string) {
  return sourceLinkIdentity(raw)?.url;
}

export function stripSourceLinks(text: string, onlyUrl?: string) {
  let result = text;
  for (const link of sourceLinks(text).reverse())
    if (!onlyUrl || link.url === onlyUrl)
      result = result.slice(0, link.from) + result.slice(link.to);
  return result.replace(/[ \t]+/g, " ").trim();
}

export function formatSourceUrl(
  value: string,
  occurrence?: string | number,
  reference?: TaskSourceReference,
) {
  const url = canonicalSourceUrl(value);
  if (!url) return "";
  if (canonicalTaskUrl(url)) return formatTaskLink(url, occurrence);
  const hint = reference
    ? ` "dp-task-v1:${encodeURIComponent(JSON.stringify([reference.provider, reference.accountId, reference.itemId]))}"`
    : "";
  return `[🔗](<${url.replace(/[<>]/g, encodeURIComponent)}>${hint})`;
}

/** A native URL is matched only against the active account's cached items. */
export function sourceTaskFromLink(snapshot: TaskSnapshot, raw: string) {
  const link = sourceLinkIdentity(raw);
  if (!link) return null;
  if (link.reference) {
    const provider = link.url.startsWith("https://github.com/")
      ? "github"
      : link.url.startsWith("https://tasks.google.com/")
        ? "google-tasks"
        : "todoist";
    return link.reference.provider === provider
      ? (resolveSourceTask([snapshot], link.reference)?.task ?? null)
      : null;
  }
  if (snapshot.provider === "todoist") return null;
  const matching = snapshot.tasks.filter(
    (task) => canonicalSourceUrl(task.source?.url ?? "") === link.url,
  );
  return matching.length === 1 ? matching[0]! : null;
}
