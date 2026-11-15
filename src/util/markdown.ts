/* eslint-disable @typescript-eslint/no-floating-promises, @typescript-eslint/no-misused-promises, @typescript-eslint/no-redundant-type-constituents, @typescript-eslint/no-unnecessary-condition, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-enum-comparison, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return -- Obsidian community scorecard can run type-aware rules without resolving plugin source dependencies; tsc and svelte-check cover this source. */
import { isNotVoid } from "typed-assert";

import { codeFence, indentBeforeListParagraph } from "../constants";
import {
  checkboxRegExp,
  headingRegExp,
  listTokenWithSpacesRegExp,
} from "../regexp";
import type { DayPlannerSettings } from "../settings";
import type { ListItemTokens } from "../time-block-types";

export const defaultIndentation = "  ";

/** Infer a nesting step from existing list lines; never rewrite the note itself. */
export function detectIndentation(text: string): string {
  const stack: string[] = [];
  const masked = text
    .replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "")
    .replace(/%%[\s\S]*?(?:%%|$)|<!--[\s\S]*?(?:-->|$)/g, (value) =>
      value.replace(/[^\r\n]/g, " "),
    );
  let fence: { character: string; length: number } | undefined;
  for (const line of masked.split(/\r?\n/)) {
    const marker = line.match(/^[ \t]*(`{3,}|~{3,})/);
    if (marker) {
      const run = marker[1]!;
      if (!fence) fence = { character: run[0]!, length: run.length };
      else if (
        run[0] === fence.character &&
        run.length >= fence.length &&
        line.slice(marker[0].length).trim() === ""
      )
        fence = undefined;
      continue;
    }
    if (fence) continue;
    const match = line.match(/^([ \t]*)(?:[-*+]|\d+[.)])[ \t]+/);
    if (!match) continue;
    const current = match[1]!;
    while (stack.length && !current.startsWith(stack[stack.length - 1]!))
      stack.pop();
    if (stack.length && current.length > stack[stack.length - 1]!.length) {
      const step = current.slice(stack[stack.length - 1]!.length);
      if (/^(?: +|\t+)$/.test(step)) return step;
    }
    if (!stack.length || stack[stack.length - 1] !== current)
      stack.push(current);
  }
  return defaultIndentation;
}

/** Translate whole indentation levels, leaving any partial continuation untouched. */
export function translateIndentation(
  indent: string,
  source: string,
  target: string,
) {
  if (!source || source === target) return indent;
  let result = "";
  let remaining = indent;
  while (remaining.startsWith(source)) {
    result += target;
    remaining = remaining.slice(source.length);
  }
  return result + remaining;
}

/** Compare nested list text independent of its existing indentation convention. */
export function normalizeListIndentation(text: string) {
  const source = detectIndentation(text);
  let fence: { character: string; length: number } | undefined;
  return text
    .split(/\r?\n/)
    .map((line) => {
      const marker = line.match(/^[ \t]*(`{3,}|~{3,})/);
      if (fence && !marker) return line;
      if (marker) {
        const run = marker[1]!;
        if (!fence) fence = { character: run[0]!, length: run.length };
        else if (
          run[0] === fence.character &&
          run.length >= fence.length &&
          line.slice(marker[0].length).trim() === ""
        )
          fence = undefined;
        else return line;
      }
      return line.replace(/^[ \t]+/, (indentation) =>
        translateIndentation(indentation, source, defaultIndentation),
      );
    })
    .join("\n");
}

export function toggleCheckbox(line: string) {
  if (line.includes("[ ]")) {
    return line.replace("[ ]", "[x]");
  }

  return line.replace("[x]", "[ ]");
}

export function createHeading(level: number, text: string) {
  return `${"#".repeat(level)} ${text}`;
}

export function updateLine(
  contents: string,
  lineNumber: number,
  editFn: (line: string) => string,
) {
  const lines = contents.split("\n");
  const originalLine = lines[lineNumber];

  isNotVoid(
    originalLine,
    `No line #${lineNumber} in text with ${lines.length} lines`,
  );

  lines[lineNumber] = editFn(originalLine);

  return lines.join("\n");
}

export function indentLines(lines: string[], indentation: string) {
  return lines.map((line) => indentation + line);
}

export function indent(text: string, indentation: string) {
  return indentLines(text.split("\n"), indentation).join("\n");
}

