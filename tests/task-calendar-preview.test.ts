import { DateTime } from "luxon";
import { describe, expect, test } from "vitest";

import { defaultSettingsForTests } from "../src/settings";
import type { EditableTimeBlock } from "../src/time-block-types";
import { taskAccountKey } from "../src/tasks/capture-settings";
import { taskCalendarPreviews } from "../src/tasks/calendar-preview";
import type { TaskRegistryState } from "../src/tasks/registry";
import type { ProviderTask, TaskSnapshot } from "../src/tasks/types";

const task = (id: string, patch: Partial<ProviderTask> = {}): ProviderTask => ({
  id,
  title: `Task ${id}`,
  description: "Saved description",
  projectId: "work",
  parentId: null,
  labels: [],
  priority: 1,
  completed: false,
  order: 1,
  due: {
    date: "2026-11-13T09:30:00Z",
    recurring: false,
    text: "",
    timezone: null,
  },
  ...patch,
});

const snapshot = (
  tasks: ProviderTask[],
  accountId = "account",
): TaskSnapshot => ({
  provider: "todoist",
  account: { id: accountId, name: "Fixture", timezone: "America/New_York" },
  projects: [{ id: "work", name: "Work", order: 1, inbox: true }],
  tasks,
  fetchedAt: "2026-11-13T00:00:00Z",
});

const settings = structuredClone(defaultSettingsForTests);
settings.defaultDurationMinutes = 45;
settings.taskCapture.accounts[taskAccountKey(snapshot([]))] = {
  defaultProjectId: "work",
  projectMappings: { office: "work" },
  labelMappings: { focus: "deep" },
};

const link = (base: ProviderTask, accountId = "account") => ({
  provider: "todoist",
  accountId,
  taskId: base.id,
  source: {
    path: "fixture.md",
    from: 0,
    raw: "- [ ] 09:00 - 09:30 Fixture",
    title: "Fixture",
  },
  base,
});
const registry = (links: TaskRegistryState["links"] = {}) => ({ links });

