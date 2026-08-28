// Adapted from OpenCode's MIT-licensed apply_patch implementation.
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

function splitBom(value) {
  return value.startsWith("\uFEFF") ? { bom: true, text: value.slice(1) } : { bom: false, text: value };
}

function joinBom(text, bom) {
  return `${bom ? "\uFEFF" : ""}${text}`;
}

function resolvePath(cwd, requested) {
  return path.isAbsolute(requested) ? path.normalize(requested) : path.resolve(cwd, requested);
}

function parseHeader(lines, index) {
  const prefixes = [
    ["*** Add File:", "add"],
    ["*** Delete File:", "delete"],
    ["*** Update File:", "update"],
  ];
  const match = prefixes.find(([prefix]) => lines[index].startsWith(prefix));
  if (!match) return undefined;

  const [prefix, type] = match;
  const filePath = lines[index].slice(prefix.length).trim();
  if (!filePath) return undefined;

  let nextIndex = index + 1;
  let movePath;
  if (type === "update" && lines[nextIndex]?.startsWith("*** Move to:")) {
    movePath = lines[nextIndex].slice("*** Move to:".length).trim();
    nextIndex += 1;
  }
  return { type, filePath, movePath, nextIndex };
}

function parseAdd(lines, index) {
  const content = [];
  while (index < lines.length && !lines[index].startsWith("***")) {
    if (lines[index].startsWith("+")) content.push(lines[index].slice(1));
    index += 1;
  }
  return { content: content.join("\n"), nextIndex: index };
}

function parseUpdate(lines, index) {
  const chunks = [];
  while (index < lines.length && !lines[index].startsWith("***")) {
    if (!lines[index].startsWith("@@")) {
      index += 1;
      continue;
    }

    const changeContext = lines[index].slice(2).trim() || undefined;
    const oldLines = [];
    const newLines = [];
    let endOfFile = false;
    index += 1;

    while (index < lines.length && !lines[index].startsWith("@@") && !lines[index].startsWith("***")) {
      const line = lines[index];
      if (line === "*** End of File") {
        endOfFile = true;
        index += 1;
        break;
      }
      if (line.startsWith(" ")) {
        oldLines.push(line.slice(1));
        newLines.push(line.slice(1));
      } else if (line.startsWith("-")) {
        oldLines.push(line.slice(1));
      } else if (line.startsWith("+")) {
        newLines.push(line.slice(1));
      }
      index += 1;
    }
    chunks.push({ oldLines, newLines, changeContext, endOfFile });
  }
  return { chunks, nextIndex: index };
}

function parsePatch(patchText) {
  const lines = patchText.replaceAll("\r\n", "\n").replaceAll("\r", "\n").trim().split("\n");
  const begin = lines.findIndex((line) => line.trim() === "*** Begin Patch");
  const end = lines.findIndex((line) => line.trim() === "*** End Patch");
  if (begin === -1 || end === -1 || begin >= end) {
    throw new Error("Invalid patch format: missing Begin/End markers");
  }

  const hunks = [];
  let index = begin + 1;
  while (index < end) {
    const header = parseHeader(lines, index);
    if (!header) {
      index += 1;
      continue;
    }
    if (header.type === "add") {
      const parsed = parseAdd(lines, header.nextIndex);
      hunks.push({ ...header, content: parsed.content });
      index = parsed.nextIndex;
      continue;
    }
    if (header.type === "update") {
      const parsed = parseUpdate(lines, header.nextIndex);
      hunks.push({ ...header, chunks: parsed.chunks });
      index = parsed.nextIndex;
      continue;
    }
    hunks.push(header);
    index = header.nextIndex;
  }
  return hunks;
}

function normalizeUnicode(value) {
  return value
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/[‐‑‒–—―]/g, "-")
    .replace(/…/g, "...")
    .replace(/ /g, " ");
}

function findSequence(lines, pattern, start, compare, endOfFile) {
  if (endOfFile) {
    const fromEnd = lines.length - pattern.length;
    if (fromEnd >= start && pattern.every((line, index) => compare(lines[fromEnd + index], line))) {
      return fromEnd;
    }
  }
  for (let index = start; index <= lines.length - pattern.length; index += 1) {
    if (pattern.every((line, offset) => compare(lines[index + offset], line))) return index;
  }
  return -1;
}

