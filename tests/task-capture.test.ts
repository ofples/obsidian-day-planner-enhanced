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