describe("Todoist calendar previews", () => {
  test("projects timed tasks with stable account-scoped identity, mappings and task duration", () => {
    const data = snapshot([
      task("one", {
        labels: ["deep"],
        duration: { amount: 75, unit: "minute" },
      }),
    ]);
    const browser = { connected: true, snapshot: data };
    const before = structuredClone({ browser, settings });
    const [preview] = taskCalendarPreviews(browser, registry(), settings);
    expect(preview).toMatchObject({
      source: "ical",
      summary: "Task one",
      taskSource: { provider: "todoist", accountId: "account", taskId: "one" },
      durationMinutes: 75,
    });
    expect(preview?.description).toContain("#todoist");
    expect(preview?.description).toContain("#office");
    expect(preview?.description).toContain("#focus");
    expect(preview?.startTime.valueOf()).toBe(
      Date.parse("2026-11-13T09:30:00Z"),
    );
    expect(taskCalendarPreviews(browser, registry(), settings)[0]?.id).toBe(
      preview?.id,
    );
    expect(
      taskCalendarPreviews(
        { connected: true, snapshot: snapshot([data.tasks[0]!], "other") },
        registry(),
        settings,
      )[0]?.id,
    ).not.toBe(preview?.id);
    expect({ browser, settings }).toEqual(before);
  });

  test("retains a date-only local day as an all-day preview", () => {
    const dated = task("day", {
      due: { date: "2026-11-13", recurring: false, text: "", timezone: null },
    });
    const [preview] = taskCalendarPreviews(
      { connected: true, snapshot: snapshot([dated]) },
      registry(),
      settings,
    );
    expect(preview?.isAllDayEvent).toBe(true);
    expect(preview?.startTime.format("YYYY-MM-DD")).toBe("2026-11-13");
  });

  test("uses task duration in days as minutes and account timezone for floating due values", () => {
    const dated = task("day-duration", {
      duration: { amount: 2, unit: "day" },
      due: {
        date: "2026-11-13T09:30:00",
        recurring: false,
        text: "",
        timezone: null,
      },
    });
    const [preview] = taskCalendarPreviews(
      { connected: true, snapshot: snapshot([dated]) },
      registry(),
      settings,
    );
    expect(preview?.durationMinutes).toBe(2880);
    expect(preview?.startTime.valueOf()).toBe(
      DateTime.fromISO("2026-11-13T09:30:00", {
        zone: "America/New_York",
      }).toMillis(),
    );
  });

  test.each([
    [
      "2026-11-13T09:30:00Z",
      "Asia/Kolkata",
      Date.parse("2026-11-13T09:30:00Z"),
    ],
    [
      "2026-11-13T09:30:00+05:30",
      "Asia/Kolkata",
      Date.parse("2026-11-13T09:30:00+05:30"),
    ],
    [
      "2026-11-13T09:30:00",
      "America/New_York",
      DateTime.fromISO("2026-11-13T09:30:00", {
        zone: "America/New_York",
      }).toMillis(),
    ],
  ])(
    "resolves timed value %s in its applicable timezone",
    (date, timezone, expected) => {
      const due = { date, timezone, recurring: false, text: "" };
      const [preview] = taskCalendarPreviews(
        { connected: true, snapshot: snapshot([task("timed", { due })]) },
        registry(),
        settings,
      );
      expect(preview?.startTime.valueOf()).toBe(expected);
      expect(preview?.isAllDayEvent).not.toBe(true);
      expect(preview?.durationMinutes).toBe(45);
    },
  );

  test("omits disconnected, missing, completed, provisional and malformed tasks", () => {
    const data = snapshot([
      task("valid"),
      task("completed", { completed: true }),
      task("no-date", { due: null }),
      task("local-pending"),
      task("invalid", {
        due: { date: "2026-02-30", recurring: false, text: "", timezone: null },
      }),
      task("bad-zone", {
        due: {
          date: "2026-11-13T09:30:00",
          recurring: false,
          text: "",
          timezone: "Invalid/Zone",
        },
      }),
    ]);
    expect(
      taskCalendarPreviews(
        { connected: false, snapshot: data },
        registry(),
        settings,
      ),
    ).toEqual([]);
    expect(
      taskCalendarPreviews(
        { connected: true, snapshot: null },
        registry(),
        settings,
      ),
    ).toEqual([]);
    expect(
      taskCalendarPreviews(
        { connected: true, snapshot: data },
        registry(),
        settings,
      ).map((item) => item.taskSource?.taskId),
    ).toEqual(["valid"]);
  });

  test("suppresses active same-account links, including nested tasks, without suppressing another account", () => {
    const parent = task("parent");
    const child = task("child", { parentId: parent.id });
    const other = task("other");
    const links = registry({
      parent: link(parent),
      child: {
        ...link(child),
        source: { ...link(child).source, from: 35, raw: "- [ ] Child" },
      },
      other: link(other, "other-account"),
    });
    const before = structuredClone(links);
    const previews = taskCalendarPreviews(
      { connected: true, snapshot: snapshot([parent, child, other]) },
      links,
      settings,
      [
        {
          id: "parent-block",
          source: "dailyNoteDate",
          path: "fixture.md",
          startTime: window.moment(),
          position: {
            start: { line: 0, col: 0, offset: 0 },
            end: { line: 2, col: 0, offset: 80 },
          },
        } as EditableTimeBlock,
      ],
    );
    expect(previews.map((item) => item.taskSource?.taskId)).toEqual(["other"]);
    expect(links).toEqual(before);
  });

  test("an untimed linked task outside concrete local blocks still appears", () => {
    const dated = task("untimed-link");
    const links = registry({
      linked: {
        ...link(dated),
        source: { ...link(dated).source, raw: "- [ ] Fixture" },
      },
    });
    const previews = taskCalendarPreviews(
      { connected: true, snapshot: snapshot([dated]) },
      links,
      settings,
      [],
    );
    expect(previews.map((item) => item.taskSource?.taskId)).toEqual([
      "untimed-link",
    ]);
  });

  test("a timed projection suppresses an untimed source preview", () => {
    const dated = task("projected");
    const source = { ...link(dated).source, raw: "- [ ] Fixture" };
    const records = {
      links: { linked: { ...link(dated), source } },
      projections: {
        linked: {
          provider: "todoist",
          accountId: "account",
          taskId: dated.id,
          linkUid: "linked",
          occurrenceKey: "single",
          source,
          interval: {
            start: "2026-11-13T09:30:00Z",
            end: "2026-11-13T10:30:00Z",
          },
          base: dated,
        },
      },
    };
    expect(
      taskCalendarPreviews(
        { connected: true, snapshot: snapshot([dated]) },
        records,
        settings,
      ),
    ).toEqual([]);
  });

  test("an active link without an acknowledged baseline still suppresses its duplicate preview", () => {
    const dated = task("pending-link");
    const links = registry({ pending: { ...link(dated), base: null } });
    expect(
      taskCalendarPreviews(
        { connected: true, snapshot: snapshot([dated]) },
        links,
        settings,
      ),
    ).toEqual([]);
  });

  test("a recurring prior occurrence does not hide the current occurrence", () => {
    const current = task("recurring", {
      completionCount: 2,
      due: {
        date: "2026-11-13",
        recurring: true,
        text: "every day",
        timezone: "America/New_York",
      },
    });
    const earlier = {
      ...current,
      completionCount: 1,
      due: { ...current.due!, date: "2026-11-12" },
    };
    const browser = { connected: true, snapshot: snapshot([current]) };
    expect(
      taskCalendarPreviews(
        browser,
        registry({ previous: link(earlier) }),
        settings,
      ),
    ).toHaveLength(1);
    expect(
      taskCalendarPreviews(
        browser,
        registry({ active: link(current) }),
        settings,
      ),
    ).toHaveLength(0);
    const legacy = { ...current, completionCount: undefined };
    expect(
      taskCalendarPreviews(
        browser,
        registry({ active: link(legacy) }),
        settings,
      ),
    ).toHaveLength(0);
    expect(
      taskCalendarPreviews(
        browser,
        registry({
          previous: link({ ...earlier, completionCount: undefined }),
        }),
        settings,
      ),
    ).toHaveLength(1);
  });
});
