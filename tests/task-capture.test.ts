import { get } from "svelte/store";
import { describe, expect, test, vi } from "vitest";

import { TaskCapture, routeCapture } from "../src/tasks/capture";
import {
  parseCaptureCandidates,
  captureTitle,
} from "../src/tasks/capture-parser";
import {
  taskAccountKey,
  taskAccountSettings,
  taskCaptureSettingsSchema,
} from "../src/tasks/capture-settings";
import { TaskService } from "../src/tasks/service";
import type { TaskOperation } from "../src/tasks/operations";
import type { ProviderTask, TaskSnapshot } from "../src/tasks/types";

const snapshot: TaskSnapshot = {
  provider: "todoist",
  account: { id: "account", name: "Test", timezone: "UTC" },
  projects: [
    { id: "inbox", name: "Inbox", order: 0, inbox: true },
    { id: "work", name: "Work", order: 1 },
    { id: "karma", name: "Karma", order: 2 },
  ],
  tasks: [],
  fetchedAt: "2026-11-11T00:00:00Z",
};

async function setup(initial = "- [ ] Buy rice #todoist #karma") {
  let cache: string | null = null,
    state: string | null = null,
    secret = "";
  let text = initial;
  let stable = true,
    ready = true;
  const remote = new Map<string, ProviderTask>();
  const apply = vi.fn(async (operation: TaskOperation) => {
    if (operation.mutation.kind !== "create")
      throw new Error("Unexpected mutation");
    const id = operation.id;
    remote.set(id, {
      ...operation.mutation.task,
      id,
      order: remote.size,
      completed: false,
    });
    return { taskId: id };
  });
  const storage = {
    read: async () => cache,
    write: async (value: string) => {
      cache = value;
    },
    readState: async () => state,
    writeState: async (value: string) => {
      state = value;
    },
    getSecret: () => secret,
    setSecret: (_key: string, value: string) => {
      secret = value;
    },
  };
  const provider = () => ({
    read: async () => ({
      ...structuredClone(snapshot),
      tasks: [...remote.values()],
    }),
    apply,
  });
  const service = new TaskService(storage, provider);
  await service.initialize();
  await service.connect("token");
  const host = {
    candidates: () => parseCaptureCandidates("Tasks.md", text),
    read: async () => text,
    stable: () => stable,
    ready: () => ready,
    settings: () => taskCaptureSettingsSchema.parse({}),
  };
  return {
    service,
    host,
    storage,
    provider,
    apply,
    capture: new TaskCapture(service, host),
    setText: (value: string) => {
      text = value;
    },
    setStable: (value: boolean) => {
      stable = value;
    },
    setReady: (value: boolean) => {
      ready = value;
    },
  };
}

