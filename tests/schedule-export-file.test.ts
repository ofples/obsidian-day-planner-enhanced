import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";

import type { App } from "obsidian";
import { expect, test, vi } from "vitest";

import {
  saveScheduleExport,
  scheduleExportDestination,
} from "../src/ui/schedule-export-file";

vi.mock("obsidian", () => ({ Platform: { isDesktopApp: true } }));

function fixture() {
  const entries = new Map<
    string,
    { path: string; children?: unknown[]; bytes?: ArrayBuffer }
  >();
  const createFolder = vi.fn(async (path: string) => {
    entries.set(path, { path, children: [] });
  });
  const createBinary = vi.fn(async (path: string, bytes: ArrayBuffer) => {
    if (entries.has(path)) throw new Error("File already exists.");
    const file = { path, bytes };
    entries.set(path, file);
    return file;
  });
  return {
    entries,
    createBinary,
    createFolder,
    app: {
      vault: {
        getAbstractFileByPath: (path: string) => entries.get(path),
        createFolder,
        createBinary,
      },
    } as unknown as App,
  };
}
const bytes = Uint8Array.from([1, 2, 3]).buffer;

test("export destinations support vault folders, desktop paths and a default", () => {
  expect(scheduleExportDestination(" ")).toEqual({
    external: false,
    folder: "Schedule Exports",
  });
  expect(scheduleExportDestination(" ./Shares\\Schedules/ ")).toEqual({
    external: false,
    folder: "Shares/Schedules",
  });
  expect(scheduleExportDestination(".")).toEqual({
    external: false,
    folder: "",
  });
  for (const folder of [
    "C:\\Shares\\Schedules",
    "\\\\server\\exports",
    "/home/user/exports",
  ])
    expect(scheduleExportDestination(folder).external).toBe(true);
  expect(() => scheduleExportDestination("../outside")).toThrow(
    "full filesystem path",
  );
  expect(() => scheduleExportDestination("C:relative")).toThrow(
    "full filesystem path",
  );
});

test("PNG and PDF create nested vault folders and preserve repeated exports", async () => {
  const h = fixture();
  const results = await Promise.all([
    saveScheduleExport(h.app, "Shared/Schedules", "schedule.png", bytes),
    saveScheduleExport(h.app, "Shared/Schedules", "schedule.png", bytes),
  ]);
  expect(results.map((item) => item.path).sort()).toEqual([
    "Shared/Schedules/schedule-2.png",
    "Shared/Schedules/schedule.png",
  ]);
  expect(
    (await saveScheduleExport(h.app, "Shared/Schedules", "schedule.pdf", bytes))
      .path,
  ).toBe("Shared/Schedules/schedule.pdf");
  expect(h.entries.get("Shared/Schedules/schedule.png")?.bytes).toBe(bytes);
  expect(h.entries.get("Shared")?.children).toEqual([]);
});

test("root exports work and destination-file errors reach the user", async () => {
  const h = fixture();
  expect(
    (await saveScheduleExport(h.app, ".", "schedule.png", bytes)).path,
  ).toBe("schedule.png");
  expect(h.createFolder).not.toHaveBeenCalled();
  h.entries.set("blocked", { path: "blocked" });
  await expect(
    saveScheduleExport(h.app, "blocked/exports", "schedule.pdf", bytes),
  ).rejects.toThrow("destination is a file");
});

test("write failures stop immediately even if a partial file appeared", async () => {
  const h = fixture();
  h.createBinary.mockImplementationOnce(async (path) => {
    h.entries.set(path, { path });
    throw new Error("Disk full");
  });
  await expect(
    saveScheduleExport(h.app, ".", "schedule.png", bytes),
  ).rejects.toThrow("Disk full");
  expect(h.createBinary).toHaveBeenCalledOnce();
});

test("desktop exports create the chosen folder and use exclusive filenames", async () => {
  const directory = await mkdtemp(join(tmpdir(), "day-planner-export-"));
  try {
    const folder = join(directory, "nested");
    const h = fixture();
    const results = await Promise.all([
      saveScheduleExport(h.app, folder, "schedule.pdf", bytes),
      saveScheduleExport(h.app, folder, "schedule.pdf", bytes),
    ]);
    expect(new Set(results.map((item) => item.path)).size).toBe(2);
    expect(await readdir(folder)).toEqual(["schedule-2.pdf", "schedule.pdf"]);
    expect(new Uint8Array(await readFile(results[0]!.path))).toEqual(
      new Uint8Array(bytes),
    );
    expect(h.createBinary).not.toHaveBeenCalled();
  } finally {
    if (!resolve(directory).startsWith(resolve(tmpdir()) + sep))
      throw new Error("Unexpected temporary export path");
    await rm(directory, { recursive: true, force: true });
  }
});
