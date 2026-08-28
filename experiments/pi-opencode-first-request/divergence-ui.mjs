import { stdout } from "node:process";

const ansiPattern = /\u001b\[[0-9;]*m/g;
const colorEnabled = stdout.isTTY && !process.env.NO_COLOR;

function color(code, value) {
  return colorEnabled ? `\u001b[${code}m${value}\u001b[0m` : value;
}

function padStyled(value, width) {
  const visibleLength = value.replace(ansiPattern, "").length;
  return `${value}${" ".repeat(Math.max(0, width - visibleLength))}`;
}

function valueText(side) {
  if (!side.present) return "(missing)";
  if (typeof side.value === "string") return side.value;
  return JSON.stringify(side.value, null, 2);
}

function trimForDisplay(value, maxLines = 80, maxCharacters = 8_000) {
  let text = value.length > maxCharacters ? `${value.slice(0, maxCharacters)}\n... truncated ...` : value;
  const lines = text.split("\n");
  if (lines.length > maxLines) {
    text = [...lines.slice(0, maxLines), "... truncated ..."].join("\n");
  }
  return text;
}

function wrapLine(line, width) {
  if (line.length === 0) return [""];
  const chunks = [];
  let remaining = line;
  while (remaining.length > width) {
    let split = remaining.lastIndexOf(" ", width);
    if (split < Math.floor(width / 2)) split = width;
    chunks.push(remaining.slice(0, split));
    remaining = remaining.slice(split).replace(/^ /, "");
  }
  chunks.push(remaining);
  return chunks;
}

function wrappedLines(value, width) {
  return trimForDisplay(value)
    .replace(/\t/g, "  ")
    .split("\n")
    .flatMap((line) => wrapLine(line, width));
}

function printSideBySide(left, right) {
  const terminalWidth = Math.max(72, Math.min(stdout.columns ?? 120, 180));
  const columnWidth = Math.floor((terminalWidth - 3) / 2);
  const leftLines = wrappedLines(left, columnWidth);
  const rightLines = wrappedLines(right, columnWidth);
  const count = Math.max(leftLines.length, rightLines.length);

  console.log(
    `\n${padStyled(color("36;1", "OpenCode"), columnWidth)} | ` +
      color("35;1", "Pi + OpenCode extension"),
  );
  console.log(`${"-".repeat(columnWidth)}-+-${"-".repeat(columnWidth)}`);
  for (let index = 0; index < count; index += 1) {
    console.log(`${(leftLines[index] ?? "").padEnd(columnWidth)} | ${rightLines[index] ?? ""}`);
  }
}

function unifiedDiff(left, right) {
  const leftLines = trimForDisplay(left).split("\n");
  const rightLines = trimForDisplay(right).split("\n");
  let prefix = 0;
  while (
    prefix < leftLines.length &&
    prefix < rightLines.length &&
    leftLines[prefix] === rightLines[prefix]
  ) {
    prefix += 1;
  }

  let suffix = 0;
  while (
    suffix < leftLines.length - prefix &&
    suffix < rightLines.length - prefix &&
    leftLines[leftLines.length - 1 - suffix] === rightLines[rightLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const contextBefore = leftLines.slice(Math.max(0, prefix - 2), prefix);
  const removed = leftLines.slice(prefix, leftLines.length - suffix);
  const added = rightLines.slice(prefix, rightLines.length - suffix);
  const contextAfter = suffix > 0
    ? leftLines.slice(leftLines.length - suffix, Math.min(leftLines.length, leftLines.length - suffix + 2))
    : [];

  return [
    ...contextBefore.map((line) => `  ${line}`),
    ...removed.map((line) => color("31", `- ${line}`)),
    ...added.map((line) => color("32", `+ ${line}`)),
    ...contextAfter.map((line) => `  ${line}`),
  ].join("\n");
}

export async function promptForDivergence(readline, divergence) {
  const openCode = valueText(divergence.openCode);
  const pi = valueText(divergence.pi);
  console.log(
    `\n${color("33;1", "First divergence")}: Pi's ${divergence.kind} differs from OpenCode's ` +
      `on model request ${divergence.request}.`,
  );
  console.log(`Location: ${divergence.detailPointer}`);
  printSideBySide(openCode, pi);
  console.log(`\n${color("1", "Diff")}`);
  console.log(unifiedDiff(openCode, pi));

  const answer = (await readline.question("\nUse OpenCode's value for Pi? [y/N] ")).trim().toLowerCase();
  const useOpenCode = answer === "y" || answer === "yes";
  console.log(
    useOpenCode
      ? "Using OpenCode's value. Further differences will not prompt during this run."
      : "Keeping Pi's value. Further differences will not prompt during this run.",
  );
  return useOpenCode;
}
