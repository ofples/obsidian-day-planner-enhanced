import { taskSubtree } from "./browser";
import { parseCaptureCandidates } from "./capture-parser";
import { taskAccountKey, type TaskCaptureSettings } from "./capture-settings";
import { withoutTaskCaptureTag } from "./reconcile-markdown";
import { newTaskMarkdown, taskInlineMarkdown } from "./schedule-markdown";
import { taskOccurrenceKey } from "./schedule-types";
import {
  canonicalSourceUrl,
  formatSourceUrl,
  stripSourceLinks,
} from "./source-links";
import { taskSourceReference } from "./source-references";
import { TaskReadError, type TaskSnapshot } from "./types";
import { formatTaskLink } from "./weak-links";

export function serializeSourceTask(
  snapshot: TaskSnapshot,
  taskId: string,
  settings: TaskCaptureSettings,
) {
  const task = snapshot.tasks.find(
    (item) => item.id === taskId && !item.completed,
  );
  if (!task)
    throw new TaskReadError(
      "This cached task is unavailable. Refresh its source.",
    );
  const children = snapshot.tasks.some((item) => item.parentId === task.id)
    ? taskSubtree(snapshot, task)
    : [];
  const ref = taskSourceReference(snapshot, task);
  const todoist = snapshot.provider === "todoist";
  const accountKey = taskAccountKey(snapshot);
  const importSettings =
    !todoist && !settings.accounts[accountKey]
      ? {
          ...settings,
          accounts: {
            ...settings.accounts,
            [accountKey]: {
              defaultProjectId: "",
              projectMappings: {},
              labelMappings: {},
            },
          },
        }
      : settings;
  const url = todoist
    ? `https://app.todoist.com/app/task/${task.id}`
    : canonicalSourceUrl(task.source?.url ?? "");
  const lines = withoutTaskCaptureTag(
    newTaskMarkdown(
      {
        ...task,
        title: stripSourceLinks(task.title.replace(/[\r\n]+/g, " "), url),
      },
      children,
      snapshot,
      importSettings,
    ),
  ).split("\n");
  let link = "";
  if (todoist)
    link = formatTaskLink(
      task.id,
      task.due?.recurring ? (task.completionCount ?? task.due.date) : undefined,
    );
  else if (url)
    link = formatSourceUrl(
      url,
      undefined,
      task.source?.kind === "draft" ? ref : undefined,
    );
  else if (snapshot.provider === "google-tasks")
    link = formatSourceUrl("https://tasks.google.com/", undefined, ref);
  if (link) lines[0] += ` ${link}`;
  if (task.description.trim())
    lines.splice(
      1,
      0,
      ...task.description.split(/\r?\n/).map((line) => `  ${line}`),
    );
  if (!todoist) {
    lines.splice(
      1 +
        (task.description.trim() ? task.description.split(/\r?\n/).length : 0),
    );
    for (const child of children) {
      lines.push(
        `${"  ".repeat(child.depth)}- [ ] ${taskInlineMarkdown(child.task.title)}`,
      );
      if (child.task.description.trim())
        lines.push(
          ...child.task.description
            .split(/\r?\n/)
            .map((line) => `${"  ".repeat(child.depth + 1)}${line}`),
        );
    }
  }
  let raw = lines.join("\n");
  if (!todoist) {
    // External checklists are content, not an opt-in to create tasks on another service.
    const directives = parseCaptureCandidates("", raw)
      .flatMap((candidate) => candidate.tags)
      .filter((tag) => tag.name.toLowerCase() === "todoist")
      .toSorted((a, b) => b.from - a.from);
    for (const tag of directives)
      raw =
        raw.slice(0, tag.from) +
        "`" +
        raw.slice(tag.from, tag.to) +
        "`" +
        raw.slice(tag.to);
  }
  return {
    task,
    raw,
    key: JSON.stringify([
      snapshot.provider,
      snapshot.account.id,
      task.id,
      taskOccurrenceKey(task),
    ]),
    taskIds: [task.id, ...children.map((row) => row.task.id)],
  };
}
