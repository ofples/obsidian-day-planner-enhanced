import { flushSync, mount, unmount } from "svelte";
import { get, writable } from "svelte/store";
import { afterEach, describe, expect, test, vi } from "vitest";

import type { GoogleCalendarSync } from "../src/google-calendar/service";
import { defaultSettingsForTests } from "../src/settings";
import { makeStore } from "../src/redux/store";
import { taskCalendarDisplayUpdated } from "../src/redux/ical/ical-slice";
import { taskCalendarDisplayPolicy } from "../src/tasks/calendar-display";
import { taskAccountKey } from "../src/tasks/capture-settings";
import type { TaskBrowserState, TaskService } from "../src/tasks/service";
import type { TaskSnapshot } from "../src/tasks/types";
import TaskPanelCalendars from "../src/ui/components/task-panel-calendars.svelte";

const snapshot: TaskSnapshot = {
  provider: "todoist",
  account: { id: "one", name: "Fixture", timezone: "UTC" },
  projects: [],
  tasks: [],
  fetchedAt: "2026-11-11T00:00:00Z",
};
const mounted: ReturnType<typeof mount>[] = [];
const subscriptions: (() => void)[] = [];
afterEach(async () => {
  for (const component of mounted.splice(0)) await unmount(component);
  for (const stop of subscriptions.splice(0)) stop();
  document.body.replaceChildren();
});
function render(calendars: GoogleCalendarSync["calendars"] = async () => []) {
  const config = structuredClone(defaultSettingsForTests);
  config.icals = [
    {
      name: "Todoist feed",
      url: "https://example.test/private.ics",
      color: "#123456",
    },
  ];
  config.taskCapture.accounts[taskAccountKey(snapshot)] = {
    defaultProjectId: "work",
    projectMappings: { work: "work" },
    labelMappings: { errands: "Errands" },
    calendarDisplay: {
      enabled: true,
      googleCalendarIds: ["saved-missing"],
      icalUrls: ["https://example.test/unavailable.ics"],
    },
  };
  const settings = writable(config);
  const state = writable<TaskBrowserState>({
    snapshot,
    connected: true,
    loading: false,
    error: "",
    writable: true,
    aliases: {},
    operations: [],
    completed: [],
  });
  const saved = vi.fn(),
    cancel = vi.fn();
  const store = makeStore({});
  subscriptions.push(
    settings.subscribe((config) => {
      store.dispatch(
        taskCalendarDisplayUpdated(
          taskCalendarDisplayPolicy(get(state), config.taskCapture),
        ),
      );
    }),
  );
  const target = document.createElement("div");
  document.body.append(target);
  mounted.push(
    mount(TaskPanelCalendars, {
      target,
      props: {
        service: { state } as unknown as TaskService,
        calendar: { calendars },
        settings,
        saved,
        cancel,
      },
    }),
  );
  flushSync();
  const button = (text: string) =>
    Array.from(target.querySelectorAll<HTMLButtonElement>("button")).find(
      (item) => item.textContent === text,
    )!;
  const submit = () => {
    target
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
    flushSync();
  };
  return { target, settings, state, saved, cancel, button, submit };
}

describe("custom task calendar settings", () => {
  test("saves exact selections, retained unavailable feeds and current unrelated settings", async () => {
    const h = render(async () => [
      { id: "selected", summary: "Todoist", selected: true },
      { id: "similar", summary: "Todoist shared", selected: true },
    ]);
    h.button("Load calendars").click();
    await vi.waitFor(() =>
      expect(h.target.textContent).toContain("Todoist shared"),
    );
    expect(h.target.textContent).toContain("Unavailable saved Google calendar");
    expect(h.target.textContent).toContain(
      "Unavailable saved internet calendar",
    );
    h.target
      .querySelector<HTMLInputElement>('input[value="selected"]')!
      .click();
    h.target
      .querySelector<HTMLInputElement>(
        'input[value="https://example.test/private.ics"]',
      )!
      .click();
    h.settings.update((value) => ({
      ...value,
      taskCapture: { ...value.taskCapture, roots: ["Planning"] },
    }));
    h.submit();
    const config = get(h.settings);
    const account = config.taskCapture.accounts[taskAccountKey(snapshot)]!;
    expect(account.calendarDisplay).toEqual({
      enabled: true,
      googleCalendarIds: ["selected", "saved-missing"],
      icalUrls: [
        "https://example.test/private.ics",
        "https://example.test/unavailable.ics",
      ],
    });
    expect(account.projectMappings).toEqual({ work: "work" });
    expect(account.labelMappings).toEqual({ errands: "Errands" });
    expect(config.taskCapture.roots).toEqual(["Planning"]);
    expect(h.saved).toHaveBeenCalledOnce();
    expect(h.target.textContent).not.toContain(
      "https://example.test/private.ics",
    );
  });
  test("cancel leaves settings byte-equivalent", () => {
    const h = render();
    const before = JSON.stringify(get(h.settings));
    h.target.querySelector<HTMLInputElement>('input[role="switch"]')!.click();
    h.button("Cancel").click();
    expect(h.cancel).toHaveBeenCalledOnce();
    expect(JSON.stringify(get(h.settings))).toBe(before);
    expect(h.saved).not.toHaveBeenCalled();
  });
  test("account replacement blocks saves and late calendar results", async () => {
    let finish!: (
      value: Awaited<ReturnType<GoogleCalendarSync["calendars"]>>,
    ) => void;
    const h = render(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const before = JSON.stringify(get(h.settings));
    h.button("Load calendars").click();
    h.state.update((value) => ({
      ...value,
      snapshot: { ...snapshot, account: { ...snapshot.account, id: "two" } },
    }));
    finish([{ id: "private", summary: "Late calendar", selected: true }]);
    await vi.waitFor(() =>
      expect(h.target.textContent).toContain("Reopen task calendar settings"),
    );
    expect(h.target.textContent).not.toContain("Late calendar");
    h.submit();
    expect(h.saved).not.toHaveBeenCalled();
    expect(JSON.stringify(get(h.settings))).toBe(before);
  });
  test("calendar load failure leaves saved choices available and permits retry", async () => {
    const calendars = vi
      .fn<GoogleCalendarSync["calendars"]>()
      .mockRejectedValueOnce(new Error("Connect Google Calendar first"))
      .mockResolvedValueOnce([]);
    const h = render(calendars);
    h.button("Load calendars").click();
    await vi.waitFor(() =>
      expect(h.target.textContent).toContain("Connect Google Calendar first"),
    );
    expect(
      h.target.querySelector<HTMLInputElement>('input[value="saved-missing"]')
        ?.checked,
    ).toBe(true);
    h.button("Load calendars").click();
    await vi.waitFor(() =>
      expect(h.target.textContent).toContain(
        "Unavailable saved Google calendar",
      ),
    );
    h.submit();
    expect(h.saved).toHaveBeenCalledOnce();
  });
});
