import { z } from "zod";

export const githubProjectSelectionSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  url: z.string(),
  statusFieldId: z.string().optional(),
  dateFieldId: z.string().optional(),
});
export const githubSelectionSchema = z.object({
  assigned: z.boolean().default(true),
  repositories: z.array(z.string()).default([]),
  projects: z.array(githubProjectSelectionSchema).default([]),
});
export type GitHubSelection = z.infer<typeof githubSelectionSchema>;
export type GitHubProjectSelection = z.infer<
  typeof githubProjectSelectionSchema
>;

const ownerPattern = /^[a-z\d](?:[a-z\d-]*[a-z\d])?$/i;

export function githubRepository(value: string): string | undefined {
  let path = value.trim();
  if (/^https?:/i.test(path)) {
    try {
      const url = new URL(path);
      if (
        url.origin !== "https://github.com" ||
        url.username ||
        url.password ||
        url.port
      )
        return;
      path = url.pathname.replace(/^\/+|\/+$/g, "");
    } catch {
      return;
    }
  }
  const [owner, repo, extra] = path.split("/");
  if (
    !owner ||
    !repo ||
    extra ||
    !ownerPattern.test(owner) ||
    !/^[\w.-]+$/.test(repo) ||
    [".", ".."].includes(repo)
  )
    return;
  return `${owner}/${repo}`.toLowerCase();
}

export function githubProjectLocation(value: string) {
  try {
    const url = new URL(value.trim());
    if (
      url.origin !== "https://github.com" ||
      url.username ||
      url.password ||
      url.port
    )
      return;
    const match = url.pathname.match(
      /^\/(users|orgs)\/([^/]+)\/projects\/(\d+)\/?$/,
    );
    if (!match || !ownerPattern.test(match[2]!)) return;
    const number = Number(match[3]);
    if (!Number.isSafeInteger(number) || number < 1) return;
    return {
      kind: match[1] === "orgs" ? ("organization" as const) : ("user" as const),
      owner: match[2]!,
      number,
    };
  } catch {
    return;
  }
}
