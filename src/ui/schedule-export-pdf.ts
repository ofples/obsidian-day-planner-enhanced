import { Platform } from "obsidian";

interface PrintWindow {
  loadURL(url: string): Promise<void>;
  webContents: {
    printToPDF(options: {
      pageSize: string;
      printBackground: boolean;
      preferCSSPageSize: boolean;
    }): Promise<Uint8Array>;
  };
  destroy(): void;
}

interface PdfRuntime {
  BrowserWindow: new (options: unknown) => PrintWindow;
  dialog: {
    showSaveDialog(
      options: unknown,
    ): Promise<{ canceled: boolean; filePath?: string }>;
  };
  write(path: string, data: Uint8Array): Promise<void>;
}

/** Print in a temporary sandboxed window; never navigate the user's workspace. */
export async function saveSchedulePdf(html: string, defaultPath: string) {
  if (!Platform.isDesktopApp)
    throw new Error("PDF export is available on desktop.");
  // Desktop-only dependency is loaded on demand so mobile can open the export dialog.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const electron = require("electron") as {
    remote?: {
      BrowserWindow?: new (options: unknown) => PrintWindow;
      dialog?: {
        showSaveDialog(
          options: unknown,
        ): Promise<{ canceled: boolean; filePath?: string }>;
      };
    };
  };
  const remote = electron.remote;
  if (!remote?.BrowserWindow || !remote.dialog)
    throw new Error("PDF export is unavailable in this Obsidian version.");
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- Desktop-only native save.
  const fs = require("fs") as typeof import("fs");
  return writeSchedulePdf(html, defaultPath, {
    BrowserWindow: remote.BrowserWindow,
    dialog: remote.dialog,
    write: (path, data) => fs.promises.writeFile(path, data),
  });
}

export async function writeSchedulePdf(
  html: string,
  defaultPath: string,
  runtime: PdfRuntime,
) {
  const result = await runtime.dialog.showSaveDialog({
    defaultPath,
    filters: [{ name: "PDF document", extensions: ["pdf"] }],
  });
  if (result.canceled || !result.filePath) return null;
  const printWindow = new runtime.BrowserWindow({
    show: false,
    webPreferences: {
      sandbox: true,
      nodeIntegration: false,
      contextIsolation: true,
      javascript: false,
    },
  });
  try {
    await printWindow.loadURL(
      `data:text/html;charset=utf-8,${encodeURIComponent(html)}`,
    );
    const pdf = await printWindow.webContents.printToPDF({
      pageSize: "A4",
      printBackground: true,
      preferCSSPageSize: true,
    });
    await runtime.write(result.filePath, pdf);
    return result.filePath;
  } finally {
    printWindow.destroy();
  }
}
