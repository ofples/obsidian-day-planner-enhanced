import { describe, expect, it, vi } from "vitest";
import { parseCaptureCandidates } from "../src/tasks/capture-parser";
import { WeakTaskSync, type WeakSyncHost } from "../src/tasks/weak-sync";
import type { ProviderTask } from "../src/tasks/types";

const task: ProviderTask = {
  id: "abc",
  title: "Remote",
  description: "",
  projectId: "p",
  parentId: null,
  labels: [],
  priority: 1,
  completed: false,
  order: 1,
  due: null,
};
const link = "[🔗](https://app.todoist.com/app/task/abc)";
function fixture(initial: string, remote = task) {
  let text = initial;
  let current = remote;
  const change = vi.fn(async () => {});
  const host: WeakSyncHost = {
    candidates: () => parseCaptureCandidates("note.md", text),
    tasks: () => [current],
    enabled: () => true,
    read: async () => text,
    write: async (_path, before, after) => {
      if (before !== text) return false;
      text = after;
      return true;
    },
    getTask: async () => null,
    change,
  };
  return {
    sync: new WeakTaskSync(host),
    change,
    setText: (value: string) => {
      text = value;
    },
    setTask: (value: ProviderTask) => {
      current = value;
    },
    text: () => text,
  };
}
describe("weak task sync", () => {
  it("seeds a checked historical task without closing it", async () => {
    const f = fixture(`- [x] Remote ${link}`);
    await f.sync.scan();
    expect(f.change).not.toHaveBeenCalled();
  });
  it("pushes a later checkbox edit once for duplicate links", async () => {
    const f = fixture(`- [ ] Remote ${link}\n- [ ] Remote ${link}`);
    await f.sync.scan();
    f.setText(`- [x] Remote ${link}\n- [x] Remote ${link}`);
    await f.sync.scan();
    expect(f.change).toHaveBeenCalledTimes(1);
  });
  it("pulls a remote rename and preserves nested lines", async () => {
    const f = fixture(`- [ ] Remote ${link}\n  - [ ] Child`);
    await f.sync.scan();
    f.setTask({ ...task, title: "New" });
    await f.sync.scan();
    expect(f.text()).toContain(`- [ ] New ${link}\n  - [ ] Child`);
  });
  it("never closes a different recurring occurrence", async () => {
    const recurring = {
      ...task,
      completionCount: 2,
      due: {
        date: "2026-11-14",
        recurring: true,
        text: "daily",
        timezone: null,
      },
    };
    const old =
      '[🔗](https://app.todoist.com/app/task/abc "Todoist occurrence=1")';
    const f = fixture(`- [ ] Remote ${old}`, recurring);
    await f.sync.scan();
    f.setText(`- [x] Remote ${old}`);
    await f.sync.scan();
    expect(f.change).not.toHaveBeenCalled();
  });
});

describe("local note metadata", () => {
  it("omits time and tags from a pushed title", async () => {
    const f = fixture(`- [ ] 09:00 - 10:00 Remote #work #locked ${link}`);
    await f.sync.scan();
    f.setText(`- [ ] 09:00 - 10:00 Changed #work #locked ${link}`);
    await f.sync.scan();
    expect(f.change).toHaveBeenCalledWith(task, { title: "Changed" });
  });
  it("preserves time, tags and link position when pulling a title", async () => {
    const f = fixture(`- [ ] 09:00 - 10:00 Remote ${link} #work #locked`);
    await f.sync.scan();
    f.setTask({ ...task, title: "New title" });
    await f.sync.scan();
    expect(f.text()).toBe(
      `- [ ] 09:00 - 10:00 New title ${link} #work #locked`,
    );
  });
  it("checks the previous occurrence when the remote count advances", async () => {
    const recurring = {
      ...task,
      completionCount: 1,
      due: {
        date: "2026-11-14",
        recurring: true,
        text: "daily",
        timezone: null,
      },
    };
    const old =
      '[🔗](https://app.todoist.com/app/task/abc "Todoist occurrence=1")';
    const f = fixture(`- [ ] Remote ${old}`, recurring);
    await f.sync.scan();
    f.setTask({ ...recurring, completionCount: 2 });
    await f.sync.scan();
    expect(f.text()).toBe(`- [x] Remote ${old}`);
    expect(f.change).not.toHaveBeenCalled();
  });
});

describe("failed changes", () => {
  it("does not retry an unchanged local edit on later scans", async () => {
    let text = `- [ ] Remote ${link}`;
    const change = vi.fn(async () => {
      throw new Error("offline");
    });
    const sync = new WeakTaskSync({
      candidates: () => parseCaptureCandidates("note.md", text),
      tasks: () => [task],
      enabled: () => true,
      read: async () => text,
      write: async () => false,
      getTask: async () => null,
      change,
    });
    await sync.scan();
    text = `- [ ] Changed ${link}`;
    await sync.scan();
    await sync.scan();
    expect(change).toHaveBeenCalledTimes(1);
  });
});
