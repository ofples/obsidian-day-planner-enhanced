import { describe, expect, test, vi } from "vitest";

import { TransactionWriter } from "../../src/service/diff-writer";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("native note transaction visibility", () => {
  test("the edit and undo fence covers every file and resumes once all settle", async () => {
    const release = deferred();
    const texts = new Map([
      ["Old.md", "Parent"],
      ["New.md", ""],
    ]);
    let hold = true;
    const editFile = async (path: string, update: (text: string) => string) => {
      const next = update(texts.get(path)!);
      if (hold && path === "New.md") await release.promise;
      texts.set(path, next);
    };
    const settled = vi.fn();
    const writer = new TransactionWriter({ editFile }, settled);
    const write = writer.writeTransaction([
      { path: "Old.md", updateFn: () => "" },
      { path: "New.md", updateFn: () => "Parent" },
    ]);
    await Promise.resolve();
    expect(texts.get("Old.md")).toBe("");
    expect(writer.isWriting).toBe(true);
    expect(writer.revision).toBe(1);
    expect(settled).not.toHaveBeenCalled();
    release.resolve();
    await write;
    expect(writer.isWriting).toBe(false);
    expect(writer.revision).toBe(2);
    expect(settled).toHaveBeenCalledTimes(1);
    hold = false;
    const undo = writer.undo();
    expect(writer.isWriting).toBe(true);
    await undo;
    expect(writer.revision).toBe(4);
    expect(writer.isWriting).toBe(false);
    expect(texts).toEqual(
      new Map([
        ["Old.md", "Parent"],
        ["New.md", ""],
      ]),
    );
    expect(settled).toHaveBeenCalledTimes(2);
  });

  test("one failed write keeps other pending writes fenced until they settle", async () => {
    const release = deferred();
    const failure = new Error("Unavailable note");
    const editFile = async (path: string) => {
      if (path === "Old.md") throw failure;
      await release.promise;
    };
    const settled = vi.fn();
    const writer = new TransactionWriter({ editFile }, settled);
    const result = writer
      .writeTransaction([
        { path: "Old.md", updateFn: () => "" },
        { path: "New.md", updateFn: () => "Parent" },
      ])
      .catch((error: unknown) => error);
    await Promise.resolve();
    await Promise.resolve();
    expect(writer.isWriting).toBe(true);
    expect(settled).not.toHaveBeenCalled();
    release.resolve();
    expect(await result).toBe(failure);
    expect(writer.isWriting).toBe(false);
    expect(settled).toHaveBeenCalledTimes(1);
  });
});
