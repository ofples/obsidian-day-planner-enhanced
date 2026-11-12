import { get } from "svelte/store";
import { describe, expect, test, vi } from "vitest";

import { TaskCapture } from "../src/tasks/capture";
import { parseCaptureCandidates } from "../src/tasks/capture-parser";
import { taskCaptureSettingsSchema } from "../src/tasks/capture-settings";
import {
  TaskIdentityRepairController,
  identitySourceKey,
} from "../src/tasks/identity-repair";
import { taskOccurrenceSchema } from "../src/tasks/occurrence-types";
import type { TaskOperation } from "../src/tasks/operations";
import { TaskService } from "../src/tasks/service";
import {
  TaskReadError,
  type ProviderTask,
  type TaskSnapshot,
} from "../src/tasks/types";

async function setup(raw = "- [ ] Work #todoist") {
  let cache: string | null = null,
    disk: string | null = null,
    secret = "",
    offline = false,
    failState = false,
    lose = false;
  let failAfter = 0;
  let normalization: Partial<ProviderTask> = {};
  const texts = new Map([["Tasks.md", raw]]),
    remote = new Map<string, ProviderTask>(),
    commands = new Set<string>();
  const snapshot = (): TaskSnapshot => ({
    provider: "todoist",
    account: { id: "account", name: "Fixture", timezone: "UTC" },
    projects: [
      { id: "work", name: "Work", order: 1, inbox: true },
      { id: "other", name: "Other", order: 2 },
    ],
    tasks: [...remote.values()].filter((task) => !task.completed),
    fetchedAt: "2026-11-12T00:00:00Z",
  });
  const apply = vi.fn(async (op: TaskOperation) => {
    if (offline) throw new TaskReadError("Offline");
    if (!commands.has(op.id)) {
      if (op.mutation.kind === "create")
        remote.set(op.id, {
          ...op.mutation.task,
          id: op.id,
          order: remote.size,
          completed: false,
          ...normalization,
        });
      else if (op.mutation.kind === "complete")
        remote.set(op.mutation.taskId, {
          ...remote.get(op.mutation.taskId)!,
          completed: true,
        });
      else throw Error("Unexpected command");
      normalization = {};
      commands.add(op.id);
    }
    if (lose) {
      lose = false;
      throw new TaskReadError("Response lost");
    }
    return {
      taskId: op.mutation.kind === "create" ? op.id : op.mutation.taskId,
    };
  });
  const provider = () => ({
    read: async () => {
      if (offline) throw new TaskReadError("Offline");
      return structuredClone(snapshot());
    },
    get: async (id: string) => structuredClone(remote.get(id) ?? null),
    apply,
  });
  const storage = {
    read: async () => cache,
    write: async (value: string) => {
      cache = value;
    },
    readState: async () => disk,
    writeState: async (value: string) => {
      if (failState || (failAfter && --failAfter === 0))
        throw Error("State unavailable");
      disk = value;
    },
    getSecret: () => secret,
    setSecret: (_key: string, value: string) => {
      secret = value;
    },
  };
  const settings = () => taskCaptureSettingsSchema.parse({});
  let service = new TaskService(storage, provider);
  await service.initialize();
  await service.connect("token");
  const host = {
    candidates: () =>
      [...texts].flatMap(([path, text]) => parseCaptureCandidates(path, text)),
    read: async (path: string) => texts.get(path) ?? null,
    paths: () => [...texts.keys()],
    ready: () => true,
    stable: () => true,
    settings,
  };
  let capture = new TaskCapture(service, host),
    controller = new TaskIdentityRepairController(
      service,
      capture,
      settings,
      () => true,
    );
  const expected = host
    .candidates()
    .filter(
      (candidate) =>
        !candidate.completed &&
        candidate.status === " " &&
        candidate.tags.some((tag) => tag.name === "todoist"),
    ).length;
  for (let attempt = 0; attempt < 6; attempt++) {
    await capture.scan();
    await service.refresh();
    if (
      Object.keys(service.registry.snapshot().links).length === expected &&
      get(service.state).operations.length === 0
    )
      break;
  }
  const links = service.registry.snapshot().links;
  texts.set("Copy.md", raw);
  await capture.scan();
  return {
    texts,
    remote,
    apply,
    links,
    get service() {
      return service;
    },
    get capture() {
      return capture;
    },
    get controller() {
      return controller;
    },
    setOffline(value: boolean) {
      offline = value;
    },
    failAfterWrites(value: number) {
      failAfter = value;
    },
    failState(value: boolean) {
      failState = value;
    },
    normalizeNext(value: Partial<ProviderTask>) {
      normalization = value;
    },
    loseResponse() {
      lose = true;
    },
    async restart() {
      capture.stop();
      service.stop();
      service = new TaskService(storage, provider);
      await service.initialize();
      capture = new TaskCapture(service, host);
      controller = new TaskIdentityRepairController(
        service,
        capture,
        settings,
        () => true,
      );
      await service.refresh();
    },
  };
}

