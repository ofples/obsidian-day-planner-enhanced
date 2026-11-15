import { parseCaptureCandidates } from "./capture-parser";

function tags(text: string) {
  const first = text.split(/\r?\n/, 1)[0] ?? "";
  const line = `- [ ] ${first.replace(/^\s*(?:[-*+]|\d+[.)])\s+(?:\[[^\]]\]\s*)?/, "")}`;
  return (parseCaptureCandidates("", line)[0]?.tags ?? []).map((tag) =>
    tag.name.toLowerCase(),
  );
}
const controlTags = new Set(["frame", "locked", "todoist"]);

export function frameDropWarning(
  parent: string,
  child: string,
): string | undefined {
  if (!parent.toLowerCase().includes("#frame")) return;
  const labels = tags(parent);
  if (!labels.includes("frame")) return;
  const expected = labels.filter((label) => !controlTags.has(label));
  if (
    !expected.length ||
    expected.every((label) => tags(child).includes(label))
  )
    return;
  return `This frame expects ${expected.map((label) => `#${label}`).join(" and ")}. The added task does not match the frame labels.`;
}

export function frameState(block: {
  text: string;
  children?: Array<{ text: string }>;
}) {
  const frame =
    block.text.toLowerCase().includes("#frame") &&
    tags(block.text).includes("frame");
  const empty = frame && !block.children?.length;
  const mismatch =
    frame &&
    block.children?.some((child) =>
      Boolean(frameDropWarning(block.text, child.text)),
    );
  return {
    frame,
    empty,
    warning: empty
      ? "Add tasks to this frame"
      : mismatch
        ? "Some tasks do not match this frame’s labels"
        : "",
  };
}
