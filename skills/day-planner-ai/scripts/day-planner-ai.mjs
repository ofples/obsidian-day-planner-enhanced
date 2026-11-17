import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, rmdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs, promisify } from "node:util";

const execute = promisify(execFile);
const methods = {
  context: "getContext",
  propose: "submitProposal",
  buckets: "showTaskView",
  status: "getStatus",
};

const help = `Use an existing assistant with Day Planner's local planning tools.

Usage
  node scripts/day-planner-ai.mjs <command> --vault <name> [options]

Commands
  context   Read planning context and the current proposal schema
  propose   Submit suggestions for review in Day Planner
  buckets   Show a curated task view
  status    Read the current draft and last-batch status

Options
  --input <file>  Read a JSON document from a file, or use - for stdin
  --cli <path>    Obsidian CLI executable, also configurable with OBSIDIAN_CLI
  --vault <name>  Explicit target vault
  --help         Show this help

Context input is optional. Propose and buckets require an input document.
Open desktop Obsidian with its CLI enabled before running a command.
Approval and Undo are available in Day Planner's UI.
`;

export function parseOptions(args) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      vault: { type: "string" },
      cli: { type: "string" },
      input: { type: "string" },
      help: { type: "boolean" },
    },
  });
  if (values.help) return { help: true };
  const command = positionals[0];
  if (positionals.length !== 1 || !Object.hasOwn(methods, command))
    throw new Error(
      "Choose context, propose, buckets or status. Use --help for usage.",
    );
  if (!values.vault?.trim())
    throw new Error("Specify the target vault with --vault.");
  if (command === "status" && values.input)
    throw new Error("Status does not accept an input document.");
  return {
    command,
    vault: values.vault,
    cli: values.cli || process.env.OBSIDIAN_CLI || "obsidian",
    input: values.input,
  };
}

export function parseResult(stdout, stderr, marker) {
  const output = `${stdout}\n${stderr}`;
  const explicitError = output.match(/^\s*(?:=>\s*)?Error:\s*(.+)$/m)?.[1];
  if (explicitError) throw new Error(explicitError.trim());
  const matches = stdout.split(marker);
  if (matches.length !== 2)
    throw new Error(
      "Obsidian returned no single structured planning result. Check the plugin and CLI connection.",
    );
  let envelope;
  try {
    envelope = JSON.parse(matches[1].split(/\r?\n/, 1)[0].trim());
  } catch {
    throw new Error("Obsidian returned an invalid planning result.");
  }
  if (envelope?.ok === false)
    throw new Error(
      typeof envelope.error === "string"
        ? envelope.error
        : "The planning operation failed.",
    );
  if (envelope?.ok !== true || !Object.hasOwn(envelope, "value"))
    throw new Error("Obsidian returned an invalid planning result.");
  return envelope.value;
}

export async function invokePlanner({ command, vault, cli }, input) {
  const method = methods[command];
  if (!Object.hasOwn(methods, command))
    throw new Error("Unsupported planning command.");
  const directory = await mkdtemp(join(tmpdir(), "day-planner-ai-"));
  const inputPath = join(directory, "request.json");
  const marker = `__DAY_PLANNER_AI_${randomUUID()}__`;
  try {
    await writeFile(inputPath, JSON.stringify({ input }), {
      encoding: "utf8",
      mode: 0o600,
    });
    const code = `await (async () => {
      try {
        const planner = app.plugins.plugins['day-planner-enhanced']?.aiPlanner;
        if (!planner) throw new Error('Enable a Day Planner build with AI planning support.');
        const data = JSON.parse(require('node:fs').readFileSync(${JSON.stringify(inputPath)}, 'utf8'));
        const value = await planner.${method}(${command === "status" ? "" : "data.input"});
        return ${JSON.stringify(marker)} + JSON.stringify({ ok: true, value: value ?? null });
      } catch (error) {
        return ${JSON.stringify(marker)} + JSON.stringify({
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    })()`;
    let result;
    try {
      result = await execute(cli, [`vault=${vault}`, "eval", `code=${code}`], {
        shell: false,
        windowsHide: true,
        encoding: "utf8",
        timeout: 30_000,
        maxBuffer: 8 * 1024 * 1024,
      });
    } catch (error) {
      if (error.code === "ENOENT")
        throw new Error(
          "Obsidian CLI was not found. Set --cli or OBSIDIAN_CLI to its executable.",
        );
      const detail = `${error.stdout ?? ""}\n${error.stderr ?? ""}`.match(
        /^\s*(?:=>\s*)?Error:\s*(.+)$/m,
      )?.[1];
      throw new Error(
        detail ||
          "Obsidian CLI failed. Check that Obsidian is open and its CLI is enabled.",
      );
    }
    return parseResult(result.stdout, result.stderr, marker);
  } finally {
    await rm(inputPath, { force: true });
    await rmdir(directory);
  }
}

async function readInput(options) {
  if (options.command === "status") return;
  let text = "";
  if (options.input && options.input !== "-")
    text = await readFile(options.input, "utf8");
  else if (options.input === "-" || !process.stdin.isTTY)
    for await (const chunk of process.stdin) text += chunk.toString();
  if (!text.trim()) {
    if (options.command === "context") return;
    throw new Error("Provide the JSON document with --input <file> or stdin.");
  }
  let input;
  try {
    input = JSON.parse(text);
  } catch {
    throw new Error("The input document must contain valid JSON.");
  }
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("The input document must be a JSON object.");
  return input;
}

export async function main(args = process.argv.slice(2)) {
  const options = parseOptions(args);
  if (options.help) {
    process.stdout.write(help);
    return;
  }
  const input = await readInput(options);
  const value = await invokePlanner(options, input);
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  main().catch((error) => {
    process.stderr.write(`Error: ${error.message}\n`);
    process.exitCode = 1;
  });
