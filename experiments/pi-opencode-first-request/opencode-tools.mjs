import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Parser } from "htmlparser2";
import TurndownService from "turndown";
import { applyPatchTool } from "./opencode-apply-patch.mjs";

const DEFAULT_READ_LIMIT = 2000;
const MODULE_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const BUILTIN_SKILL = path.join(MODULE_DIRECTORY, "fixtures", "customize-opencode.md");
const MAX_LINE_LENGTH = 2000;
const MAX_LINE_SUFFIX = `... (line truncated to ${MAX_LINE_LENGTH} chars)`;
const MAX_OUTPUT_LINES = 2000;
const MAX_OUTPUT_BYTES = 50 * 1024;
const MAX_RESPONSE_SIZE = 5 * 1024 * 1024;
const DEFAULT_SHELL_TIMEOUT = 120_000;
const DEFAULT_FETCH_TIMEOUT = 30_000;
const MAX_FETCH_TIMEOUT = 120_000;
const SUPPORTED_IMAGES = new Map([
  [".gif", "image/gif"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".png", "image/png"],
  [".webp", "image/webp"],
]);
const BINARY_EXTENSIONS = new Set([
  ".7z",
  ".a",
  ".bin",
  ".class",
  ".dat",
  ".dll",
  ".doc",
  ".docx",
  ".exe",
  ".gz",
  ".jar",
  ".lib",
  ".o",
  ".obj",
  ".odp",
  ".ods",
  ".odt",
  ".ppt",
  ".pptx",
  ".pyc",
  ".pyo",
  ".so",
  ".tar",
  ".war",
  ".wasm",
  ".xls",
  ".xlsx",
  ".zip",
]);

function textResult(text, details = {}) {
  return { content: [{ type: "text", text }], details };
}

function resolvePath(cwd, requested = ".") {
  return path.isAbsolute(requested) ? path.normalize(requested) : path.resolve(cwd, requested);
}

function isBinary(filename, sample) {
  if (BINARY_EXTENSIONS.has(path.extname(filename).toLowerCase())) return true;
  if (sample.length === 0) return false;
  let nonPrintable = 0;
  for (const byte of sample) {
    if (byte === 0) return true;
    if (byte < 9 || (byte > 13 && byte < 32)) nonPrintable += 1;
  }
  return nonPrintable / sample.length > 0.3;
}

