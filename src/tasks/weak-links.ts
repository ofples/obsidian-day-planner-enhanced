import type { Nodes } from "mdast";

import { fromMarkdown } from "../mdast/mdast";

export function canonicalTaskUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      !["app.todoist.com", "todoist.com", "www.todoist.com"].includes(
        url.hostname,
      ) ||
      url.username ||
      url.password ||
      url.port
    )
      return;
    const id =
      url.pathname.match(/^\/app\/task\/([\w-]+)\/?$/)?.[1] ??
      (url.pathname === "/showTask" ? url.searchParams.get("id") : undefined);
    if (id && /^[\w-]+$/.test(id))
      return `https://app.todoist.com/app/task/${id}`;
  } catch {
    /* Other links remain ordinary note content. */
  }
}

function taskLinks(raw: string) {
  const line = raw.split(/\r?\n/, 1)[0] ?? "";
  const pending: Nodes[] = [fromMarkdown(line)];
  const links: Array<{
    url: string;
    from: number;
    to: number;
    title: string | null;
  }> = [];
  while (pending.length) {
    const node = pending.pop()!;
    if (node.type === "link") {
      const url = canonicalTaskUrl(node.url);
      if (url && node.position)
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

export function taskLinkUrl(raw: string) {
  const links = taskLinks(raw);
  return new Set(links.map((link) => link.url)).size === 1
    ? links[0]?.url
    : undefined;
}

export function taskLinkIdentity(raw: string) {
  const url = taskLinkUrl(raw);
  if (!url) return;
  const title = taskLinks(raw)[0]?.title ?? "";
  return {
    url,
    taskId: url.split("/").pop()!,
    occurrence: title.match(/(?:^|\s)occurrence=([^\s]+)/)?.[1],
  };
}

export function stripTaskLink(text: string) {
  let result = text;
  for (const link of taskLinks(text).reverse())
    result = result.slice(0, link.from) + result.slice(link.to);
  return result.replace(/[ \t]+/g, " ").trim();
}

export function formatTaskLink(idOrUrl: string, occurrence?: string | number) {
  const url =
    canonicalTaskUrl(idOrUrl) ??
    (/^[\w-]+$/.test(idOrUrl)
      ? `https://app.todoist.com/app/task/${idOrUrl}`
      : undefined);
  if (!url) return "";
  const title =
    occurrence === undefined
      ? ""
      : ` "Todoist occurrence=${String(occurrence).replace(/[^\w:.,+\-TZ]/g, "")}"`;
  return `[🔗](${url}${title})`;
}
