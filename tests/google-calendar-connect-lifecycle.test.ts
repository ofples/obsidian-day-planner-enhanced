import type { Plugin } from "obsidian";
import { afterEach, expect, test, vi } from "vitest";
import { GoogleCalendarSync } from "../src/google-calendar/service";
import type { AppStore } from "../src/redux/store";
import type { PeriodicNotes } from "../src/service/periodic-notes";
import { defaultSettingsForTests } from "../src/settings";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function setup() {
  const service = new GoogleCalendarSync(
    { app: {} } as Plugin,
    {} as PeriodicNotes,
    () => defaultSettingsForTests,
    {} as AppStore,
  );
  const connect = vi.fn(async () => {});
  Reflect.set(service, "auth", { connect });
  Reflect.set(service, "busy", true);
  vi.spyOn(service, "resetForUserRetry").mockReturnValue(true);
  vi.spyOn(service, "refreshView").mockResolvedValue();
  return { service, connect };
}

test("sign-in waits for the current operation then opens once", async () => {
  vi.useFakeTimers();
  const { service, connect } = setup();
  const pending = service.connect(true);
  await vi.advanceTimersByTimeAsync(700);
  expect(connect).not.toHaveBeenCalled();
  Reflect.set(service, "busy", false);
  await vi.advanceTimersByTimeAsync(100);
  await pending;
  expect(connect).toHaveBeenCalledOnce();
});

test("sign-in stops waiting after 30 seconds", async () => {
  vi.useFakeTimers();
  const { service, connect } = setup();
  const pending = service.connect(true);
  const rejected = expect(pending).rejects.toThrow("already running");
  await vi.advanceTimersByTimeAsync(30_000);
  await rejected;
  expect(connect).not.toHaveBeenCalled();
});