async function historicalSetup() {
  const h = await setup("- [ ] Parent #todoist\n  - [ ] Child #todoist");
  const [rootUid, rootLink] = Object.entries(h.links).find(
    ([, link]) => link.source.from === 0,
  )!;
  const childUid = Object.keys(h.links).find((uid) => uid !== rootUid)!;
  const beforeTask = {
    ...rootLink.base!,
    completionCount: 0,
    due: {
      date: "2026-11-11",
      recurring: true,
      text: "every day",
      timezone: "UTC",
    },
  };
  const next = {
    ...beforeTask,
    completionCount: 1,
    due: { ...beforeTask.due, date: "2026-11-12" },
  };
  const beforeLinks = structuredClone(h.links);
  beforeLinks[rootUid]!.base = beforeTask;
  beforeLinks[childUid]!.base = {
    ...beforeLinks[childUid]!.base!,
    parentId: beforeTask.id,
  };
  const checked = h.texts.get("Tasks.md")!.replaceAll("[ ]", "[x]");
  h.texts.set("Tasks.md", checked);
  h.texts.set("Copy.md", checked);
  const sources = parseCaptureCandidates("Tasks.md", checked);
  const frozenLinks = structuredClone(beforeLinks);
  frozenLinks[rootUid]!.source = sources[0]!;
  frozenLinks[childUid]!.source = sources[1]!;
  const id = crypto.randomUUID();
  const record = taskOccurrenceSchema.parse({
    id,
    provider: "todoist",
    accountId: "account",
    before: {
      task: beforeTask,
      children: [beforeLinks[childUid]!.base],
      links: beforeLinks,
      projections: {},
    },
    next,
    links: frozenLinks,
    projections: {},
    phase: "complete",
    recovered: false,
    requestedAt: "2026-11-11T00:00:00Z",
    verifiedAt: "2026-11-11T00:01:00Z",
  });
  h.remote.set(beforeTask.id, next);
  h.remote.set(beforeLinks[childUid]!.taskId!, {
    ...beforeLinks[childUid]!.base!,
    completed: true,
  });
  await h.service.registry.change((state) => {
    state.links = {};
    state.projections = {};
    state.occurrences[id] = record;
  });
  await h.service.refresh();
  await h.capture.scan();
  return { h, id, rootUid, childUid, record, beforeTask, next };
}

