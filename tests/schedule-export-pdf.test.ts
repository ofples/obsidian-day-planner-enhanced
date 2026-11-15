import { expect, test, vi } from "vitest";

import { writeSchedulePdf } from "../src/ui/schedule-export-pdf";

function fixture() {
  const destroy = vi.fn(),
    loadURL = vi.fn(async () => {}),
    printToPDF = vi.fn(async () => new Uint8Array([1, 2]));
  const create = vi.fn();
  class Window {
    webContents = { printToPDF };
    constructor(options: unknown) {
      create(options);
    }
    loadURL = loadURL;
    destroy = destroy;
  }
  const dialog = {
    showSaveDialog: vi.fn(async () => ({
      canceled: false,
      filePath: "chosen/location.pdf",
    })),
  };
  const write = vi.fn(async () => {});
  return {
    runtime: { BrowserWindow: Window, dialog, write },
    destroy,
    loadURL,
    printToPDF,
    create,
    dialog,
    write,
  };
}

test("PDF uses the selected path and closes its sandboxed print window", async () => {
  const h = fixture();
  expect(
    await writeSchedulePdf("<p>Schedule</p>", "schedule.pdf", h.runtime),
  ).toBe("chosen/location.pdf");
  expect(h.create).toHaveBeenCalledWith(
    expect.objectContaining({
      show: false,
      webPreferences: expect.objectContaining({
        sandbox: true,
        nodeIntegration: false,
        contextIsolation: true,
        javascript: false,
      }),
    }),
  );
  expect(h.loadURL).toHaveBeenCalledWith(
    expect.stringMatching(/^data:text\/html/),
  );
  expect(h.write).toHaveBeenCalledWith(
    "chosen/location.pdf",
    new Uint8Array([1, 2]),
  );
  expect(h.destroy).toHaveBeenCalledOnce();
});

test("PDF cancel creates no window and print failure still closes it", async () => {
  const h = fixture();
  h.dialog.showSaveDialog.mockResolvedValueOnce({
    canceled: true,
    filePath: "",
  });
  expect(await writeSchedulePdf("", "schedule.pdf", h.runtime)).toBeNull();
  expect(h.create).not.toHaveBeenCalled();
  h.printToPDF.mockRejectedValueOnce(new Error("print failed"));
  await expect(writeSchedulePdf("", "schedule.pdf", h.runtime)).rejects.toThrow(
    "print failed",
  );
  expect(h.destroy).toHaveBeenCalledOnce();
  expect(h.write).not.toHaveBeenCalled();
});