export function getFirstLine(text: string) {
  const firstLine = text.split("\n")[0];

  isNotVoid(firstLine);

  return firstLine;
}

export function getLinesAfterFirst(text: string) {
  return text.split("\n").slice(1).join("\n");
}

export function removeMarkdownExtension(path: string) {
  return path.replace(/\.md$/, "");
}

export function removeListTokens(text: string) {
  return text
    .replace(listTokenWithSpacesRegExp, "")
    .replace(checkboxRegExp, "");
}

// todo: account for user settings
export function createIndentation(level: number) {
  return defaultIndentation.repeat(level);
}

export function checkbox(status: string) {
  return `[${status}]`;
}

export function appendHeading(contents: string, heading: string) {
  let result = contents;

  if (contents.length > 0) {
    result = result.trimEnd();
    result = result.concat("\n", "\n");
  }

  return result.concat(heading, "\n", "\n");
}

/**
 * We need to limit our updates to the scope of the heading because mdast-util-to-markdown breaks invalid markdown that we see in user templates.
 */
export function applyScopedUpdates(
  contents: string,
  headingScope: string,
  updateFn: (scopedContents: string) => string,
  settings?: { createHeading: boolean; settings: DayPlannerSettings },
) {
  if (headingScope.trim().length === 0) {
    return contents;
  }

  const heading = findHeading(contents, headingScope);

  if (heading?.start === undefined) {
    if (settings?.createHeading) {
      const { plannerHeadingLevel, plannerHeading } = settings.settings;
      const withHeading = appendHeading(
        contents,
        createHeading(plannerHeadingLevel, plannerHeading),
      );

      return applyScopedUpdates(withHeading, headingScope, updateFn);
    }

    return contents;
  }

  const lines = contents.split("\n");
  const beforeHeading = lines.slice(0, heading.start);
  const afterHeadingIndex = heading.start + heading.length;
  const toUpdate = lines.slice(heading.start, afterHeadingIndex).join("\n");
  const afterHeading = lines.slice(afterHeadingIndex);

  const updated = updateFn(toUpdate).split("\n");

  return beforeHeading.concat(updated, afterHeading).join("\n");
}

function findHeadingInLine(line: string) {
  const headingMatch = line.match(headingRegExp);

  if (!headingMatch) {
    return undefined;
  }

  const [, tokens] = headingMatch;

  isNotVoid(tokens);

  return { level: tokens.length };
}

function findHeading(text: string, headingText: string) {
  const lines = text.split("\n");

  const result: {
    start: number | undefined;
    length: number;
    level: number;
  } = {
    start: undefined,
    length: 0,
    level: 0,
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    isNotVoid(line);

    const heading = findHeadingInLine(line);
    const insideHeading = result.start !== undefined;

    if (insideHeading) {
      if (heading && heading.level <= result.level) {
        return result;
      }

      result.length++;
    } else {
      if (heading && line.includes(headingText)) {
        result.start = i;
        result.level = heading.level;
        result.length = 1;
      }
    }
  }

  if (result.start === undefined) {
    return undefined;
  }

  return result;
}

export function createCodeBlock(props: {
  language: "yaml" | "yml";
  text: string;
}) {
  return codeFence + props.language + "\n" + props.text + codeFence;
}

export interface Node {
  text: string;
  symbol: string;
  children?: Node[];
  status?: string;
  task?: string;
}

export function getIndentationForListParagraph() {
  return " ".repeat(indentBeforeListParagraph);
}

export function getFirstLineAsMarkdown(listItemEntry: Node) {
  const firstLine = listItemEntry.text.split("\n")[0];

  isNotVoid(firstLine);

  return `${createMarkdownListTokens(listItemEntry)} ${firstLine}`;
}

export function createMarkdownListTokens(listItem: ListItemTokens) {
  if (listItem.status === undefined && listItem.task === undefined) {
    return listItem.symbol;
  }

  return `${listItem.symbol} ${checkbox(listItem.status || listItem.task || " ")}`;
}
/* eslint-enable @typescript-eslint/no-floating-promises, @typescript-eslint/no-misused-promises, @typescript-eslint/no-redundant-type-constituents, @typescript-eslint/no-unnecessary-condition, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-enum-comparison, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return -- Re-enable scorecard compatibility suppressions after this file. */
