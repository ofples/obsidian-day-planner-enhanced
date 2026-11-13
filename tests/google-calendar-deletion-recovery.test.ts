import { webcrypto } from "node:crypto";
import { beforeEach, expect, test, vi } from "vitest";
import {
  recoverCalendarProjection,
  resolveDeletedRemoteConflict,
  syncCalendar,
} from "../src/google-calendar/engine";
import { renderBlock } from "../src/google-calendar/markdown";
import { structuredDescription } from "../src/google-calendar/subtasks";
import type {
  CalendarApi,
  CalendarNotes,
  CalendarSnapshot,
  CalendarSyncState,
  GoogleEvent,
} from "../src/google-calendar/types";
import { defaultSettingsForTests } from "../src/settings";

beforeEach(() => vi.stubGlobal("crypto", webcrypto));
const uid = "a".repeat(32),
  namespace = "b".repeat(32),
  path = "Daily/2026-11-14.md";
const base: CalendarSnapshot = {
  title: "Old",
  start: "2026-11-14T09:00:00.000Z",
  end: "2026-11-14T10:00:00.000Z",
  tags: [],
  subtasks: "",
  description: "",
  colorId: null,
};

test.each(["restore", "accept"] as const)(
  "remote deletion review: %s requires an explicit choice",
  async (choice) => {
    const mine = { ...base, title: "Draft" };
    const local = {
      uid,
      path,
      raw: renderBlock(uid, mine, defaultSettingsForTests),
      snapshot: mine,
    };
    const state: CalendarSyncState = {
      version: 2,
      namespace,
      calendarId: "calendar",
      records: { [uid]: { eventId: "deleted", path, base } },
    };
    let created: GoogleEvent | null = null;
    const api: CalendarApi = {
      list: vi.fn(async () => (created ? [created] : [])),
      get: vi.fn(async (id) => (id === "deleted" ? null : created)),
      create: vi.fn(
        async (id, _uid, value) =>
          (created = {
            id,
            etag: "v1",
            summary: value.title,
            start: { dateTime: value.start },
            end: { dateTime: value.end },
            description: structuredDescription(
              value.description ?? "",
              value.tags ?? [],
              value.subtasks ?? "",
            ),
            extendedProperties: {
              private: { dayPlannerVault: namespace, dayPlannerBlock: uid },
            },
          }),
      ),
      update: vi.fn(async (event) => event),
      remove: vi.fn(async () => {}),
    };
    const notes: CalendarNotes = {
      scan: vi.fn(async () => [local]),
      isUnchanged: vi.fn(async () => true),
      canDelete: vi.fn(async () => false),
      cancel: vi.fn(async () => {}),
      write: vi.fn(async () => local),
    };
    const save = vi.fn(async () => {});
    const run = () =>
      syncCalendar({
        state,
        api,
        notes,
        save,
        canonical: true,
        timeMin: "2026-11-13T00:00:00Z",
        timeMax: "2026-11-20T00:00:00Z",
      });
    const result = await run();
    expect(result.deletedRemote).toHaveLength(1);
    expect(api.create).not.toHaveBeenCalled();
    if (choice === "accept") {
      await resolveDeletedRemoteConflict(
        result.deletedRemote[0]!,
        choice,
        state,
        api,
        notes,
        save,
      );
      expect(notes.cancel).toHaveBeenCalledOnce();
      expect(api.create).not.toHaveBeenCalled();
      expect(api.remove).not.toHaveBeenCalled();
      expect(state.records[uid]?.deleted).toBe(true);
      return;
    }
    const create = vi.mocked(api.create).getMockImplementation()!;
    vi.mocked(api.create).mockImplementationOnce(async (...args) => {
      await create(...args);
      throw new Error("connection lost after creation");
    });
    await expect(
      resolveDeletedRemoteConflict(
        result.deletedRemote[0]!,
        "restore",
        state,
        api,
        notes,
        save,
      ),
    ).rejects.toThrow("connection lost");
    expect(state.pendingCreate?.eventId).toBeTruthy();
    await run();
    expect(api.create).toHaveBeenCalledOnce();
    expect(state.records[uid]?.eventId).not.toBe("deleted");
    expect(state.records[uid]?.pendingConflict).toBeUndefined();
    expect(state.pendingCreate).toBeUndefined();
    expect((await run()).deletedRemote).toEqual([]);
  },
);

test("projection recovery never downgrades a structured baseline", async () => {
  const state: CalendarSyncState = {
    version: 2,
    namespace,
    calendarId: "calendar",
    records: { [uid]: { eventId: "id", path, base: structuredClone(base) } },
  };
  const api = { get: vi.fn() } as unknown as CalendarApi;
  const save = vi.fn();
  await recoverCalendarProjection({
    state,
    api,
    save,
    uid,
    path,
    snapshot: { title: base.title, start: base.start, end: base.end },
  });
  expect(state.records[uid]?.base).toEqual(base);
  expect(api.get).not.toHaveBeenCalled();
  expect(save).not.toHaveBeenCalled();
});
