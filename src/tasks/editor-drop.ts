import { diffChars } from "diff";
import type { Editor } from "obsidian";

/** Resolve the release point before Obsidian updates the editor selection. */
export function taskDropOffset(
  editor: Editor,
  event: Pick<MouseEvent, "clientX" | "clientY">,
) {
  const view = Reflect.get(editor, "cm") as
    | {
        posAtCoords?: (point: { x: number; y: number }) => number | null;
      }
    | undefined;
  return (
    view?.posAtCoords?.({ x: event.clientX, y: event.clientY }) ??
    editor.posToOffset(editor.getCursor())
  );
}

/** Keep a queued insertion at its original location as earlier edits shift text. */
export function rebaseDropOffset(
  before: string,
  after: string,
  offset: number,
) {
  let oldPosition = 0;
  let newPosition = 0;
  for (const change of diffChars(before, after)) {
    if (change.added) {
      newPosition += change.value.length;
      continue;
    }
    const end = oldPosition + change.value.length;
    if (offset < end)
      return change.removed ? newPosition : newPosition + offset - oldPosition;
    oldPosition = end;
    if (!change.removed) newPosition += change.value.length;
  }
  return newPosition;
}