function seekSequence(lines, pattern, start, endOfFile) {
  const comparisons = [
    (left, right) => left === right,
    (left, right) => left.trimEnd() === right.trimEnd(),
    (left, right) => left.trim() === right.trim(),
    (left, right) => normalizeUnicode(left.trim()) === normalizeUnicode(right.trim()),
  ];
  for (const compare of comparisons) {
    const found = findSequence(lines, pattern, start, compare, endOfFile);
    if (found !== -1) return found;
  }
  return -1;
}

function applyChunks(filename, chunks, original) {
  const lines = original.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const replacements = [];
  let cursor = 0;

  for (const chunk of chunks) {
    if (chunk.changeContext) {
      const context = seekSequence(lines, [chunk.changeContext], cursor, false);
      if (context === -1) throw new Error(`Failed to find context '${chunk.changeContext}' in ${filename}`);
      cursor = context + 1;
    }
    if (chunk.oldLines.length === 0) {
      replacements.push([lines.length, 0, chunk.newLines]);
      continue;
    }

    let oldLines = chunk.oldLines;
    let newLines = chunk.newLines;
    let found = seekSequence(lines, oldLines, cursor, chunk.endOfFile);
    if (found === -1 && oldLines.at(-1) === "") {
      oldLines = oldLines.slice(0, -1);
      if (newLines.at(-1) === "") newLines = newLines.slice(0, -1);
      found = seekSequence(lines, oldLines, cursor, chunk.endOfFile);
    }
    if (found === -1) {
      throw new Error(`Failed to find expected lines in ${filename}:\n${chunk.oldLines.join("\n")}`);
    }
    replacements.push([found, oldLines.length, newLines]);
    cursor = found + oldLines.length;
  }

  for (const [start, count, replacement] of replacements.sort((left, right) => right[0] - left[0])) {
    lines.splice(start, count, ...replacement);
  }
  return `${lines.join("\n")}\n`;
}

async function exists(filename) {
  try {
    return (await stat(filename)).isFile();
  } catch {
    return false;
  }
}

export async function applyPatchTool(params, context) {
  if (!params.patchText) throw new Error("patchText is required");

  let hunks;
  try {
    hunks = parsePatch(params.patchText);
  } catch (error) {
    throw new Error(`apply_patch verification failed: ${error}`);
  }
  if (hunks.length === 0) {
    if (params.patchText.replaceAll("\r\n", "\n").trim() === "*** Begin Patch\n*** End Patch") {
      throw new Error("patch rejected: empty patch");
    }
    throw new Error("apply_patch verification failed: no hunks found");
  }

  const changes = [];
  try {
    for (const hunk of hunks) {
      const sourcePath = resolvePath(context.cwd, hunk.filePath);
      if (hunk.type === "add") {
        const content = hunk.content === "" || hunk.content.endsWith("\n") ? hunk.content : `${hunk.content}\n`;
        changes.push({ type: "add", sourcePath, targetPath: sourcePath, content, bom: false });
        continue;
      }
      if (!(await exists(sourcePath))) {
        throw new Error(`Failed to read file to update: ${sourcePath}`);
      }
      const source = splitBom(await readFile(sourcePath, "utf8"));
      if (hunk.type === "delete") {
        changes.push({ type: "delete", sourcePath });
        continue;
      }
      const targetPath = hunk.movePath ? resolvePath(context.cwd, hunk.movePath) : sourcePath;
      const content = applyChunks(sourcePath, hunk.chunks, source.text);
      changes.push({ type: hunk.movePath ? "move" : "update", sourcePath, targetPath, content, bom: source.bom });
    }
  } catch (error) {
    throw new Error(`apply_patch verification failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  for (const change of changes) {
    if (change.type === "delete") {
      await rm(change.sourcePath);
      continue;
    }
    await mkdir(path.dirname(change.targetPath), { recursive: true });
    await writeFile(change.targetPath, joinBom(change.content, change.bom), "utf8");
    if (change.type === "move") await rm(change.sourcePath);
  }

  const summary = changes.map((change) => {
    const relative = path.relative(context.cwd, change.targetPath ?? change.sourcePath).replaceAll("\\", "/");
    if (change.type === "add") return `A ${relative}`;
    if (change.type === "delete") return `D ${relative}`;
    return `M ${relative}`;
  });
  const output = `Success. Updated the following files:\n${summary.join("\n")}`;
  return { content: [{ type: "text", text: output }], details: { files: summary } };
}