function mimeForFile(filename, sample) {
  if (sample.length >= 8 && sample.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return "image/png";
  }
  if (sample.length >= 3 && sample[0] === 0xff && sample[1] === 0xd8 && sample[2] === 0xff) return "image/jpeg";
  if (["GIF87a", "GIF89a"].includes(sample.subarray(0, 6).toString("ascii"))) return "image/gif";
  if (
    sample.length >= 12 &&
    sample.subarray(0, 4).toString("ascii") === "RIFF" &&
    sample.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
  if (sample.subarray(0, 4).toString("ascii") === "%PDF") return "application/pdf";
  if (path.extname(filename).toLowerCase() === ".pdf") return "application/pdf";
  return SUPPORTED_IMAGES.get(path.extname(filename).toLowerCase());
}

async function missingFileError(filename) {
  const directory = path.dirname(filename);
  const basename = path.basename(filename).toLowerCase();
  let suggestions = [];
  try {
    suggestions = (await readdir(directory))
      .filter((entry) => entry.toLowerCase().includes(basename) || basename.includes(entry.toLowerCase()))
      .slice(0, 3)
      .map((entry) => path.join(directory, entry));
  } catch {
    // The parent directory may not exist either.
  }
  if (suggestions.length === 0) return new Error(`File not found: ${filename}`);
  return new Error(`File not found: ${filename}\n\nDid you mean one of these?\n${suggestions.join("\n")}`);
}

async function listDirectory(filename) {
  const entries = await readdir(filename, { withFileTypes: true });
  const rendered = await Promise.all(
    entries.map(async (entry) => {
      if (entry.isDirectory()) return `${entry.name}/`;
      if (!entry.isSymbolicLink()) return entry.name;
      try {
        return (await stat(path.join(filename, entry.name))).isDirectory() ? `${entry.name}/` : entry.name;
      } catch {
        return entry.name;
      }
    }),
  );
  return rendered.sort((left, right) => left.localeCompare(right));
}

async function readTool(params, context) {
  const filename = resolvePath(context.cwd, params.filePath);
  let info;
  try {
    info = await stat(filename);
  } catch (error) {
    if (error?.code === "ENOENT") throw await missingFileError(filename);
    throw error;
  }

  if (info.isDirectory()) {
    const entries = await listDirectory(filename);
    const limit = params.limit ?? DEFAULT_READ_LIMIT;
    const offset = params.offset || 1;
    const start = offset - 1;
    const selected = entries.slice(start, start + limit);
    const truncated = start + selected.length < entries.length;
    const output = [
      `<path>${filename}</path>`,
      "<type>directory</type>",
      "<entries>",
      selected.join("\n"),
      truncated
        ? `\n(Showing ${selected.length} of ${entries.length} entries. Use 'offset' parameter to read beyond entry ${offset + selected.length})`
        : `\n(${entries.length} entries)`,
      "</entries>",
    ].join("\n");
    return textResult(output, { truncated });
  }

  const bytes = await readFile(filename);
  const sample = bytes.subarray(0, Math.min(bytes.length, 4096));
  const mime = mimeForFile(filename, sample);
  if (mime) {
    const message = mime === "application/pdf" ? "PDF read successfully" : "Image read successfully";
    if (mime === "application/pdf") return textResult(message, { truncated: false, attachmentOmitted: true });
    return {
      content: [
        { type: "text", text: message },
        { type: "image", data: bytes.toString("base64"), mimeType: mime },
      ],
      details: { truncated: false },
    };
  }
  if (isBinary(filename, sample)) throw new Error(`Cannot read binary file: ${filename}`);

  const decoded = new TextDecoder("utf-8").decode(bytes).replace(/^\uFEFF/, "");
  const allLines = decoded === "" ? [] : decoded.split(/\r?\n/);
  if (decoded.endsWith("\n")) allLines.pop();
  const offset = params.offset || 1;
  const limit = params.limit ?? DEFAULT_READ_LIMIT;
  if (allLines.length < offset && !(allLines.length === 0 && offset === 1)) {
    throw new Error(`Offset ${offset} is out of range for this file (${allLines.length} lines)`);
  }

  const raw = [];
  let bytesUsed = 0;
  let cut = false;
  let more = false;
  for (let index = offset - 1; index < allLines.length; index += 1) {
    if (raw.length >= limit) {
      more = true;
      break;
    }
    const source = allLines[index];
    const line = source.length > MAX_LINE_LENGTH ? source.slice(0, MAX_LINE_LENGTH) + MAX_LINE_SUFFIX : source;
    const size = Buffer.byteLength(line, "utf8") + (raw.length > 0 ? 1 : 0);
    if (bytesUsed + size > MAX_OUTPUT_BYTES) {
      cut = true;
      more = true;
      break;
    }
    raw.push(line);
    bytesUsed += size;
  }

  let output = [`<path>${filename}</path>`, "<type>file</type>", "<content>\n"].join("\n");
  output += raw.map((line, index) => `${index + offset}: ${line}`).join("\n");
  const last = offset + raw.length - 1;
  const next = last + 1;
  if (cut) {
    output += `\n\n(Output capped at 50 KB. Showing lines ${offset}-${last}. Use offset=${next} to continue.)`;
  } else if (more || last < allLines.length) {
    output += `\n\n(Showing lines ${offset}-${last} of ${allLines.length}. Use offset=${next} to continue.)`;
  } else {
    output += `\n\n(End of file - total ${allLines.length} lines)`;
  }
  output += "\n</content>";
  return textResult(output, { truncated: cut || more });
}

function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: options.detached ?? false,
    });
    const chunks = [];
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let aborted = false;
    let forceKillTimeout;
    const collect = (stream, target) => {
      stream.on("data", (chunk) => {
        const value = chunk.toString();
        chunks.push(value);
        if (target === "stdout") stdout += value;
        else stderr += value;
      });
    };
    collect(child.stdout, "stdout");
    collect(child.stderr, "stderr");

    const kill = () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      try {
        if (options.detached && child.pid && process.platform !== "win32") process.kill(-child.pid, "SIGTERM");
        else child.kill("SIGTERM");
        forceKillTimeout ??= setTimeout(() => {
          try {
            if (options.detached && child.pid && process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
            else child.kill("SIGKILL");
          } catch {
            // The process exited during the grace period.
          }
        }, 3000);
      } catch {
        // The child may have exited between the state check and signal.
      }
    };
    const timeout = options.timeout
      ? setTimeout(() => {
          timedOut = true;
          kill();
        }, options.timeout + 100)
      : undefined;
    const onAbort = () => {
      aborted = true;
      kill();
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (timeout) clearTimeout(timeout);
      if (forceKillTimeout) clearTimeout(forceKillTimeout);
      options.signal?.removeEventListener("abort", onAbort);
      resolve({ code, signal, stdout, stderr, output: chunks.join(""), timedOut, aborted });
    });
  });
}