describe("tagged task capture", () => {
  test("two missing clock variants reserve a moved block for identity review", async () => {
    const h = await setup("- [ ] 09:00 - 10:00 Work #todoist");
    await h.capture.scan();
    await h.service.refresh();
    await vi.waitUntil(() => get(h.service.state).operations.length === 0);
    const [uid, link] = Object.entries(h.service.registry.snapshot().links)[0]!;
    await h.service.registry.change((state) => {
      delete state.links[uid];
      for (const [key, path, raw] of [
        [uid, "Tasks.md", link.source.raw],
        [
          "other-missing",
          "Other.md",
          link.source.raw.replace("09:00 - 10:00", "11:00 - 12:00"),
        ],
      ] as const)
        state.detached[key] = {
          reason: "missing",
          link: { ...link, source: { ...link.source, path, raw } },
          operationId: crypto.randomUUID(),
          detachedAt: snapshot.fetchedAt,
        };
    });
    const moved = "- [ ] 10:00 - 11:00 Work #todoist";
    h.host.candidates = () => parseCaptureCandidates("Moved.md", moved);
    h.host.read = async () => moved;
    await h.capture.scan();
    expect(h.apply).toHaveBeenCalledTimes(1);
    expect(h.service.registry.snapshot().links).toEqual({});
    expect(get(h.capture.state).identityIssues[0]?.uids).toEqual(
      expect.arrayContaining([uid, "other-missing"]),
    );
    h.capture.stop();
    h.service.stop();
  });

  test("a native edit invalidates a missing-source inventory read", async () => {
    const h = await setup();
    await h.capture.scan();
    await h.service.refresh();
    await vi.waitUntil(() => get(h.service.state).operations.length === 0);
    let revision = 0;
    const host = { ...h.host, revision: () => revision };
    const capture = new TaskCapture(h.service, host);
    h.setText("");
    host.read = async () => {
      revision++;
      return "";
    };
    await expect(capture.inspectCurrentIdentities()).rejects.toThrow(
      "notes changed",
    );
    expect(Object.keys(h.service.registry.snapshot().links)).toHaveLength(1);
    capture.stop();
    h.capture.stop();
    h.service.stop();
  });

  test.each([false, true])(
    "a cross-note clock move keeps the same parent and child tasks after missing detachment %s",
    async (detached) => {
      const original =
        "- [ ] 09:00 - 10:00 Work #todoist\n  - [ ] Same #todoist\n  - [ ] Same #todoist";
      const moved =
        "- [ ] 10:00 - 11:00 Work #todoist\n    - [ ] Same #todoist\n    - [ ] Same #todoist";
      const h = await setup(original);
      let path = "Tasks.md";
      let text = original;
      h.host.candidates = () => parseCaptureCandidates(path, text);
      h.host.read = async () => text;
      await h.capture.scan();
      await h.service.refresh();
      await h.capture.scan();
      await h.service.refresh();
      await vi.waitUntil(() => get(h.service.state).operations.length === 0);
      await h.service.refresh();
      const links = h.service.registry.snapshot().links;
      expect(Object.keys(links)).toHaveLength(3);
      if (detached)
        await h.service.registry.change((state) => {
          for (const [uid, link] of Object.entries(state.links)) {
            state.detached[uid] = {
              reason: "missing",
              link,
              operationId: crypto.randomUUID(),
              detachedAt: snapshot.fetchedAt,
            };
            delete state.links[uid];
          }
        });
      path = "Moved.md";
      text = moved;
      const candidates = h.capture.inspectIdentities().candidates;
      expect(candidates.map((candidate) => candidate.uid)).toEqual(
        Object.keys(links),
      );
      await h.capture.scan();
      await h.service.refresh();
      expect(h.apply).toHaveBeenCalledTimes(3);
      const restored = h.service.registry.snapshot().links;
      expect(Object.keys(restored)).toEqual(Object.keys(links));
      for (const [uid, link] of Object.entries(links))
        expect(restored[uid]?.taskId).toBe(link.taskId);
      expect(get(h.capture.state).issues).toEqual([]);
      h.capture.stop();
      h.service.stop();
    },
  );

  test("a re-opted source matching two retired identities stays ambiguous without creating a task", async () => {
    const h = await setup();
    await h.capture.scan();
    await h.service.refresh();
    const [uid, link] = Object.entries(h.service.registry.snapshot().links)[0]!;
    const occurrenceId = crypto.randomUUID();
    await h.service.registry.change((state) => {
      delete state.links[uid];
      for (const key of [uid, "second-retired"])
        state.detached[key] = {
          reason: "retired",
          occurrenceId,
          link,
          operationId: crypto.randomUUID(),
          detachedAt: snapshot.fetchedAt,
        };
    });
    const commands = h.apply.mock.calls.length;
    await h.capture.scan();
    expect(h.apply).toHaveBeenCalledTimes(commands);
    expect(Object.keys(h.service.registry.snapshot().links)).toEqual([]);
    const inspection = await h.capture.inspectCurrentIdentities();
    expect(inspection.identityIssues[0]?.uids).toEqual(
      expect.arrayContaining([uid, "second-retired"]),
    );
    expect(get(h.capture.state).issues).toHaveLength(1);
    h.service.stop();
  });

  test.each(["capture-disabled", "other-account", "already-linked"])(
    "restoration respects %s and never creates a replacement task",
    async (mode) => {
      const h = await setup();
      await h.capture.scan();
      await h.service.refresh();
      await vi.waitUntil(() => get(h.service.state).operations.length === 0);
      const [uid, link] = Object.entries(
        h.service.registry.snapshot().links,
      )[0]!;
      const extra = "- [ ] Another reference #todoist";
      await h.service.registry.change((state) => {
        state.detached[uid] = {
          reason: "missing",
          link,
          operationId: crypto.randomUUID(),
          detachedAt: new Date().toISOString(),
        };
        delete state.links[uid];
        if (mode === "already-linked")
          state.links.other = {
            ...link,
            source: parseCaptureCandidates("Other.md", extra)[0]!,
          };
      });
      if (mode === "other-account")
        h.service.state.update((state) => ({
          ...state,
          snapshot: {
            ...state.snapshot!,
            account: { ...state.snapshot!.account, id: "other" },
          },
        }));
      const capture = new TaskCapture(h.service, {
        ...h.host,
        candidates: () => [
          ...h.host.candidates(),
          ...(mode === "already-linked"
            ? parseCaptureCandidates("Other.md", extra)
            : []),
        ],
        read: async (path) => (path === "Other.md" ? extra : link.source.raw),
        settings: () =>
          taskCaptureSettingsSchema.parse({
            enabled: mode !== "capture-disabled",
          }),
      });
      await capture.scan();
      expect(h.apply).toHaveBeenCalledTimes(1);
      if (mode === "capture-disabled")
        expect(h.service.registry.snapshot().links[uid]?.taskId).toBe(
          link.taskId,
        );
      else {
        expect(h.service.registry.snapshot().links[uid]).toBeUndefined();
        expect(get(capture.state).issues[0]?.kind).toBe("identity");
      }
      h.service.stop();
    },
  );
  test("a moved source is read across current note paths before a stale index can capture it twice", async () => {
    const h = await setup();
    await h.capture.scan();
    await h.service.refresh();
    await vi.waitUntil(() => get(h.service.state).operations.length === 0);
    const [uid, link] = Object.entries(h.service.registry.snapshot().links)[0]!;
    const capture = new TaskCapture(h.service, {
      ...h.host,
      candidates: () => [],
      paths: () => ["Tasks.md", "Moved.md"],
      read: async (path) => (path === "Moved.md" ? link.source.raw : ""),
    });
    await capture.scan();
    expect(h.service.registry.snapshot().links[uid]?.source.path).toBe(
      "Moved.md",
    );
    expect(h.apply).toHaveBeenCalledTimes(1);
    expect(get(capture.state).error).toBe("");
    h.service.stop();
  });

  test("an unavailable note prevents missing-source proof while preserving known readable links", async () => {
    const h = await setup("- [ ] First #todoist\n- [ ] Second #todoist");
    await h.capture.scan();
    await h.service.refresh();
    await vi.waitUntil(() => get(h.service.state).operations.length === 0);
    const original = h.service.registry.snapshot().links;
    const first = Object.entries(original).find(([, link]) =>
      link.source.title.startsWith("First"),
    )!;
    const second = Object.entries(original).find(([, link]) =>
      link.source.title.startsWith("Second"),
    )!;
    const capture = new TaskCapture(h.service, {
      ...h.host,
      candidates: () => [],
      paths: () => ["Tasks.md", "Unavailable.md"],
      read: async (path) => {
        if (path === "Unavailable.md") throw Error("note unavailable");
        return first[1].source.raw + "\n\n- [ ] New #todoist";
      },
    });
    await capture.scan();
    const inspection = await capture.inspectCurrentIdentities();
    expect(inspection.candidates.map((candidate) => candidate.uid)).toEqual([
      first[0],
    ]);
    expect(await capture.missingSource(second[0], inspection)).toBeNull();
    expect(h.service.registry.snapshot().links).toEqual(original);
    expect(h.apply).toHaveBeenCalledTimes(2);
    h.service.stop();
  });

  test("two archived identical links produce one review item and no new provider task", async () => {
    const h = await setup("- [ ] Same #todoist\n- [ ] Same #todoist");
    await h.capture.scan();
    await h.service.refresh();
    await vi.waitUntil(() => get(h.service.state).operations.length === 0);
    await h.service.registry.change((state) => {
      for (const [uid, link] of Object.entries(state.links)) {
        state.detached[uid] = {
          reason: "missing",
          link,
          operationId: crypto.randomUUID(),
          detachedAt: new Date().toISOString(),
        };
        delete state.links[uid];
      }
    });
    h.setText("- [ ] Same #todoist");
    await h.capture.scan();
    expect(get(h.capture.state).issues).toHaveLength(1);
    expect(get(h.capture.state).issues[0]?.kind).toBe("identity");
    expect(h.service.registry.snapshot().links).toEqual({});
    expect(h.apply).toHaveBeenCalledTimes(2);
    h.service.stop();
  });

  test("identical tasks captured together retain distinct identities without a copy warning", async () => {
    const h = await setup("- [ ] Same #todoist\n- [ ] Same #todoist");
    await h.capture.scan();
    await h.service.refresh();
    await h.capture.scan();
    await h.service.refresh();
    expect(Object.keys(h.service.registry.snapshot().links)).toHaveLength(2);
    expect(
      new Set(
        Object.values(h.service.registry.snapshot().links).map(
          (link) => link.taskId,
        ),
      ).size,
    ).toBe(2);
    expect(get(h.capture.state).identityIssues).toEqual([]);
    expect(h.capture.candidates()).toHaveLength(2);
    h.service.stop();
  });

  test("copying an existing task to another note reserves both sources for a link decision", async () => {
    const h = await setup();
    await h.capture.scan();
    await h.service.refresh();
    const links = h.service.registry.snapshot().links;
    const copied = h.host.candidates()[0]!.raw;
    const unrelated = "- [ ] Independent #todoist";
    const capture = new TaskCapture(h.service, {
      ...h.host,
      candidates: () => [
        ...h.host.candidates(),
        ...parseCaptureCandidates("Copy.md", copied),
        ...parseCaptureCandidates("Other.md", unrelated),
      ],
      read: async (path) =>
        path === "Copy.md"
          ? copied
          : path === "Other.md"
            ? unrelated
            : h.host.read(),
    });
    await capture.scan();
    await h.service.refresh();
    expect(h.apply).toHaveBeenCalledTimes(2);
    expect(get(capture.state).identityIssues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          uids: Object.keys(links),
          copies: expect.arrayContaining([
            expect.objectContaining({ path: "Tasks.md" }),
            expect.objectContaining({ path: "Copy.md" }),
          ]),
        }),
      ]),
    );
    expect(capture.candidates().map((candidate) => candidate.path)).toEqual([
      "Other.md",
    ]);
    for (const [uid, link] of Object.entries(links))
      expect(h.service.registry.snapshot().links[uid]).toEqual(link);
    expect(get(capture.state).issues[0]?.message).toContain("copy");
    capture.stop();
    h.service.stop();
  });

  test("copying a linked parent reserves its nested identities without capturing duplicate children", async () => {
    const h = await setup("- [ ] Parent #todoist\n  - [ ] Child #todoist");
    await h.capture.scan();
    await h.service.refresh();
    await h.capture.scan();
    await h.service.refresh();
    const links = h.service.registry.snapshot().links;
    const raw = h.host.candidates()[0]!.raw;
    h.setText(raw + "\n\n" + raw);
    await h.capture.scan();
    await h.service.refresh();
    expect(h.apply).toHaveBeenCalledTimes(2);
    expect(h.capture.candidates()).toEqual([]);
    expect(get(h.capture.state).identityIssues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          uids: expect.arrayContaining(Object.keys(links)),
          copies: expect.any(Array),
        }),
      ]),
    );
    expect(h.service.registry.snapshot().links).toEqual(links);
    h.service.stop();
  });

  test("a deleted identical tree cannot reserve the surviving parent's proven nested source", async () => {
    const raw = "- [ ] Parent #todoist #karma\n  - [ ] Same child";
    const h = await setup(raw);
    await h.capture.scan();
    await h.service.refresh();
    const [uid, link] = Object.entries(h.service.registry.snapshot().links)[0]!;
    const child = parseCaptureCandidates("Tasks.md", raw)[1]!,
      childTask = {
        ...link.base!,
        id: "surviving-child",
        title: "Same child",
        parentId: link.taskId,
      };
    await h.service.registry.change((state) => {
      state.links.child = {
        ...link,
        taskId: childTask.id,
        base: childTask,
        source: child,
      };
      const deletedRoot = {
        ...link,
        taskId: "deleted-parent",
        base: { ...link.base!, id: "deleted-parent" },
        source: { ...link.source, path: "Removed.md" },
      };
      const deletedChild = {
        ...link,
        taskId: "deleted-child",
        base: { ...childTask, id: "deleted-child", parentId: "deleted-parent" },
        source: { ...child, path: "Removed.md" },
      };
      for (const [key, saved] of [
        ["old-root", deletedRoot],
        ["old-child", deletedChild],
      ] as const)
        state.detached[key] = {
          reason: "deleted",
          deletionId: crypto.randomUUID(),
          operationId: crypto.randomUUID(),
          link: saved,
          detachedAt: snapshot.fetchedAt,
        };
    });
    const local = raw.replace(" #todoist", "");
    const capture = new TaskCapture(h.service, {
      ...h.host,
      candidates: () => [
        ...h.host.candidates(),
        ...parseCaptureCandidates("Removed.md", local),
      ],
      paths: () => ["Tasks.md", "Removed.md"],
      read: async (path) => (path === "Removed.md" ? local : h.host.read()),
    });
    await capture.scan();
    expect(get(capture.state).issues).toEqual([]);
    expect(
      capture.candidates().find((source) => source.uid === uid)?.path,
    ).toBe("Tasks.md");
    expect(
      capture.candidates().find((source) => source.uid === "child")?.path,
    ).toBe("Tasks.md");
    expect(h.service.registry.snapshot().links.child?.taskId).toBe(
      "surviving-child",
    );
    expect(h.apply).toHaveBeenCalledOnce();
    capture.stop();
    h.service.stop();
  });

  test("ambiguous note edits preserve links and allow capture in another note", async () => {
    const h = await setup("- [ ] First #todoist\n- [ ] Second #todoist");
    await h.capture.scan();
    await h.service.refresh();
    await vi.waitUntil(() => get(h.service.state).operations.length === 0);
    const originalLinks = h.service.registry.snapshot().links;
    expect(Object.keys(originalLinks)).toHaveLength(2);
    h.setText("- [ ] Renamed first #todoist\n- [ ] Renamed second #todoist");
    const extra = "- [ ] Independent #todoist";
    const capture = new TaskCapture(h.service, {
      ...h.host,
      candidates: () => [
        ...h.host.candidates(),
        ...parseCaptureCandidates("Other.md", extra),
      ],
      read: async (path) => (path === "Other.md" ? extra : h.host.read()),
    });
    await capture.scan();
    await h.service.refresh();
    await vi.waitUntil(() => get(h.service.state).operations.length === 0);
    expect(h.apply).toHaveBeenCalledTimes(3);
    expect(get(capture.state).error).toBe("");
    expect(get(capture.state).identityIssues).toEqual([
      {
        path: "Tasks.md",
        uids: Object.keys(originalLinks),
        message: expect.any(String),
      },
    ]);
    for (const [uid, link] of Object.entries(originalLinks))
      expect(h.service.registry.snapshot().links[uid]).toEqual(link);
    expect(capture.candidates().map((candidate) => candidate.path)).toEqual([
      "Other.md",
    ]);
    await capture.scan();
    expect(h.apply).toHaveBeenCalledTimes(3);
    capture.stop();
    h.service.stop();
  });

  test("an exact known link remains usable beside ambiguous new task text", async () => {
    const h = await setup(
      "- [ ] First #todoist\n- [ ] Second #todoist\n- [ ] Stable #todoist",
    );
    await h.capture.scan();
    await h.service.refresh();
    await vi.waitUntil(() => get(h.service.state).operations.length === 0);
    h.setText(
      "- [ ] Renamed first #todoist\n- [ ] Renamed second #todoist\n- [ ] Stable #todoist",
    );
    await h.capture.scan();
    expect(h.apply).toHaveBeenCalledTimes(3);
    expect(h.capture.candidates().map((candidate) => candidate.title)).toEqual([
      "Stable",
    ]);
    expect(get(h.capture.state).identityIssues[0]?.uids).toHaveLength(2);
    h.service.stop();
  });

  test("a prepared schedule reserves its note before capture can create another task", async () => {
    const h = await setup();
    const source = h.host.candidates()[0]!;
    const task: ProviderTask = {
      id: "existing",
      title: "Buy rice",
      description: "",
      projectId: "karma",
      parentId: null,
      labels: [],
      priority: 1,
      order: 1,
      completed: false,
      due: null,
    };
    await h.service.registry.change((state) => {
      state.schedules.push({
        id: crypto.randomUUID(),
        provider: "todoist",
        accountId: "account",
        task,
        linkUid: "root",
        googleUid: "calendar",
        providerOperationId: crypto.randomUUID(),
        occurrenceKey: "single",
        target: { kind: "insert", path: source.path, offset: 0, before: "" },
        children: [],
        raw: source.raw,
        generatedTaskIds: [task.id],
        syncTaskDate: false,
        phase: "prepared",
        createdAt: new Date().toISOString(),
        plan: {
          edits: [],
          interval: null,
          links: [{ uid: "root", task, source }],
        },
      });
    });
    await h.capture.scan();
    await h.service.refresh();
    expect(h.apply).not.toHaveBeenCalled();
    expect(get(h.capture.state).error).toBe("");
    h.capture.stop();
    h.service.stop();
  });

  test("parses real first-line tags while ignoring code, comments, links and escaped tags", () => {
    const text = [
      "---",
      "example:",
      "- [ ] Property #todoist",
      "---",
      "- [ ] 08:00 - 08:30 **Buy** [[Rice|rice]] #todoist #karma ^native",
      "  - [ ] Child #todoist",
      "- [ ] Literal `#todoist` \\#todoist <!-- #todoist --> %% #todoist %% [[#todoist]] [link](https://example.com/#todoist)",
      "- [x] Done #todoist",
      "```md",
      "- [ ] Code #todoist",
      "```",
      "%%",
      "- [ ] Comment #todoist",
      "%%",
    ].join("\r\n");
    const candidates = parseCaptureCandidates("Tasks.md", text);
    expect(candidates).toHaveLength(4);
    expect(candidates[0]?.tags.map((tag) => tag.name)).toEqual([
      "todoist",
      "karma",
    ]);
    expect(captureTitle(candidates[0]!, new Set(["todoist", "karma"]))).toBe(
      "Buy rice",
    );
    expect(candidates[1]?.parentFrom).toBe(candidates[0]?.from);
    expect(candidates[2]?.tags).toEqual([]);
    expect(candidates[3]?.completed).toBe(true);
    for (const candidate of candidates)
      expect(text.slice(candidate.from, candidate.to)).toBe(candidate.raw);
  });

  test("routes unique project and configured label tags while retaining unknown tags", () => {
    const candidate = parseCaptureCandidates(
      "Tasks.md",
      "- [ ] Buy rice #todoist #karma #errand #local",
    )[0]!;
    const settings = taskCaptureSettingsSchema.parse({});
    const account = taskAccountSettings(settings, snapshot);
    account.labelMappings.errand = "Errands";
    settings.accounts[taskAccountKey(snapshot)] = account;
    expect(routeCapture(candidate, snapshot, settings)).toMatchObject({
      title: "Buy rice #local",
      projectId: "karma",
      labels: ["Errands"],
    });
    const ambiguous = parseCaptureCandidates(
      "Tasks.md",
      "- [ ] Buy rice #todoist #karma #work",
    )[0]!;
    expect(() => routeCapture(ambiguous, snapshot, settings)).toThrow(
      "several projects",
    );
    expect(routeCapture(ambiguous, snapshot, settings, "inbox").projectId).toBe(
      "inbox",
    );
    account.defaultProjectId = "missing";
    expect(() =>
      routeCapture(
        parseCaptureCandidates("Tasks.md", "- [ ] Default #todoist")[0]!,
        snapshot,
        settings,
      ),
    ).toThrow("available project");
  });

  test("line stability and complete initial indexing gate automatic creation", async () => {
    const h = await setup();
    h.setReady(false);
    await h.capture.scan();
    h.setReady(true);
    h.setStable(false);
    await h.capture.scan();
    expect(h.apply).not.toHaveBeenCalled();
    h.setStable(true);
    await h.capture.scan();
    await h.service.refresh();
    await vi.waitUntil(() => get(h.service.state).operations.length === 0);
    expect(h.apply).toHaveBeenCalledTimes(1);
    expect(h.service.registry.snapshot().operations[0]?.mutation).toMatchObject(
      { kind: "create", task: { projectId: "karma", title: "Buy rice" } },
    );
    h.service.stop();
  });

  test("repeated index events and restart reuse the saved source identity", async () => {
    const h = await setup();
    await Promise.all([h.capture.scan(), h.capture.scan(), h.capture.scan()]);
    await h.service.refresh();
    await vi.waitUntil(() => get(h.service.state).operations.length === 0);
    h.service.stop();
    h.capture.stop();
    const restored = new TaskService(h.storage, h.provider);
    await restored.initialize();
    const capture = new TaskCapture(restored, h.host);
    await capture.scan();
    await restored.refresh();
    expect(h.apply).toHaveBeenCalledTimes(1);
    expect(Object.keys(restored.registry.snapshot().links)).toHaveLength(1);
    restored.stop();
    capture.stop();
  });

  test("concurrent manual routing and automatic scan persist one creation", async () => {
    const h = await setup();
    const candidate = h.host.candidates()[0]!;
    await Promise.all([h.capture.scan(), h.capture.create(candidate, "karma")]);
    await h.service.refresh();
    await vi.waitUntil(() => get(h.service.state).operations.length === 0);
    expect(h.apply).toHaveBeenCalledTimes(1);
    expect(Object.keys(h.service.registry.snapshot().links)).toHaveLength(1);
    h.service.stop();
  });

  test("stale indexed text, checked tasks and ambiguous routing create nothing", async () => {
    const h = await setup(
      "- [x] Old #todoist\n- [ ] Ambiguous #todoist #work #karma",
    );
    await h.capture.scan();
    expect(h.apply).not.toHaveBeenCalled();
    expect(get(h.capture.state).issues).toHaveLength(1);
    h.host.read = async () => "changed";
    await h.capture.scan();
    expect(h.apply).not.toHaveBeenCalled();
    h.service.stop();
  });

  test("children wait for parent acknowledgment and inherit its project", async () => {
    const h = await setup(
      "- [ ] Parent #todoist #work\n  - [ ] Child #todoist",
    );
    await h.capture.scan();
    await h.service.refresh();
    await vi.waitUntil(() => get(h.service.state).operations.length === 0);
    await h.capture.scan();
    await h.service.refresh();
    await vi.waitUntil(() => get(h.service.state).operations.length === 0);
    expect(h.apply).toHaveBeenCalledTimes(2);
    const first = h.apply.mock.calls[0]![0],
      second = h.apply.mock.calls[1]![0];
    expect(second.mutation).toMatchObject({
      kind: "create",
      task: { parentId: first.id, projectId: "work" },
    });
    h.service.stop();
  });
});
