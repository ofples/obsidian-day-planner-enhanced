import { describe, expect, it, vi } from "vitest";
import { writable } from "svelte/store";
import { parseCaptureCandidates } from "../src/tasks/capture-parser";
import {
  WeakTaskCapture,
  type WeakCaptureHost,
} from "../src/tasks/weak-capture";
import type { TaskOperation } from "../src/tasks/operations";
import type { TaskService } from "../src/tasks/service";

function fixture(initial: string) {
  let text = initial,
    saved: string | null = null;
  const snapshot = {
    provider: "todoist",
    account: { id: "a", name: "A", timezone: "UTC" },
    projects: [{ id: "p", name: "Inbox", order: 0, inbox: true }],
    tasks: [],
    fetchedAt: "2026-11-15T00:00:00Z",
  };
  const createWeak = vi.fn(async (_operation: TaskOperation) => ({
    id: "123",
  }));
  const service = {
    state: writable({ connected: true, snapshot }),
    createWeak,
  } as unknown as TaskService;
  const host: WeakCaptureHost = {
    enabled: () => true,
    candidates: () => parseCaptureCandidates("note.md", text),
    stable: () => true,
    settings: () => ({ enabled: true, roots: [], accounts: {} }),
    read: async () => text,
    write: async (_path, before, after) => {
      if (before !== text) return false;
      text = after;
      return true;
    },
    load: async () => saved,
    save: async (value) => {
      saved = value;
    },
  };
  return {
    createWeak,
    host,
    make: () => new WeakTaskCapture(service, host),
    text: () => text,
    setText: (value: string) => {
      text = value;
    },
    saved: () => saved,
  };
}
describe("weak tagged capture", () => {
  it("consumes the capture tag and adds a link while leaving children local", async () => {
    const f = fixture("- [ ] 09:00 Parent #todoist #home ^abc\n  - [ ] Child");
    const capture = f.make();
    await capture.scan();
    await capture.scan();
    expect(f.createWeak).toHaveBeenCalledTimes(1);
    expect(f.text()).toBe(
      "- [ ] 09:00 Parent  #home [🔗](https://app.todoist.com/app/task/123) ^abc\n  - [ ] Child",
    );
    const operation = f.createWeak.mock.calls[0]![0];
    expect(operation.mutation.kind).toBe("create");
    if (operation.mutation.kind === "create")
      expect(operation.mutation.task.parentId).toBeNull();
  });
  it("retries a lost response after reload with the same command identity", async () => {
    const f = fixture("- [ ] Parent #todoist");
    f.createWeak.mockRejectedValueOnce(new Error("lost"));
    await f.make().scan();
    const first = f.createWeak.mock.calls[0]![0];
    await f.make().scan(true);
    const second = f.createWeak.mock.calls[1]![0];
    expect(second.id).toBe(first.id);
    expect(second.tempId).toBe(first.tempId);
    expect(f.text()).toContain("[🔗](https://app.todoist.com/app/task/123)");
  });
  it("preserves concurrent edits and does not issue a second create", async () => {
    const f = fixture("- [ ] Parent #todoist");
    f.createWeak.mockImplementationOnce(async () => {
      f.setText("- [ ] Edited #todoist");
      return { id: "123" };
    });
    const capture = f.make();
    await capture.scan();
    await capture.scan();
    expect(f.createWeak).toHaveBeenCalledTimes(1);
    expect(f.text()).toBe("- [ ] Edited #todoist");
    expect(f.saved()).toContain('"taskId":"123"');
  });
  it("does not recreate after the consumed link is removed", async () => {
    const f = fixture("- [ ] Parent #todoist");
    const capture = f.make();
    await capture.scan();
    await capture.scan();
    f.setText("- [ ] Parent");
    await capture.scan();
    expect(f.createWeak).toHaveBeenCalledTimes(1);
  });
});

describe("capture retry limits", () => {
  it("bounds automatic failures and retries manually with the same UUID", async () => {
    let now = 1_000_000;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      const f = fixture("- [ ] Parent #todoist");
      f.createWeak.mockRejectedValue(new Error("offline"));
      const capture = f.make();
      await capture.scan();
      const id = f.createWeak.mock.calls[0]![0].id;
      for (let i = 0; i < 10; i++) await capture.scan();
      expect(f.createWeak).toHaveBeenCalledTimes(1);
      now += 30_000;
      await capture.scan();
      now += 60_000;
      await capture.scan();
      now += 1_000_000;
      for (let i = 0; i < 10; i++) await capture.scan();
      expect(f.createWeak).toHaveBeenCalledTimes(3);
      await f.make().scan(true);
      expect(f.createWeak).toHaveBeenCalledTimes(4);
      expect(f.createWeak.mock.calls[3]![0].id).toBe(id);
    } finally {
      clock.mockRestore();
    }
  });
  it("does not create or retry for out-of-scope notes", async () => {
    const f = fixture("- [ ] Parent #todoist");
    f.host.inScope = () => false;
    await f.make().scan();
    expect(f.createWeak).not.toHaveBeenCalled();
  });
  it("does not retry when capture is disabled", async () => {
    const f = fixture("- [ ] Parent #todoist");
    f.createWeak.mockRejectedValue(new Error("offline"));
    await f.make().scan();
    f.host.settings = () => ({ enabled: false, roots: [], accounts: {} });
    await f.make().scan(true);
    expect(f.createWeak).toHaveBeenCalledTimes(1);
  });
});
import { TaskReadError } from "../src/tasks/types";

describe("provider retry time", () => {
  it("respects the provider retry time even for a manual scan", async () => {
    let now = 1_000_000;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      const f = fixture("- [ ] Parent #todoist");
      f.createWeak.mockRejectedValueOnce(
        new TaskReadError("rate limited", now + 90_000),
      );
      await f.make().scan();
      now += 30_000;
      await f.make().scan(true);
      expect(f.createWeak).toHaveBeenCalledTimes(1);
      now += 60_000;
      await f.make().scan(true);
      expect(f.createWeak).toHaveBeenCalledTimes(2);
    } finally {
      clock.mockRestore();
    }
  });
});

describe("in-flight capture source", () => {
  it("links a uniquely moved exact task after readback", async () => {
    const f = fixture("- [ ] Parent #todoist\n- Other");
    f.createWeak.mockImplementationOnce(async () => {
      f.setText("- Other\n- [ ] Parent #todoist");
      return { id: "123" };
    });
    await f.make().scan();
    expect(f.text()).toBe(
      "- Other\n- [ ] Parent [🔗](https://app.todoist.com/app/task/123)",
    );
    expect(f.createWeak).toHaveBeenCalledTimes(1);
  });
  it("reports ambiguous project mappings", async () => {
    const f = fixture("- [ ] Parent #todoist #one #two");
    const errors: string[] = [];
    f.host.report = (message) => errors.push(message);
    f.host.settings = () => ({
      enabled: true,
      roots: [],
      accounts: {
        '["todoist","a"]': {
          defaultProjectId: "p",
          projectMappings: { one: "p", two: "q" },
          labelMappings: {},
        },
      },
    });
    await f.make().scan();
    expect(errors.at(-1)).toContain("several projects");
    expect(f.createWeak).not.toHaveBeenCalled();
  });
});