function tailOutput(value, maxLines = MAX_OUTPUT_LINES, maxBytes = MAX_OUTPUT_BYTES) {
  const lines = value.split("\n");
  if (lines.length <= maxLines && Buffer.byteLength(value, "utf8") <= maxBytes) {
    return { text: value, cut: false };
  }
  const output = [];
  let bytes = 0;
  for (let index = lines.length - 1; index >= 0 && output.length < maxLines; index -= 1) {
    const size = Buffer.byteLength(lines[index], "utf8") + (output.length > 0 ? 1 : 0);
    if (bytes + size > maxBytes) {
      if (output.length === 0) {
        const buffer = Buffer.from(lines[index], "utf8");
        let start = Math.max(0, buffer.length - maxBytes);
        while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) start += 1;
        output.unshift(buffer.subarray(start).toString("utf8"));
      }
      break;
    }
    output.unshift(lines[index]);
    bytes += size;
  }
  return { text: output.join("\n"), cut: true };
}

async function saveTruncatedOutput(value) {
  const directory =
    process.env.OPENCODE_TRUNCATION_DIR ?? path.join(os.tmpdir(), "harness-equivalence-tool-output");
  await mkdir(directory, { recursive: true });
  const filename = path.join(directory, `tool_${randomUUID().replaceAll("-", "")}`);
  await writeFile(filename, value);
  return filename;
}

function truncateHead(value) {
  const lines = value.split("\n");
  const totalBytes = Buffer.byteLength(value, "utf8");
  if (lines.length <= MAX_OUTPUT_LINES && totalBytes <= MAX_OUTPUT_BYTES) {
    return { content: value, truncated: false };
  }
  const output = [];
  let bytes = 0;
  let hitBytes = false;
  for (let index = 0; index < lines.length && index < MAX_OUTPUT_LINES; index += 1) {
    const size = Buffer.byteLength(lines[index], "utf8") + (index > 0 ? 1 : 0);
    if (bytes + size > MAX_OUTPUT_BYTES) {
      hitBytes = true;
      break;
    }
    output.push(lines[index]);
    bytes += size;
  }
  const removed = hitBytes ? totalBytes - bytes : lines.length - output.length;
  return {
    content: output.join("\n"),
    truncated: true,
    removed,
    unit: hitBytes ? "bytes" : "lines",
  };
}

async function applyGenericTruncation(result) {
  if (Object.hasOwn(result.details ?? {}, "truncated")) return result;
  const index = result.content.findIndex((part) => part.type === "text");
  if (index === -1) return result;
  const preview = truncateHead(result.content[index].text);
  if (!preview.truncated) return result;
  const filename = await saveTruncatedOutput(result.content[index].text);
  const hint = process.env.OPENCODE_TASK_DEPTH === "1"
    ? `The tool call succeeded but the output was truncated. Full output saved to: ${filename}\nUse Grep to search the full content or Read with offset/limit to view specific sections.`
    : `The tool call succeeded but the output was truncated. Full output saved to: ${filename}\nUse the Task tool to have explore agent process this file with Grep and Read (with offset/limit). Do NOT read the full file yourself - delegate to save context.`;
  const content = [...result.content];
  content[index] = {
    ...content[index],
    text: `${preview.content}\n\n...${preview.removed} ${preview.unit} truncated...\n\n${hint}`,
  };
  return { content, details: { ...(result.details ?? {}), truncated: true, outputPath: filename } };
}

