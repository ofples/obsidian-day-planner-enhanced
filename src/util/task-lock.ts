import { parseCaptureCandidates } from "../tasks/capture-parser";

/** Hide only actual #locked tags from rendered text; source Markdown stays intact. */
export function withoutDisplayedLockTags(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      if (!/#locked/i.test(line)) return line;
      const prefix = "- [ ] ";
      const tags =
        parseCaptureCandidates("", prefix + line)[0]?.tags.filter(
          (tag) => tag.name.toLowerCase() === "locked",
        ) ?? [];
      let result = line;
      for (const tag of tags.toReversed()) {
        const start = tag.from - prefix.length,
          end = tag.to - prefix.length;
        result =
          result.slice(
            0,
            start > 0 && result[start - 1] === " " ? start - 1 : start,
          ) + result.slice(end);
      }
      return result;
    })
    .join("\n");
}

/** Only a real tag on the block's first line locks that block. */
export function hasTaskLock(text: string): boolean {
  const first = text.split(/\r?\n/, 1)[0] ?? "";
  if (!/#locked/i.test(first)) return false;
  return Boolean(
    parseCaptureCandidates("", `- [ ] ${first}`)[0]?.tags.some(
      (tag) => tag.name.toLowerCase() === "locked",
    ),
  );
}

export function isLocked(block: { text: string }): boolean {
  return hasTaskLock(block.text);
}

/** Moving a parent also moves its nested Markdown tasks. */
export function containsLockedTask(block: {
  text: string;
  children?: Array<{ text: string; children?: unknown[] }>;
}): boolean {
  const pending: Array<{ text: string; children?: unknown[] }> = [block];
  while (pending.length) {
    const current = pending.pop()!;
    if (isLocked(current)) return true;
    for (const child of current.children ?? [])
      if (
        child &&
        typeof child === "object" &&
        "text" in child &&
        typeof child.text === "string"
      )
        pending.push(child as { text: string; children?: unknown[] });
  }
  return false;
}
