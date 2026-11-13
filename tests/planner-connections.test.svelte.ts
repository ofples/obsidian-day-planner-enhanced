import { flushSync, mount, unmount } from "svelte";
import { writable } from "svelte/store";
import { afterEach, expect, test, vi } from "vitest";

import type { GoogleCalendarSync } from "../src/google-calendar/service";
import type { TaskService } from "../src/tasks/service";
import Connections from "../src/ui/components/planner-connections.svelte";

let component: ReturnType<typeof mount> | undefined;
afterEach(async () => {
  if (component) await unmount(component);
  component = undefined;
  document.body.replaceChildren();
});

test("focuses Google sign-in and shows independent busy and error states", async () => {
  const target = document.createElement("div"),
    state = writable({ connected: false, snapshot: null });
  document.body.append(target);
  let rejectGoogle!: (error: Error) => void;
  const connect = vi.fn(
    () =>
      new Promise<void>((_resolve, reject) => {
        rejectGoogle = reject;
      }),
  );
  const signIn = vi.fn(async () => {}),
    close = vi.fn();
  component = mount(Connections, {
    target,
    props: {
      service: { state, signIn } as unknown as TaskService,
      calendar: {
        isConnected: () => false,
        connect,
      } as unknown as GoogleCalendarSync,
      close,
    },
  });
  flushSync();
  const buttons = Array.from(target.querySelectorAll("button"));
  const google = buttons.find((button) =>
    button.textContent?.includes("Sign in with Google"),
  )!;
  const todoist = buttons.find((button) =>
    button.textContent?.includes("Sign in with Todoist"),
  )!;
  expect(document.activeElement).toBe(google);
  google.click();
  flushSync();
  expect(connect).toHaveBeenCalledExactlyOnceWith(true);
  expect(google.disabled).toBe(true);
  expect(todoist.disabled).toBe(false);
  todoist.click();
  expect(signIn).toHaveBeenCalledOnce();
  rejectGoogle(new Error("Sign-in cancelled"));
  await vi.waitFor(() =>
    expect(target.querySelector('[role="alert"]')?.textContent).toBe(
      "Sign-in cancelled",
    ),
  );
  expect(google.disabled).toBe(false);
  target
    .querySelector<HTMLButtonElement>('[aria-label="Close connections"]')!
    .click();
  expect(close).toHaveBeenCalledOnce();
});

test("shows connected Todoist account and successful Google connection", async () => {
  const target = document.createElement("div");
  document.body.append(target);
  const state = writable({
    connected: true,
    snapshot: { account: { name: "Example account" } },
  });
  let connected = false;
  const signIn = vi.fn(async () => {});
  const disconnect = vi.fn(() =>
    state.update((value) => ({ ...value, connected: false })),
  );
  const calendar = {
    isConnected: () => connected,
    connect: async () => {
      connected = true;
    },
    disconnect: vi.fn(() => {
      connected = false;
    }),
  };
  component = mount(Connections, {
    target,
    props: {
      service: { state, signIn, disconnect } as unknown as TaskService,
      calendar: calendar as unknown as GoogleCalendarSync,
      close: vi.fn(),
    },
  });
  flushSync();
  expect(target.textContent).toContain("Connected as Example account");
  expect(target.querySelector("details")).toBeNull();
  Array.from(target.querySelectorAll(".connection-card"))[1]!
    .querySelector<HTMLButtonElement>("button")!
    .click();
  expect(disconnect).toHaveBeenCalledOnce();
  flushSync();
  target
    .querySelector<HTMLButtonElement>('[aria-label="Sign in with Todoist"]')!
    .click();
  expect(signIn).toHaveBeenCalledExactlyOnceWith(true);
  Array.from(target.querySelectorAll("button"))
    .find((button) => button.textContent?.includes("Sign in with Google"))!
    .click();
  await vi.waitFor(() =>
    expect(target.querySelector(".connection-card p")?.textContent).toContain(
      "Connected",
    ),
  );
  expect(
    target.querySelector<HTMLButtonElement>(".connection-card button")
      ?.textContent,
  ).toContain("Sign out");
  target
    .querySelector<HTMLButtonElement>(
      '[aria-label="Sign out of Google Calendar"]',
    )!
    .click();
  expect(calendar.disconnect).toHaveBeenCalledOnce();
});