async function bashTool(params, context) {
  const timeout = params.timeout ?? DEFAULT_SHELL_TIMEOUT;
  const cwd = resolvePath(context.cwd, params.workdir ?? context.cwd);
  const shell =
    process.env.OPENCODE_COMPAT_SHELL ||
    process.env.SHELL ||
    (process.platform === "win32" ? "cmd.exe" : "/bin/sh");
  const shellArgs = process.platform === "win32" ? ["/d", "/s", "/c", params.command] : ["-c", params.command];
  const result = await runProcess(shell, shellArgs, {
    cwd,
    timeout,
    signal: context.signal,
    detached: process.platform !== "win32",
  });
  const tail = tailOutput(result.output);
  let output = tail.text || "(no output)";
  if (tail.cut) {
    const filename = await saveTruncatedOutput(result.output);
    output = `...output truncated...\n\nFull output saved to: ${filename}\n\n${output}`;
  }
  const metadata = [];
  if (result.timedOut) {
    metadata.push(
      `shell tool terminated command after exceeding timeout ${timeout} ms. If this command is expected to take longer and is not waiting for interactive input, retry with a larger timeout value in milliseconds.`,
    );
  }
  if (result.aborted) metadata.push("User aborted the command");
  if (metadata.length > 0) output += `\n\n<shell_metadata>\n${metadata.join("\n")}\n</shell_metadata>`;
  return textResult(output, { exit: result.code, truncated: tail.cut });
}

async function executable(filename) {
  try {
    await access(filename, fsConstants.X_OK);
    return filename;
  } catch {
    return undefined;
  }
}

async function ripgrepPath() {
  if (process.env.OPENCODE_RG_PATH) {
    const configured = await executable(process.env.OPENCODE_RG_PATH);
    if (configured) return configured;
  }
  const name = process.platform === "win32" ? "rg.exe" : "rg";
  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    const candidate = await executable(path.join(directory, name));
    if (candidate) return candidate;
  }
  throw new Error("ripgrep is required for OpenCode-compatible glob, grep, and skill tools");
}

