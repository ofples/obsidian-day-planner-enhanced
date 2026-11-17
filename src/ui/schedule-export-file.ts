import { Platform, type App, type TFile } from "obsidian";

export const defaultScheduleExportFolder = "Schedule Exports";

export function scheduleExportDestination(value: string) {
  const folder = value.trim() || defaultScheduleExportFolder;
  if (folder.includes("\0")) throw new Error("Choose a valid export folder.");
  if (/^(?:[a-z]:[\\/]|[\\/]{2}|\/)/i.test(folder))
    return { external: true, folder };
  const parts = folder
    .replace(/\\/g, "/")
    .split("/")
    .filter((part) => part && part !== ".");
  if (parts.includes("..") || /^[a-z]:/i.test(folder))
    throw new Error(
      "Use a vault folder or a full filesystem path for exports.",
    );
  return { external: false, folder: parts.join("/") };
}

/** Each create is exclusive so repeated or concurrent exports preserve existing files. */
export async function saveScheduleExport(
  app: App,
  folder: string,
  name: string,
  data: ArrayBuffer,
): Promise<{ path: string; file?: TFile }> {
  const destination = scheduleExportDestination(folder);
  const extension = name.lastIndexOf(".");
  const candidate = (index: number) =>
    index === 1
      ? name
      : `${name.slice(0, extension)}-${index}${name.slice(extension)}`;
  if (destination.external) {
    if (!Platform.isDesktopApp)
      throw new Error(
        "Filesystem export folders are available on desktop. Choose a vault folder on this device.",
      );
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- Native filesystem paths are desktop-only.
    const fs = require("node:fs") as typeof import("node:fs");
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- Keep native path handling out of mobile startup.
    const path = require("node:path") as typeof import("node:path");
    await fs.promises.mkdir(destination.folder, { recursive: true });
    for (let index = 1; ; index++) {
      const target = path.join(destination.folder, candidate(index));
      try {
        await fs.promises.writeFile(target, new Uint8Array(data), {
          flag: "wx",
        });
        return { path: target };
      } catch (error) {
        if (
          !(error instanceof Error) ||
          !("code" in error) ||
          error.code !== "EEXIST"
        )
          throw error;
      }
    }
  }
  let parent = "";
  for (const part of destination.folder.split("/").filter(Boolean)) {
    parent = parent ? `${parent}/${part}` : part;
    if (!app.vault.getAbstractFileByPath(parent)) {
      try {
        await app.vault.createFolder(parent);
      } catch (error) {
        if (!app.vault.getAbstractFileByPath(parent)) throw error;
      }
    }
    const entry = app.vault.getAbstractFileByPath(parent);
    if (entry && !("children" in entry))
      throw new Error(`The export destination is a file: ${parent}`);
  }
  for (let index = 1; ; index++) {
    const target = [destination.folder, candidate(index)]
      .filter(Boolean)
      .join("/");
    if (app.vault.getAbstractFileByPath(target)) continue;
    try {
      const file = await app.vault.createBinary(target, data);
      return { path: file.path, file };
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !/already exists/i.test(error.message) ||
        !app.vault.getAbstractFileByPath(target)
      )
        throw error;
    }
  }
}