describe("task identity decisions", () => {
  test("manual source repair retains a created parent and resumes its missing child with the original identities", async () => {
    const h = await setup("- [ ] Parent #todoist\n  - [ ] Child #todoist"),
      uid = Object.keys(h.links)[0]!;
    const review = await h.controller.review(uid),
      original = review.sources.find((source) => source.path === "Tasks.md")!,
      copy = review.sources.find((source) => source.path === "Copy.md")!;
    h.normalizeNext({ title: "Normalized parent" });
    await h.controller.confirm(review, {
      linked: h.controller.suggestTree(
        review,
        uid,
        identitySourceKey(original),
      ),
      create: [identitySourceKey(copy)],
    });
    const record = Object.values(
        h.service.registry.snapshot().identityDecisions,
      )[0]!,
      assignments = structuredClone(record.assignments),
      parent = record.assignments.find(
        (item) => item.kind === "create" && !item.parentUid,
      )!,
      child = record.assignments.find(
        (item) => item.kind === "create" && item.parentUid,
      )!;
    const rootCommand = h.service.registry
        .snapshot()
        .operations.find((op) => op.sourceUid === parent.uid)!,
      remoteId = rootCommand.remoteId;
    expect(rootCommand.status).toBe("conflict");
    expect(remoteId).toBeTruthy();
    expect(
      h.service.registry
        .snapshot()
        .operations.some((op) => op.sourceUid === child.uid),
    ).toBe(false);
    const edited =
      "- [ ] First choice #todoist\n  - [ ] Child A #todoist\n- [ ] Second choice #todoist\n  - [ ] Child B #todoist";
    h.texts.set("Copy.md", edited);
    await h.capture.scan();
    const repair = await h.controller.sourceRepair.review(record.id);
    const parentSource = repair.candidates.find(
        (source) => source.title === "Second choice",
      )!,
      childSource = repair.candidates.find(
        (source) => source.title === "Child B",
      )!;
    expect(Object.values(repair.selected)).toEqual(["", ""]);
    const choices = {
      [parent.uid]: identitySourceKey(parentSource),
      [child.uid]: identitySourceKey(childSource),
    };
    const saved = await h.controller.sourceRepair.confirm(repair, choices);
    expect(saved).toEqual({ kind: "saved", id: record.id });
    const intermediate = h.service.registry.snapshot();
    expect(intermediate.identityDecisions[record.id]!.repairs).toHaveLength(1);
    expect(intermediate.identityDecisions[record.id]!.assignments).toEqual(
      assignments,
    );
    expect(intermediate.links[parent.uid]!.taskId).toBe(remoteId);
    await expect(h.controller.cancel(record.id)).rejects.toThrow(
      "Task creation has started",
    );
    expect(
      intermediate.operations.find((op) => op.id === rootCommand.id)!.mutation,
    ).toEqual(rootCommand.mutation);
    expect(Object.values(intermediate.localSources)).toHaveLength(2);
    expect(h.texts.get("Copy.md")).toBe(edited);
    const conflict = await h.service.inspectConflict(rootCommand.id);
    await h.service.resolveConflict(
      conflict,
      Object.fromEntries(
        conflict.fields.map((item) => [item.key, "remote" as const]),
      ),
    );
    await h.controller.resume();
    await h.capture.scan();
    const state = h.service.registry.snapshot();
    expect(state.identityDecisions[record.id]!.phase).toBe("complete");
    expect(state.links[parent.uid]!.taskId).toBe(remoteId);
    expect(state.links[parent.uid]!.source.title).toBe("Second choice");
    expect(state.links[child.uid]!.source.title).toBe("Child B");
    expect(state.links[parent.uid]!.noteBase?.raw).toBe(copy.raw);
    expect(h.remote.get(state.links[child.uid]!.taskId!)?.parentId).toBe(
      remoteId,
    );
    expect(
      state.operations
        .filter(
          (op) => op.sourceUid === parent.uid && op.mutation.kind === "create",
        )
        .map((op) => op.id),
    ).toEqual([rootCommand.id]);
    expect(
      state.operations.filter(
        (op) => op.sourceUid === child.uid && op.mutation.kind === "create",
      ),
    ).toHaveLength(1);
    expect(h.remote.size).toBe(4);
    expect(get(h.capture.state).issues).toEqual([]);
    const commands = state.operations.length;
    await h.restart();
    await h.capture.scan();
    expect(await h.controller.sourceRepair.confirm(repair, choices)).toEqual(
      saved,
    );
    expect(h.service.registry.snapshot().operations).toHaveLength(commands);
    expect(
      h.service.registry.snapshot().identityDecisions[record.id]!.repairs,
    ).toHaveLength(1);
    h.service.stop();
  });

  test("cancelling a repaired unsent decision keeps edited copies local across restart", async () => {
    const h = await setup(),
      uid = Object.keys(h.links)[0]!,
      review = await h.controller.review(uid);
    h.setOffline(true);
    await h.controller.confirm(review, {
      linked: {
        [uid]: identitySourceKey(
          review.sources.find((source) => source.path === "Tasks.md")!,
        ),
      },
      create: [
        identitySourceKey(
          review.sources.find((source) => source.path === "Copy.md")!,
        ),
      ],
    });
    const record = Object.values(
        h.service.registry.snapshot().identityDecisions,
      )[0]!,
      created = record.assignments.find((item) => item.kind === "create")!;
    const edited = "- [ ] First choice #todoist\n- [ ] Second choice #todoist";
    h.texts.set("Copy.md", edited);
    await h.capture.scan();
    const repair = await h.controller.sourceRepair.review(record.id),
      source = repair.candidates.find(
        (source) => source.title === "Second choice",
      )!;
    await h.controller.sourceRepair.confirm(repair, {
      [created.uid]: identitySourceKey(source),
    });
    await h.controller.cancel(record.id);
    expect(h.service.registry.snapshot().links).toEqual(h.links);
    expect(
      Object.values(h.service.registry.snapshot().localSources),
    ).toHaveLength(2);
    expect(h.texts.get("Copy.md")).toBe(edited);
    h.setOffline(false);
    await h.restart();
    await h.capture.scan();
    await h.service.refresh();
    expect(h.remote.size).toBe(1);
    expect(h.service.registry.snapshot().links).toEqual(h.links);
    expect(
      h.service.registry.snapshot().identityDecisions[record.id]!.phase,
    ).toBe("cancelled");
    expect(get(h.capture.state).issues).toEqual([]);
    h.service.stop();
  });

  test("source repair rejects a claimed original block and rechecks changed candidates", async () => {
    const h = await setup(),
      uid = Object.keys(h.links)[0]!,
      review = await h.controller.review(uid);
    h.setOffline(true);
    await h.controller.confirm(review, {
      linked: {
        [uid]: identitySourceKey(
          review.sources.find((source) => source.path === "Tasks.md")!,
        ),
      },
      create: [
        identitySourceKey(
          review.sources.find((source) => source.path === "Copy.md")!,
        ),
      ],
    });
    const record = Object.values(
        h.service.registry.snapshot().identityDecisions,
      )[0]!,
      created = record.assignments.find((item) => item.kind === "create")!;
    let repair = await h.controller.sourceRepair.review(record.id);
    expect(
      repair.candidates.every((source) => source.path !== "Tasks.md"),
    ).toBe(true);
    await expect(
      h.controller.sourceRepair.confirm(repair, {
        [created.uid]: identitySourceKey(
          review.sources.find((source) => source.path === "Tasks.md")!,
        ),
      }),
    ).rejects.toThrow("available note block");
    h.texts.set("Copy.md", "Heading\n" + h.texts.get("Copy.md"));
    const changed = await h.controller.sourceRepair.confirm(
      repair,
      repair.selected,
    );
    expect(changed.kind).toBe("changed");
    expect(
      h.service.registry.snapshot().identityDecisions[record.id]!.repairs,
    ).toEqual([]);
    repair = await h.controller.sourceRepair.review(record.id);
    h.failState(true);
    await expect(
      h.controller.sourceRepair.confirm(repair, repair.selected),
    ).rejects.toThrow("State unavailable");
    expect(
      h.service.registry.snapshot().identityDecisions[record.id]!.repairs,
    ).toEqual([]);
    expect(h.remote.size).toBe(1);
    h.service.stop();
  });

  test("whole-tree source repair follows nested offsets and saves the displaced copies as local", async () => {
    const h = await setup("- [ ] Parent #todoist\n  - [ ] Child #todoist"),
      uid = Object.keys(h.links)[0]!,
      review = await h.controller.review(uid);
    h.setOffline(true);
    await h.controller.confirm(review, {
      linked: h.controller.suggestTree(
        review,
        uid,
        identitySourceKey(
          review.sources.find((source) => source.path === "Tasks.md")!,
        ),
      ),
      create: [
        identitySourceKey(
          review.sources.find((source) => source.path === "Copy.md")!,
        ),
      ],
    });
    const record = Object.values(
        h.service.registry.snapshot().identityDecisions,
      )[0]!,
      parent = record.assignments.find(
        (item) => item.kind === "create" && !item.parentUid,
      )!;
    h.texts.set("Other.md", h.texts.get("Copy.md")!);
    const repair = await h.controller.sourceRepair.review(record.id),
      source = repair.candidates.find(
        (source) =>
          source.path === "Other.md" && source.parentFrom === undefined,
      )!;
    const selected = h.controller.sourceRepair.suggestTree(
      repair,
      parent.uid,
      identitySourceKey(source),
    );
    expect(Object.keys(selected)).toHaveLength(2);
    const confirmations = await Promise.all([
      h.controller.sourceRepair.confirm(repair, selected),
      h.controller.sourceRepair.confirm(repair, selected),
    ]);
    expect(confirmations[0]).toEqual(confirmations[1]);
    expect(
      h.service.registry.snapshot().identityDecisions[record.id]!.repairs,
    ).toHaveLength(1);
    expect(
      Object.values(h.service.registry.snapshot().localSources).every(
        (local) => local.source.path === "Copy.md",
      ),
    ).toBe(true);
    h.setOffline(false);
    await h.restart();
    await h.controller.retry(record.id);
    await h.capture.scan();
    const state = h.service.registry.snapshot();
    expect(state.identityDecisions[record.id]!.phase).toBe("complete");
    expect(
      record.assignments
        .filter((item) => item.kind === "create")
        .every((item) => state.links[item.uid]!.source.path === "Other.md"),
    ).toBe(true);
    expect(h.remote.size).toBe(4);
    expect(get(h.capture.state).issues).toEqual([]);
    h.service.stop();
  });

  test.each(["Tasks.md", "Copy.md"])(
    "historical copies retain occurrence ownership when choosing %s",
    async (path) => {
      const { h, id, rootUid, record, next } = await historicalSetup();
      expect(
        get(h.capture.state).issues.some((issue) => issue.linkUid === rootUid),
      ).toBe(true);
      const review = await h.controller.review(rootUid);
      expect(Object.values(review.before.historical!)).toEqual([id, id]);
      const source = review.sources.find((source) => source.path === path)!;
      const texts = [...h.texts],
        calls = h.apply.mock.calls.length;
      await h.controller.confirm(review, {
        linked: h.controller.suggestTree(
          review,
          rootUid,
          identitySourceKey(source),
        ),
        create: [],
      });
      const state = h.service.registry.snapshot();
      expect(state.links).toEqual({});
      expect(state.occurrences[id]!.before).toEqual(record.before);
      expect(
        Object.values(state.occurrences[id]!.links).every(
          (link) => link.source.path === path,
        ),
      ).toBe(true);
      expect(state.occurrences[id]!.next).toEqual(next);
      expect(h.remote.get(next.id)).toEqual(next);
      expect([...h.texts]).toEqual(texts);
      expect(h.apply).toHaveBeenCalledTimes(calls);
      await h.restart();
      await h.capture.scan();
      expect(get(h.capture.state).issues).toEqual([]);
      expect(h.service.registry.snapshot().links).toEqual({});
      expect(h.service.registry.snapshot().occurrences[id]!.before).toEqual(
        record.before,
      );
      h.service.stop();
    },
  );

  test("creating a checked historical copy preserves the recurring task and original completion baseline", async () => {
    const { h, id, rootUid, record, next } = await historicalSetup();
    const review = await h.controller.review(rootUid),
      original = review.sources.find((source) => source.path === "Tasks.md")!,
      copy = review.sources.find((source) => source.path === "Copy.md")!;
    const result = await h.controller.confirm(review, {
      linked: h.controller.suggestTree(
        review,
        rootUid,
        identitySourceKey(original),
      ),
      create: [identitySourceKey(copy)],
    });
    expect(result.kind).toBe("saved");
    const state = h.service.registry.snapshot(),
      created = Object.values(state.links);
    expect(created).toHaveLength(2);
    expect(
      created.every(
        (link) =>
          link.source.path === "Copy.md" &&
          h.remote.get(link.taskId!)?.completed &&
          link.taskId !== next.id,
      ),
    ).toBe(true);
    const parent = created.find((link) => link.base?.parentId === null)!,
      child = created.find((link) => link.base?.parentId !== null)!;
    expect(child.base?.parentId).toBe(parent.taskId);
    expect(state.occurrences[id]!.before).toEqual(record.before);
    expect(state.occurrences[id]!.next).toEqual(next);
    expect(h.remote.get(next.id)).toEqual(next);
    expect(Object.values(state.identityDecisions)[0]!.phase).toBe("complete");
    const calls = h.apply.mock.calls.length;
    await h.restart();
    await h.controller.resume();
    await h.capture.scan();
    expect(h.apply).toHaveBeenCalledTimes(calls);
    expect(get(h.capture.state).issues).toEqual([]);
    h.service.stop();
  });

  test("cancelling unsent historical-copy creation restores history without promoting active links", async () => {
    const { h, id, rootUid, record } = await historicalSetup();
    const review = await h.controller.review(rootUid),
      original = review.sources.find((source) => source.path === "Tasks.md")!,
      copy = review.sources.find((source) => source.path === "Copy.md")!;
    h.setOffline(true);
    await h.controller.confirm(review, {
      linked: h.controller.suggestTree(
        review,
        rootUid,
        identitySourceKey(copy),
      ),
      create: [identitySourceKey(original)],
    });
    const decision = Object.values(
      h.service.registry.snapshot().identityDecisions,
    )[0]!;
    expect(decision.phase).toBe("creating");
    await h.controller.cancel(decision.id);
    const state = h.service.registry.snapshot();
    expect(state.links).toEqual({});
    expect(state.localSources).toEqual({});
    expect(state.occurrences[id]).toEqual(record);
    expect(h.remote.size).toBe(2);
    h.service.stop();
  });

  test("changed historical ownership blocks queued creation after restart", async () => {
    const { h, id, rootUid } = await historicalSetup();
    const review = await h.controller.review(rootUid),
      original = review.sources.find((source) => source.path === "Tasks.md")!,
      copy = review.sources.find((source) => source.path === "Copy.md")!;
    h.setOffline(true);
    await h.controller.confirm(review, {
      linked: h.controller.suggestTree(
        review,
        rootUid,
        identitySourceKey(original),
      ),
      create: [identitySourceKey(copy)],
    });
    const decision = Object.values(
      h.service.registry.snapshot().identityDecisions,
    )[0]!;
    await h.service.registry.change((state) => {
      state.occurrences[id]!.phase = "undone";
    });
    const calls = h.apply.mock.calls.length;
    h.setOffline(false);
    await h.restart();
    await h.controller.retry(decision.id);
    expect(h.apply).toHaveBeenCalledTimes(calls);
    expect(h.remote.size).toBe(2);
    expect(
      h.service.registry.snapshot().identityDecisions[decision.id]!.phase,
    ).toBe("creating");
    expect(
      h.service.registry.snapshot().identityDecisions[decision.id]!.error,
    ).toContain("completed occurrence changed");
    await expect(h.controller.cancel(decision.id)).rejects.toThrow(
      "completed occurrence changed",
    );
    h.service.stop();
  });

  test.each(["Tasks.md", "Copy.md"])(
    "choosing %s retains the original task and makes the other copy local",
    async (path) => {
      const h = await setup(),
        uid = Object.keys(h.links)[0]!,
        review = await h.controller.review(uid);
      const source = review.sources.find((source) => source.path === path)!;
      const before = [...h.texts];
      const result = await h.controller.confirm(review, {
        linked: { [uid]: identitySourceKey(source) },
        create: [],
      });
      expect(result.kind).toBe("saved");
      const state = h.service.registry.snapshot();
      expect(state.links[uid]?.taskId).toBe(h.links[uid]!.taskId);
      expect(state.links[uid]?.source.path).toBe(path);
      expect(Object.values(state.localSources)).toHaveLength(1);
      expect(Object.values(state.identityDecisions)[0]?.phase).toBe("complete");
      expect([...h.texts]).toEqual(before);
      await h.capture.scan();
      expect(get(h.capture.state).identityIssues).toEqual([]);
      expect(h.apply).toHaveBeenCalledOnce();
      await h.restart();
      await h.capture.scan();
      expect(h.service.registry.snapshot().links[uid]?.source.path).toBe(path);
      expect(get(h.capture.state).issues).toEqual([]);
      h.service.stop();
    },
  );

  test("separate task creation uses a fresh outbox identity and preserves both note blocks", async () => {
    const h = await setup(),
      uid = Object.keys(h.links)[0]!,
      review = await h.controller.review(uid);
    const original = review.sources.find(
        (source) => source.path === "Tasks.md",
      )!,
      copy = review.sources.find((source) => source.path === "Copy.md")!;
    const before = [...h.texts];
    const result = await h.controller.confirm(review, {
      linked: { [uid]: identitySourceKey(original) },
      create: [identitySourceKey(copy)],
    });
    expect(result.kind).toBe("saved");
    const state = h.service.registry.snapshot(),
      links = Object.values(state.links);
    expect(links).toHaveLength(2);
    expect(new Set(links.map((link) => link.taskId)).size).toBe(2);
    expect(Object.values(state.identityDecisions)[0]?.phase).toBe("complete");
    expect([...h.texts]).toEqual(before);
    expect(h.apply).toHaveBeenCalledTimes(2);
    await h.restart();
    await h.capture.scan();
    await h.controller.resume();
    expect(h.apply).toHaveBeenCalledTimes(2);
    expect(get(h.capture.state).issues).toEqual([]);
    h.service.stop();
  });

  test("a copied parent carries its original child link when the whole tree moves", async () => {
    const h = await setup("- [ ] Parent #todoist\n  - [ ] Child #todoist"),
      uid = Object.entries(h.links).find(
        ([, link]) => link.base?.parentId === null,
      )![0];
    const review = await h.controller.review(uid),
      copy = review.sources.find((source) => source.path === "Copy.md")!;
    const linked = h.controller.suggestTree(
      review,
      uid,
      identitySourceKey(copy),
    );
    expect(Object.keys(linked)).toHaveLength(2);
    await h.controller.confirm(review, { linked, create: [] });
    await h.capture.scan();
    for (const [key, link] of Object.entries(h.links)) {
      expect(h.service.registry.snapshot().links[key]?.taskId).toBe(
        link.taskId,
      );
      expect(h.service.registry.snapshot().links[key]?.source.path).toBe(
        "Copy.md",
      );
    }
    expect(h.apply).toHaveBeenCalledTimes(2);
    expect(get(h.capture.state).issues).toEqual([]);
    h.service.stop();
  });

  test("nested separate tasks use the verified new parent identity", async () => {
    const h = await setup("- [ ] Parent #todoist\n  - [ ] Child #todoist"),
      uid = Object.entries(h.links).find(
        ([, link]) => link.base?.parentId === null,
      )![0];
    const review = await h.controller.review(uid),
      original = review.sources.find((source) => source.path === "Tasks.md")!,
      copy = review.sources.find((source) => source.path === "Copy.md")!;
    await h.controller.confirm(review, {
      linked: h.controller.suggestTree(
        review,
        uid,
        identitySourceKey(original),
      ),
      create: [identitySourceKey(copy)],
    });
    const created = Object.values(h.service.registry.snapshot().links).filter(
      (link) => link.source.path === "Copy.md",
    );
    expect(created).toHaveLength(2);
    const parent = created.find((link) => !link.base?.parentId)!;
    const child = created.find((link) => link.base?.parentId)!;
    expect(child.base?.parentId).toBe(parent.taskId);
    expect(parent.taskId).not.toBe(h.links[uid]!.taskId);
    expect(
      Object.values(h.service.registry.snapshot().identityDecisions)[0]?.phase,
    ).toBe("complete");
    expect(h.apply).toHaveBeenCalledTimes(4);
    h.service.stop();
  });

  test("a changed comparison requires another confirmation without saving a decision", async () => {
    const h = await setup(),
      uid = Object.keys(h.links)[0]!,
      review = await h.controller.review(uid);
    h.texts.set("Copy.md", "Heading\n" + h.texts.get("Copy.md"));
    const result = await h.controller.confirm(review, {
      linked: { [uid]: identitySourceKey(review.sources[0]!) },
      create: [],
    });
    expect(result.kind).toBe("changed");
    expect(h.service.registry.snapshot().identityDecisions).toEqual({});
    expect(h.apply).toHaveBeenCalledOnce();
    h.service.stop();
  });

  test("a failed decision write preserves all sources and sends no create", async () => {
    const h = await setup(),
      uid = Object.keys(h.links)[0]!,
      review = await h.controller.review(uid),
      before = h.service.registry.snapshot();
    h.failState(true);
    await expect(
      h.controller.confirm(review, {
        linked: { [uid]: identitySourceKey(review.sources[0]!) },
        create: [],
      }),
    ).rejects.toThrow("State unavailable");
    expect(h.service.registry.snapshot()).toEqual(before);
    expect(h.apply).toHaveBeenCalledOnce();
    h.service.stop();
  });
  test("checked copied children are created and completed under their new parent", async () => {
    const h = await setup(
      "- [ ] Parent #todoist\n  - [x] Checked child #todoist",
    );
    const uid = Object.keys(h.links)[0]!,
      review = await h.controller.review(uid),
      original = review.sources.find((source) => source.path === "Tasks.md")!,
      copy = review.sources.find((source) => source.path === "Copy.md")!;
    const before = [...h.texts];
    await h.controller.confirm(review, {
      linked: { [uid]: identitySourceKey(original) },
      create: [identitySourceKey(copy)],
    });
    const state = h.service.registry.snapshot(),
      record = Object.values(state.identityDecisions)[0]!;
    expect(record.phase).toBe("complete");
    const child = record.assignments.find((item) => item.completed)!;
    const remote = h.remote.get(state.links[child.uid]!.taskId!)!;
    expect(remote.completed).toBe(true);
    expect(remote.parentId).toBe(state.links[child.parentUid!]!.taskId);
    expect([...h.texts]).toEqual(before);
    h.service.stop();
  });

  test("offline source decisions reserve task edits and resume the same create after restart", async () => {
    const h = await setup(),
      uid = Object.keys(h.links)[0]!,
      review = await h.controller.review(uid);
    h.setOffline(true);
    const original = review.sources.find(
        (source) => source.path === "Tasks.md",
      )!,
      copy = review.sources.find((source) => source.path === "Copy.md")!;
    const result = await h.controller.confirm(review, {
      linked: { [uid]: identitySourceKey(original) },
      create: [identitySourceKey(copy)],
    });
    expect(result.kind).toBe("saved");
    const state = h.service.registry.snapshot(),
      record = Object.values(state.identityDecisions)[0]!,
      newUid = record.assignments.find((item) => item.kind === "create")!.uid;
    expect(record.phase).toBe("creating");
    expect(get(h.service.state).identityDecisions?.[0]?.cancellable).toBe(true);
    const command = state.operations.find((op) => op.sourceUid === newUid)!;
    await expect(h.service.complete(h.links[uid]!.base!)).rejects.toThrow(
      "source decision",
    );
    h.setOffline(false);
    await h.restart();
    await h.controller.retry(record.id);
    await h.capture.scan();
    expect(
      h.service.registry.snapshot().identityDecisions[record.id]?.phase,
    ).toBe("complete");
    expect(
      h.service.registry
        .snapshot()
        .operations.filter((op) => op.sourceUid === newUid)
        .map((op) => op.id),
    ).toEqual([command.id]);
    expect(h.remote.size).toBe(2);
    h.service.stop();
  });

  test("an unsent offline decision can be cancelled back to its original link", async () => {
    const h = await setup(),
      uid = Object.keys(h.links)[0]!,
      review = await h.controller.review(uid);
    h.setOffline(true);
    const copy = review.sources.find((source) => source.path === "Copy.md")!,
      original = review.sources.find((source) => source.path === "Tasks.md")!;
    await h.controller.confirm(review, {
      linked: { [uid]: identitySourceKey(copy) },
      create: [identitySourceKey(original)],
    });
    const record = Object.values(
      h.service.registry.snapshot().identityDecisions,
    )[0]!;
    await h.controller.cancel(record.id);
    const state = h.service.registry.snapshot();
    expect(state.identityDecisions[record.id]?.phase).toBe("cancelled");
    expect(state.links).toEqual(h.links);
    expect(state.localSources).toEqual({});
    expect(h.remote.size).toBe(1);
    h.service.stop();
  });

  test("local copies can later become separate tasks through a fresh source decision", async () => {
    const h = await setup(),
      uid = Object.keys(h.links)[0]!,
      review = await h.controller.review(uid),
      original = review.sources.find((source) => source.path === "Tasks.md")!;
    await h.controller.confirm(review, {
      linked: { [uid]: identitySourceKey(original) },
      create: [],
    });
    const second = await h.controller.review(uid),
      copy = second.sources.find((source) => source.path === "Copy.md")!;
    await h.controller.confirm(second, {
      linked: { [uid]: identitySourceKey(original) },
      create: [identitySourceKey(copy)],
    });
    expect(h.remote.size).toBe(2);
    expect(h.service.registry.snapshot().localSources).toEqual({});
    await h.capture.scan();
    expect(get(h.capture.state).issues).toEqual([]);
    h.service.stop();
  });
  test("a lost create response reuses its source and command identities after restart", async () => {
    const h = await setup(),
      uid = Object.keys(h.links)[0]!,
      review = await h.controller.review(uid);
    h.loseResponse();
    const original = review.sources.find(
        (source) => source.path === "Tasks.md",
      )!,
      copy = review.sources.find((source) => source.path === "Copy.md")!;
    await h.controller.confirm(review, {
      linked: { [uid]: identitySourceKey(original) },
      create: [identitySourceKey(copy)],
    });
    const record = Object.values(
        h.service.registry.snapshot().identityDecisions,
      )[0]!,
      created = record.assignments.find((item) => item.kind === "create")!;
    const command = h.service.registry
      .snapshot()
      .operations.find((op) => op.sourceUid === created.uid)!;
    expect(h.remote.size).toBe(2);
    await h.restart();
    await h.controller.retry(record.id);
    await h.capture.scan();
    const state = h.service.registry.snapshot();
    expect(state.identityDecisions[record.id]?.phase).toBe("complete");
    expect(
      state.operations
        .filter((op) => op.sourceUid === created.uid)
        .map((op) => op.id),
    ).toEqual([command.id]);
    expect(h.remote.size).toBe(2);
    expect(get(h.capture.state).issues).toEqual([]);
    await expect(h.controller.cancel(record.id)).rejects.toThrow();
    h.service.stop();
  });
  test("concurrent and repeated confirmations reuse one durable source decision", async () => {
    const h = await setup(),
      uid = Object.keys(h.links)[0]!,
      review = await h.controller.review(uid);
    const choices = {
      linked: {
        [uid]: identitySourceKey(
          review.sources.find((source) => source.path === "Tasks.md")!,
        ),
      },
      create: [],
    };
    const results = await Promise.all([
      h.controller.confirm(review, choices),
      h.controller.confirm(review, choices),
    ]);
    expect(results[0]).toEqual(results[1]);
    expect(
      Object.values(h.service.registry.snapshot().identityDecisions),
    ).toHaveLength(1);
    expect(
      Object.values(h.service.registry.snapshot().localSources),
    ).toHaveLength(1);
    expect(await h.controller.confirm(review, choices)).toEqual(results[0]);
    await h.capture.scan();
    expect(get(h.capture.state).issues).toEqual([]);
    h.service.stop();
  });

  test("ambiguous bulk renames accept explicit one-to-one source assignments", async () => {
    const h = await setup("- [ ] First #todoist\n- [ ] Second #todoist");
    h.texts.delete("Copy.md");
    h.texts.set(
      "Tasks.md",
      "- [ ] Renamed first #todoist\n- [ ] Renamed second #todoist",
    );
    await h.capture.scan();
    const uids = Object.keys(h.links),
      review = await h.controller.review(uids[0]!);
    const linked = Object.fromEntries(
      uids.map((uid, index) => [
        uid,
        identitySourceKey(review.sources[index]!),
      ]),
    );
    await h.controller.confirm(review, { linked, create: [] });
    const state = h.service.registry.snapshot();
    for (const [index, uid] of uids.entries()) {
      expect(state.links[uid]?.taskId).toBe(h.links[uid]!.taskId);
      expect(state.links[uid]?.source.title).toBe(
        index === 0 ? "Renamed first" : "Renamed second",
      );
      expect(state.links[uid]?.noteBase).toEqual(h.links[uid]!.noteBase);
    }
    expect(h.apply).toHaveBeenCalledTimes(2);
    h.service.stop();
  });
  test.each(["missing", "foreign", "changed"])(
    "a %s source receipt blocks replay of its saved create",
    async (mode) => {
      const h = await setup(),
        uid = Object.keys(h.links)[0]!,
        review = await h.controller.review(uid);
      h.setOffline(true);
      const original = review.sources.find(
          (source) => source.path === "Tasks.md",
        )!,
        copy = review.sources.find((source) => source.path === "Copy.md")!;
      await h.controller.confirm(review, {
        linked: { [uid]: identitySourceKey(original) },
        create: [identitySourceKey(copy)],
      });
      const record = Object.values(
          h.service.registry.snapshot().identityDecisions,
        )[0]!,
        source = record.assignments.find((item) => item.kind === "create")!;
      await h.service.registry.change((state) => {
        if (mode === "missing") delete state.identityDecisions[record.id];
        else if (mode === "changed")
          state.identityDecisions[record.id]!.assignments.find(
            (item) => item.uid === source.uid,
          )!.draft!.title = "Changed receipt";
        else {
          const saved = state.identityDecisions[record.id]!;
          saved.accountId = "foreign";
          for (const link of Object.values(saved.before.links))
            link.accountId = "foreign";
        }
      });
      h.setOffline(false);
      await h.service.refresh();
      const command = h.service.registry
        .snapshot()
        .operations.find((op) => op.sourceUid === source.uid)!;
      expect(command.status).toBe("failed");
      expect(command.error).toContain("saved source decision");
      expect(h.remote.size).toBe(1);
      h.service.stop();
    },
  );
  test("bulk parent renames retain their uniquely matched nested task identities", async () => {
    const h = await setup(
      "- [ ] First #todoist\n  - [ ] Child one #todoist\n- [ ] Second #todoist\n  - [ ] Child two #todoist",
    );
    h.texts.delete("Copy.md");
    h.texts.set(
      "Tasks.md",
      "- [ ] Renamed first #todoist\n  - [ ] Child one #todoist\n- [ ] Renamed second #todoist\n  - [ ] Child two #todoist",
    );
    await h.capture.scan();
    const rootUids = Object.entries(h.links)
        .filter(([, link]) => !link.base?.parentId)
        .map(([uid]) => uid),
      review = await h.controller.review(rootUids[0]!);
    expect(Object.keys(review.before.links)).toHaveLength(4);
    const linked = Object.fromEntries(
      Object.entries(review.before.links).map(([uid, link]) => [
        uid,
        identitySourceKey(
          review.candidates.find(
            (source) =>
              source.title ===
              (link.base?.title === "First"
                ? "Renamed first"
                : link.base?.title === "Second"
                  ? "Renamed second"
                  : link.base?.title),
          )!,
        ),
      ]),
    );
    await h.controller.confirm(review, { linked, create: [] });
    await h.capture.scan();
    expect(h.apply).toHaveBeenCalledTimes(4);
    expect(Object.keys(h.service.registry.snapshot().links)).toHaveLength(4);
    expect(h.service.registry.snapshot().localSources).toEqual({});
    expect(get(h.capture.state).issues).toEqual([]);
    h.service.stop();
  });
  test.each(["title", "projectId"] as const)(
    "reviewed %s readback choices resume the same created tree",
    async (field) => {
      const h = await setup("- [ ] Parent #todoist\n  - [ ] Child #todoist"),
        uid = Object.entries(h.links).find(
          ([, link]) => !link.base?.parentId,
        )![0];
      const review = await h.controller.review(uid),
        original = review.sources.find((source) => source.path === "Tasks.md")!,
        copy = review.sources.find((source) => source.path === "Copy.md")!;
      h.normalizeNext(
        field === "title"
          ? { title: "Normalized parent" }
          : { projectId: "other" },
      );
      await h.controller.confirm(review, {
        linked: h.controller.suggestTree(
          review,
          uid,
          identitySourceKey(original),
        ),
        create: [identitySourceKey(copy)],
      });
      const record = Object.values(
          h.service.registry.snapshot().identityDecisions,
        )[0]!,
        parent = record.assignments.find(
          (item) => item.kind === "create" && !item.parentUid,
        )!;
      let command = h.service.registry
        .snapshot()
        .operations.find((op) => op.sourceUid === parent.uid)!;
      expect(command.status).toBe("conflict");
      expect(get(h.service.state).identityDecisions?.[0]?.cancellable).toBe(
        false,
      );
      const conflict = await h.service.inspectConflict(command.id);
      await h.service.resolveConflict(
        conflict,
        Object.fromEntries(
          conflict.fields.map((item) => [item.key, "remote" as const]),
        ),
      );
      await h.controller.retry(record.id);
      const state = h.service.registry.snapshot(),
        created = record.assignments.filter((item) => item.kind === "create");
      expect(state.identityDecisions[record.id]?.phase).toBe("complete");
      expect(h.remote.size).toBe(4);
      expect(h.apply).toHaveBeenCalledTimes(4);
      const child = created.find((item) => item.parentUid)!;
      expect(h.remote.get(state.links[child.uid]!.taskId!)?.parentId).toBe(
        state.links[parent.uid]!.taskId,
      );
      if (field === "projectId")
        expect(h.remote.get(state.links[child.uid]!.taskId!)?.projectId).toBe(
          "other",
        );
      command = state.operations.find((op) => op.id === command.id)!;
      expect(command.status).toBe("cancelled");
      expect(command.resolutionIds).toEqual([]);
      h.service.stop();
    },
  );
  test("a selected source can move and be renamed before its interrupted create intent resumes", async () => {
    const h = await setup(),
      uid = Object.keys(h.links)[0]!,
      review = await h.controller.review(uid),
      original = review.sources.find((source) => source.path === "Tasks.md")!,
      copy = review.sources.find((source) => source.path === "Copy.md")!;
    h.failAfterWrites(2);
    await h.controller.confirm(review, {
      linked: { [uid]: identitySourceKey(original) },
      create: [identitySourceKey(copy)],
    });
    const record = Object.values(
        h.service.registry.snapshot().identityDecisions,
      )[0]!,
      source = record.assignments.find((item) => item.kind === "create")!;
    expect(record.phase).toBe("creating");
    expect(h.remote.size).toBe(1);
    h.texts.set("Moved.md", h.texts.get("Copy.md")!);
    h.texts.delete("Copy.md");
    await h.capture.scan();
    h.texts.set("Moved.md", "- [ ] Renamed selected task #todoist");
    await h.capture.scan();
    await h.controller.retry(record.id);
    const state = h.service.registry.snapshot();
    expect(state.identityDecisions[record.id]?.phase).toBe("complete");
    expect(h.remote.size).toBe(2);
    expect(state.links[source.uid]?.source.path).toBe("Moved.md");
    expect(state.links[source.uid]?.source.title).toBe("Renamed selected task");
    expect(state.links[source.uid]?.noteBase?.raw).toBe(copy.raw);
    expect(
      state.operations.filter((op) => op.sourceUid === source.uid),
    ).toHaveLength(1);
    h.service.stop();
  });
  test("a previously sent create stays protected when its retry returns to pending", async () => {
    const h = await setup(),
      uid = Object.keys(h.links)[0]!,
      review = await h.controller.review(uid),
      original = review.sources.find((source) => source.path === "Tasks.md")!,
      copy = review.sources.find((source) => source.path === "Copy.md")!;
    h.loseResponse();
    await h.controller.confirm(review, {
      linked: { [uid]: identitySourceKey(original) },
      create: [identitySourceKey(copy)],
    });
    const record = Object.values(
        h.service.registry.snapshot().identityDecisions,
      )[0]!,
      source = record.assignments.find((item) => item.kind === "create")!,
      command = h.service.registry
        .snapshot()
        .operations.find((op) => op.sourceUid === source.uid)!;
    expect(command.sentAt).toBeTruthy();
    await h.service.registry.updateOperation(command.id, {
      status: "pending",
      retryAt: Date.now() + 60_000,
    });
    h.service.publish();
    expect(get(h.service.state).identityDecisions?.[0]?.cancellable).toBe(
      false,
    );
    await expect(h.controller.cancel(record.id)).rejects.toThrow("started");
    expect(h.remote.size).toBe(2);
    h.service.stop();
  });
});