async function globTool(params, context) {
  const search = resolvePath(context.cwd, params.path ?? context.cwd);
  try {
    if ((await stat(search)).isFile()) throw new Error(`glob path must be a directory: ${search}`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const rg = await ripgrepPath();
  const result = await runProcess(
    rg,
    ["--no-config", "--files", `--glob=${params.pattern}`, "--glob=!**/.git/**", "."],
    { cwd: search, signal: context.signal },
  );
  if (![0, 1].includes(result.code)) throw new Error(result.stderr.trim() || `ripgrep failed with code ${result.code}`);
  const files = result.stdout
    .split("\n")
    .filter(Boolean)
    .map((entry) => entry.replace(/^(?:\.[\\/])+/u, "").replace(/^[\\/]+/u, "").replaceAll("\\", "/"))
    .slice(0, 100);
  if (files.length === 0) return textResult("No files found", { count: 0, truncated: false });
  const truncated = files.length === 100;
  const output = files.map((entry) => path.resolve(search, entry));
  if (truncated) {
    output.push("");
    output.push(
      "(Results are truncated: showing first 100 results. Consider using a more specific path or pattern.)",
    );
  }
  return textResult(output.join("\n"), { count: files.length, truncated });
}

async function grepTool(params, context) {
  if (!params.pattern) throw new Error("pattern is required");
  const requested = resolvePath(context.cwd, params.path ?? context.cwd);
  let requestedIsDirectory = false;
  try {
    requestedIsDirectory = (await stat(requested)).isDirectory();
  } catch {
    // OpenCode still lets ripgrep report an empty or invalid target.
  }
  const cwd = requestedIsDirectory ? requested : path.dirname(requested);
  const rg = await ripgrepPath();
  const args = [
    "--no-config",
    "--json",
    "--hidden",
    "--no-messages",
    ...(params.include ? [`--glob=${params.include}`] : []),
    "--glob=!**/.git/**",
    "--",
    params.pattern,
    ".",
  ];
  const result = await runProcess(rg, args, { cwd, signal: context.signal });
  if (![0, 1, 2].includes(result.code)) throw new Error(result.stderr.trim() || `ripgrep failed with code ${result.code}`);
  if (result.code === 2 && /regex parse error|error parsing regex/.test(result.stderr)) {
    throw new Error(result.stderr.trim());
  }
  const matches = [];
  for (const line of result.stdout.split("\n")) {
    if (!line || matches.length >= 100) continue;
    if (Buffer.byteLength(line, "utf8") > 64 * 1024) throw new Error("Ripgrep JSON record exceeded 65536 bytes");
    const row = JSON.parse(line);
    if (row.type !== "match") continue;
    const relative = row.data.path.text
      .replace(/^(?:\.[\\/])+/u, "")
      .replace(/^[\\/]+/u, "")
      .replaceAll("\\", "/");
    let text = row.data.lines.text;
    if (text.length > 2000) text = `${text.slice(0, 2000).replace(/[\uD800-\uDBFF]$/, "")}...`;
    matches.push({ path: path.resolve(requestedIsDirectory ? requested : path.dirname(requested), relative), line: row.data.line_number, text });
  }
  if (matches.length === 0) return textResult("No files found", { matches: 0, truncated: false });
  const truncated = matches.length === 100;
  const output = [`Found ${matches.length} matches${truncated ? " (more matches available)" : ""}`];
  let current = "";
  for (const match of matches) {
    if (match.path !== current) {
      if (current !== "") output.push("");
      current = match.path;
      output.push(`${match.path}:`);
    }
    output.push(`  Line ${match.line}: ${match.text}`);
  }
  if (truncated) {
    output.push("");
    output.push("(Results truncated. Consider using a more specific path or pattern.)");
  }
  return textResult(output.join("\n"), { matches: matches.length, truncated });
}

function extractTextFromHtml(html) {
  let text = "";
  let skipDepth = 0;
  const parser = new Parser({
    onopentag(name) {
      if (skipDepth > 0 || ["script", "style", "noscript", "iframe", "object", "embed"].includes(name)) {
        skipDepth += 1;
      }
    },
    ontext(value) {
      if (skipDepth === 0) text += value;
    },
    onclosetag() {
      if (skipDepth > 0) skipDepth -= 1;
    },
  });
  parser.write(html);
  parser.end();
  return text.trim();
}

function htmlToMarkdown(html) {
  const turndown = new TurndownService({
    headingStyle: "atx",
    hr: "---",
    bulletListMarker: "-",
    codeBlockStyle: "fenced",
    emDelimiter: "*",
  });
  turndown.remove(["script", "style", "meta", "link"]);
  return turndown.turndown(html);
}

function fetchHeaders(format, userAgent) {
  const accepts = {
    markdown: "text/markdown;q=1.0, text/x-markdown;q=0.9, text/plain;q=0.8, text/html;q=0.7, */*;q=0.1",
    text: "text/plain;q=1.0, text/markdown;q=0.9, text/html;q=0.8, */*;q=0.1",
    html: "text/html;q=1.0, application/xhtml+xml;q=0.9, text/plain;q=0.8, text/markdown;q=0.7, */*;q=0.1",
  };
  return {
    "User-Agent": userAgent,
    Accept: accepts[format] ?? "*/*",
    "Accept-Language": "en-US,en;q=0.9",
  };
}

async function webfetchTool(params) {
  if (!params.url.startsWith("http://") && !params.url.startsWith("https://")) {
    throw new Error("URL must start with http:// or https://");
  }
  const format = params.format ?? "markdown";
  const timeout = Math.min((params.timeout ?? DEFAULT_FETCH_TIMEOUT / 1000) * 1000, MAX_FETCH_TIMEOUT);
  const browserAgent =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36";
  const request = (userAgent) =>
    fetch(params.url, {
      headers: fetchHeaders(format, userAgent),
      signal: AbortSignal.timeout(timeout),
    });
  let response;
  try {
    response = await request(browserAgent);
  } catch (error) {
    if (error?.name === "TimeoutError") throw new Error("Request timed out");
    throw error;
  }
  if (response.status === 403 && response.headers.get("cf-mitigated") === "challenge") {
    response = await request("opencode");
  }
  if (!response.ok) throw new Error(`Request failed with status ${response.status}`);
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_SIZE) {
    throw new Error("Response too large (exceeds 5MB limit)");
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > MAX_RESPONSE_SIZE) throw new Error("Response too large (exceeds 5MB limit)");
  const contentType = response.headers.get("content-type") ?? "";
  const mime = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  if (mime.startsWith("image/")) {
    return {
      content: [
        { type: "text", text: "Image fetched successfully" },
        { type: "image", data: buffer.toString("base64"), mimeType: mime },
      ],
      details: {},
    };
  }
  const content = new TextDecoder().decode(buffer);
  if (format === "markdown" && contentType.includes("text/html")) return textResult(htmlToMarkdown(content));
  if (format === "text" && contentType.includes("text/html")) return textResult(extractTextFromHtml(content));
  return textResult(content);
}

function parseSkillName(content, fallback) {
  const frontmatter = content.match(/^---\s*\n([\s\S]*?)\n---(?:\s*\n|$)/)?.[1];
  return frontmatter?.match(/^name:\s*["']?([^"'\n]+)["']?\s*$/m)?.[1].trim() ?? fallback;
}

function parseSkillContent(content) {
  return content.replace(/^---\s*\n[\s\S]*?\n---(?:\s*\n|$)/, "");
}

async function discoverSkills() {
  const configured = (process.env.OPENCODE_SKILL_PATHS ?? "")
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);
  const skills = new Map();
  skills.set("customize-opencode", {
    content: await readFile(BUILTIN_SKILL, "utf8"),
    directory: ".",
  });
  for (const root of configured) {
    let candidates = [root];
    try {
      if (!(await stat(path.join(root, "SKILL.md"))).isFile()) {
        candidates = (await readdir(root, { withFileTypes: true }))
          .filter((entry) => entry.isDirectory())
          .map((entry) => path.join(root, entry.name));
      }
    } catch {
      try {
        candidates = (await readdir(root, { withFileTypes: true }))
          .filter((entry) => entry.isDirectory())
          .map((entry) => path.join(root, entry.name));
      } catch {
        continue;
      }
    }
    for (const directory of candidates) {
      const filename = path.join(directory, "SKILL.md");
      try {
        const content = await readFile(filename, "utf8");
        skills.set(parseSkillName(content, path.basename(directory)), {
          content: parseSkillContent(content),
          directory,
        });
      } catch {
        // A candidate without SKILL.md is not a skill.
      }
    }
  }
  return skills;
}

