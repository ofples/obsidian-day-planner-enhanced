import { describe, expect, test } from "vitest";

import { tasksAddedToNote } from "../src/tasks/added-to-note";
import { parseCaptureCandidates } from "../src/tasks/capture-parser";
import type { ImportedTaskSource } from "../src/tasks/plain-import";
import { taskOccurrenceKey } from "../src/tasks/schedule-types";
import type { ProviderTask, TaskSnapshot } from "../src/tasks/types";
import { formatTaskLink } from "../src/tasks/weak-links";

const task = (id: string, parentId: string | null = null): ProviderTask => ({
  id,
  title: id,
  description: "",
  projectId: "project",
  parentId,
  labels: [],
  priority: 1,
  completed: false,
  order: 1,
  due: null,
});
const snapshot = (tasks: ProviderTask[]): TaskSnapshot => ({
  provider: "todoist",
  account: { id: "account", name: "Account", timezone: "UTC" },
  projects: [{ id: "project", name: "Project", order: 1 }],
  tasks,
  fetchedAt: "2026-11-14T00:00:00Z",
});
const path = "Daily.md";
const raw = "- [ ] root\n  - [ ] child";
const source = (
  patch: Partial<ImportedTaskSource> = {},
): ImportedTaskSource => ({
  path,
  raw,
  from: 0,
  title: "root",
  taskIds: ["root", "child"],
  ...patch,
});
const receipt = (root: ProviderTask, value = source()) => ({
  [JSON.stringify(["todoist", "account", root.id, taskOccurrenceKey(root)])]:
    value,
});
const find = (
  tasks: ProviderTask[],
  text: string,
  imports: Record<string, ImportedTaskSource>,
  extra: Partial<Parameters<typeof tasksAddedToNote>[0]> = {},
) =>
  tasksAddedToNote({
    snapshot: snapshot(tasks),
    path,
    candidates: parseCaptureCandidates(path, text),
    imports,
    ...extra,
  });

describe("imported tasks in the current note", () => {
  test("recognizes an explicit root Todoist link without a saved receipt", () => {
    const root = task("root"),
      child = task("child", "root");
    const linked = `- [ ] Root ${formatTaskLink("root")}\n  - [ ] Child ${formatTaskLink("child")}`;
    expect(find([root, child], linked, {})).toEqual(new Set(["root", "child"]));
    expect(find([root, child], "- [ ] Root", {})).toEqual(new Set());
  });

  test("only hides the linked recurring occurrence", () => {
    const root = {
      ...task("root"),
      due: {
        date: "2026-11-14",
        text: "daily",
        timezone: null,
        recurring: true,
      },
      completionCount: 2,
    };
    expect(find([root], `- [ ] Root ${formatTaskLink("root", 2)}`, {})).toEqual(
      new Set(["root"]),
    );
    expect(find([root], `- [ ] Root ${formatTaskLink("root", 1)}`, {})).toEqual(
      new Set(),
    );
  });
  test("verifies each placement independently, and restores visibility for a deleted copy", () => {
    const root = task("root"),
      child = task("child", "root");
    const key = JSON.stringify([
      "todoist",
      "account",
      root.id,
      taskOccurrenceKey(root),
    ]);
    const first = source({ path: "First.md" });
    const second = source({ path: "Second.md" });
    const imports: ReadonlyArray<readonly [string, ImportedTaskSource]> = [
      [key, first],
      [key, second],
      [key, second],
    ];
    const candidates = [
      ...parseCaptureCandidates("First.md", raw),
      ...parseCaptureCandidates("Second.md", raw),
    ];
    for (const path of ["First.md", "Second.md"]) {
      expect(
        tasksAddedToNote({
          snapshot: snapshot([root, child]),
          path,
          candidates,
          imports,
        }),
      ).toEqual(new Set(["root", "child"]));
    }
    expect(
      tasksAddedToNote({
        snapshot: snapshot([root, child]),
        path: "First.md",
        candidates: candidates.filter(
          (candidate) => candidate.path !== "First.md",
        ),
        imports,
      }),
    ).toEqual(new Set());
  });
  test("verifies the root and imported children, leaving newly added provider children visible", () => {
    const root = task("root"),
      child = task("child", "root"),
      newer = task("new", "root");
    expect(find([root, child, newer], raw, receipt(root))).toEqual(
      new Set(["root", "child"]),
    );
  });

  test("ignores receipts for a different account or recurring occurrence", () => {
    const root = task("root"),
      child = task("child", "root");
    const imports = receipt(root);
    expect(
      find([root, child], raw, imports, {
        snapshot: {
          ...snapshot([root, child]),
          account: { ...snapshot([]).account, id: "other" },
        },
      }),
    ).toEqual(new Set());
    const recurring = {
      ...root,
      due: {
        date: "2026-11-14",
        text: "daily",
        timezone: null,
        recurring: true,
      },
      completionCount: 2,
    };
    expect(
      find(
        [recurring, child],
        raw,
        receipt({ ...recurring, completionCount: 1 }),
      ),
    ).toEqual(new Set());
  });

  test("follows a verified stable UID when its source moved into the current note", () => {
    const root = task("root"),
      child = task("child", "root");
    const imports = receipt(root, source({ path: "Old.md", uid: "stable" }));
    expect(
      find([root, child], raw, imports, {
        resolve: () => ({ path, raw, from: 0, title: "root" }),
      }),
    ).toEqual(new Set(["root", "child"]));
    expect(
      find([root, child], "", imports, {
        resolve: () => ({ path: "Other.md", raw, from: 0, title: "root" }),
      }),
    ).toEqual(new Set());
  });

  test("does not hide a task after its source was deleted and an unrelated same-title task remains", () => {
    const root = task("root"),
      child = task("child", "root");
    expect(
      find([root, child], "- [ ] root\n  - [ ] unrelated", receipt(root)),
    ).toEqual(new Set());
  });

  test("legacy receipts avoid guessing among duplicate child names", () => {
    const root = task("root"),
      one = task("child", "root"),
      two = { ...task("other", "root"), title: "child" };
    expect(
      find(
        [root, one, two],
        raw,
        receipt(root, source({ taskIds: undefined })),
      ),
    ).toEqual(new Set(["root"]));
  });
});
