import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { afterEach, expect, test, vi } from "vitest";

const { executeMock } = vi.hoisted(() => ({ executeMock: vi.fn() }));
vi.mock("node:child_process", () => ({
  execFile: Object.assign(vi.fn(), {
    [Symbol.for("nodejs.util.promisify.custom")]: executeMock,
  }),
}));

import {
  invokePlanner,
  parseOptions,
  parseResult,
} from "../skills/day-planner-ai/scripts/day-planner-ai.mjs";

afterEach(() => {
  executeMock.mockReset();
  vi.unstubAllEnvs();
});

const options = {
  command: "context",
  vault: 'A vault $(literal) "name"',
  cli: "obsidian-cli",
};
const nodeRequire = createRequire(import.meta.url);

test("commands require an explicit vault and expose only preparation operations", () => {
  vi.stubEnv("OBSIDIAN_CLI", "custom-cli");
  expect(parseOptions(["context", "--vault", "Planning"])).toMatchObject({
    command: "context",
    vault: "Planning",
    cli: "custom-cli",
  });
  expect(
    parseOptions([
      "propose",
      "--vault",
      "Planning",
      "--cli",
      "other-cli",
      "--input",
      "proposal.json",
    ]),
  ).toMatchObject({ cli: "other-cli", input: "proposal.json" });
  expect(() => parseOptions(["context"])).toThrow("--vault");
  expect(() => parseOptions(["apply", "--vault", "Planning"])).toThrow(
    "Choose context",
  );
  expect(() =>
    parseOptions(["status", "--vault", "Planning", "--input", "data.json"]),
  ).toThrow("does not accept");
  expect(() =>
    parseOptions(["context", "extra", "--vault", "Planning"]),
  ).toThrow("Choose context");
});

test("structured results reject explicit CLI errors, absent markers and malformed envelopes", () => {
  expect(
    parseResult(
      'noise\n=> TOKEN{"ok":true,"value":{"draft":1}}\n',
      "",
      "TOKEN",
    ),
  ).toEqual({ draft: 1 });
  expect(() =>
    parseResult(
      'Error: CLI unavailable\n=> TOKEN{"ok":true,"value":null}',
      "",
      "TOKEN",
    ),
  ).toThrow("CLI unavailable");
  expect(() => parseResult("(no output)", "", "TOKEN")).toThrow(
    "structured planning result",
  );
  expect(() => parseResult("TOKEN{", "", "TOKEN")).toThrow(
    "invalid planning result",
  );
  expect(() =>
    parseResult('TOKEN{"ok":false,"error":"Refresh context"}', "", "TOKEN"),
  ).toThrow("Refresh context");
  expect(() => parseResult('TOKEN{"ok":true}', "", "TOKEN")).toThrow(
    "invalid planning result",
  );
});

test("all commands use shell-free arguments, private JSON input and fixed facade methods", async () => {
  const getContext = vi.fn(async (input: unknown) => ({
    input,
    schema: { version: 1 },
  }));
  const submitProposal = vi.fn(async () => ({ status: "pending" }));
  const showTaskView = vi.fn(async () => ({ buckets: 2 }));
  const getStatus = vi.fn(async () => ({ draft: null }));
  let requestPath = "";
  executeMock.mockImplementation(
    async (cli: string, args: string[], settings: Record<string, unknown>) => {
      expect(cli).toBe("obsidian-cli");
      expect(args.slice(0, 2)).toEqual([`vault=${options.vault}`, "eval"]);
      expect(settings).toMatchObject({ shell: false, windowsHide: true });
      const code = args[2]!.slice("code=".length);
      const requestLiteral = code.match(
        /readFileSync\(("(?:[^"\\]|\\.)*")/,
      )?.[1];
      requestPath = JSON.parse(requestLiteral!) as string;
      expect(existsSync(requestPath)).toBe(true);
      expect(readFileSync(requestPath, "utf8")).toContain("literal");
      const AsyncFunction = Object.getPrototypeOf(async () => {})
        .constructor as new (
        ...args: string[]
      ) => (app: unknown, require: unknown) => Promise<string>;
      const run = new AsyncFunction("app", "require", `return ${code}`);
      const value = await run(
        {
          plugins: {
            plugins: {
              "day-planner-enhanced": {
                aiPlanner: {
                  getContext,
                  submitProposal,
                  showTaskView,
                  getStatus,
                },
              },
            },
          },
        },
        nodeRequire,
      );
      return { stdout: `=> ${value}\n`, stderr: "" };
    },
  );
  const request = { request: 'Keep $() and "quotes" literal', days: 1 };
  const cases = [
    {
      command: "context",
      method: getContext,
      expected: { input: request, schema: { version: 1 } },
    },
    {
      command: "propose",
      method: submitProposal,
      expected: { status: "pending" },
    },
    { command: "buckets", method: showTaskView, expected: { buckets: 2 } },
    { command: "status", method: getStatus, expected: { draft: null } },
  ];
  for (const row of cases) {
    expect(
      await invokePlanner({ ...options, command: row.command }, request),
    ).toEqual(row.expected);
    expect(row.method).toHaveBeenCalledExactlyOnceWith(
      ...(row.command === "status" ? [] : [request]),
    );
    expect(existsSync(requestPath)).toBe(false);
  }
});

test("failed CLI calls run once, fail clearly and remove temporary input", async () => {
  let requestPath = "";
  executeMock.mockImplementation(async (_cli: string, args: string[]) => {
    requestPath = JSON.parse(
      args[2]!.match(/readFileSync\(("(?:[^"\\]|\\.)*")/)![1]!,
    ) as string;
    throw Object.assign(new Error("process failed"), {
      code: 1,
      stdout: "Error: Vault not found",
    });
  });
  await expect(invokePlanner(options, {})).rejects.toThrow("Vault not found");
  expect(executeMock).toHaveBeenCalledTimes(1);
  expect(existsSync(requestPath)).toBe(false);
  executeMock.mockRejectedValueOnce(
    Object.assign(new Error("missing"), { code: "ENOENT" }),
  );
  await expect(invokePlanner(options, {})).rejects.toThrow(
    "--cli or OBSIDIAN_CLI",
  );
});