async function skillTool(params, context) {
  const skills = await discoverSkills();
  const skill = skills.get(params.name);
  if (!skill) {
    throw new Error(
      `Skill "${params.name}" not found. Available skills: ${[...skills.keys()].sort().join(", ") || "none"}`,
    );
  }
  const rg = await ripgrepPath();
  const result = await runProcess(
    rg,
    ["--no-config", "--files", "--hidden", "--glob=!**/SKILL.md", "--glob=!**/.git/**", "."],
    { cwd: skill.directory, signal: context.signal },
  );
  const files = result.stdout
    .split("\n")
    .filter(Boolean)
    .slice(0, 10)
    .map((entry) => `<file>${path.resolve(skill.directory, entry.replace(/^\.\//, ""))}</file>`)
    .join("\n");
  return textResult(
    [
      `<skill_content name="${params.name}">`,
      `# Skill: ${params.name}`,
      "",
      skill.content.trim(),
      "",
      `Base directory for this skill: ${skill.directory}`,
      "Relative paths in this skill (e.g., scripts/, reference/) are relative to this base directory.",
      "Note: file list is sampled.",
      "",
      "<skill_files>",
      files,
      "</skill_files>",
      "</skill_content>",
    ].join("\n"),
  );
}

function taskId() {
  return `ses_${randomUUID().replaceAll("-", "").slice(0, 26)}`;
}

export function createOpenCodeToolRuntime(options = {}) {
  const todos = [];
  return {
    async execute(name, params, context) {
      let result;
      switch (name) {
        case "apply_patch":
          result = await applyPatchTool(params, context);
          break;
        case "bash":
          result = await bashTool(params, context);
          break;
        case "glob":
          result = await globTool(params, context);
          break;
        case "grep":
          result = await grepTool(params, context);
          break;
        case "read":
          result = await readTool(params, context);
          break;
        case "skill":
          result = await skillTool(params, context);
          break;
        case "task": {
          if (!["explore", "general"].includes(params.subagent_type)) {
            throw new Error(`Unknown agent type: ${params.subagent_type} is not a valid agent type`);
          }
          if (!options.runTask) throw new Error("The OpenCode-compatible task runner is not configured");
          const id = params.task_id ?? taskId();
          const output = await options.runTask({ ...params, task_id: id }, context);
          result = textResult(
            [`<task id="${id}" state="completed">`, "<task_result>", output, "</task_result>", "</task>"].join(
              "\n",
            ),
            { taskId: id },
          );
          break;
        }
        case "todowrite": {
          todos.splice(0, todos.length, ...params.todos);
          options.onTodos?.(structuredClone(todos));
          result = textResult(JSON.stringify(todos, null, 2), { todos: structuredClone(todos) });
          break;
        }
        case "webfetch":
          result = await webfetchTool(params, context);
          break;
        default:
          throw new Error(`Unknown OpenCode tool: ${name}`);
      }
      return applyGenericTruncation(result);
    },
  };
}
