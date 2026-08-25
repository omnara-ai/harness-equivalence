// This replacement algorithm is adapted from OpenCode's MIT-licensed edit tool
// at commit 18b4cb6819d7de0b37927fef60d03927e678c9dd. See THIRD_PARTY_NOTICE.md.

const SINGLE_CANDIDATE_SIMILARITY_THRESHOLD = 0.65;
const MULTIPLE_CANDIDATES_SIMILARITY_THRESHOLD = 0.65;

function levenshtein(left, right) {
  if (left === "" || right === "") return Math.max(left.length, right.length);
  const matrix = Array.from({ length: left.length + 1 }, (_, row) =>
    Array.from({ length: right.length + 1 }, (_, column) =>
      row === 0 ? column : column === 0 ? row : 0,
    ),
  );

  for (let row = 1; row <= left.length; row += 1) {
    for (let column = 1; column <= right.length; column += 1) {
      const cost = left[row - 1] === right[column - 1] ? 0 : 1;
      matrix[row][column] = Math.min(
        matrix[row - 1][column] + 1,
        matrix[row][column - 1] + 1,
        matrix[row - 1][column - 1] + cost,
      );
    }
  }
  return matrix[left.length][right.length];
}

function* simpleReplacer(_content, find) {
  yield find;
}

function* lineTrimmedReplacer(content, find) {
  const originalLines = content.split("\n");
  const searchLines = find.split("\n");
  if (searchLines.at(-1) === "") searchLines.pop();

  for (let index = 0; index <= originalLines.length - searchLines.length; index += 1) {
    let matches = true;
    for (let offset = 0; offset < searchLines.length; offset += 1) {
      if (originalLines[index + offset].trim() !== searchLines[offset].trim()) {
        matches = false;
        break;
      }
    }
    if (!matches) continue;

    let start = 0;
    for (let line = 0; line < index; line += 1) start += originalLines[line].length + 1;
    let end = start;
    for (let line = 0; line < searchLines.length; line += 1) {
      end += originalLines[index + line].length;
      if (line < searchLines.length - 1) end += 1;
    }
    yield content.substring(start, end);
  }
}

function* blockAnchorReplacer(content, find) {
  const originalLines = content.split("\n");
  const searchLines = find.split("\n");
  if (searchLines.length < 3) return;
  if (searchLines.at(-1) === "") searchLines.pop();

  const first = searchLines[0].trim();
  const last = searchLines.at(-1).trim();
  const searchBlockSize = searchLines.length;
  const maxLineDelta = Math.max(1, Math.floor(searchBlockSize * 0.25));
  const candidates = [];

  for (let start = 0; start < originalLines.length; start += 1) {
    if (originalLines[start].trim() !== first) continue;
    for (let end = start + 2; end < originalLines.length; end += 1) {
      if (originalLines[end].trim() !== last) continue;
      if (Math.abs(end - start + 1 - searchBlockSize) <= maxLineDelta) candidates.push({ start, end });
      break;
    }
  }
  if (candidates.length === 0) return;

  const similarityFor = ({ start, end }, stopEarly) => {
    const actualBlockSize = end - start + 1;
    const linesToCheck = Math.min(searchBlockSize - 2, actualBlockSize - 2);
    if (linesToCheck <= 0) return 1;
    let similarity = 0;
    for (let line = 1; line < searchBlockSize - 1 && line < actualBlockSize - 1; line += 1) {
      const original = originalLines[start + line].trim();
      const search = searchLines[line].trim();
      const maxLength = Math.max(original.length, search.length);
      if (maxLength !== 0) similarity += 1 - levenshtein(original, search) / maxLength;
      if (stopEarly && similarity / linesToCheck >= SINGLE_CANDIDATE_SIMILARITY_THRESHOLD) break;
    }
    return similarity / linesToCheck;
  };

  let match;
  if (candidates.length === 1) {
    if (similarityFor(candidates[0], true) < SINGLE_CANDIDATE_SIMILARITY_THRESHOLD) return;
    match = candidates[0];
  } else {
    let best = -1;
    for (const candidate of candidates) {
      const similarity = similarityFor(candidate, false);
      if (similarity > best) {
        best = similarity;
        match = candidate;
      }
    }
    if (best < MULTIPLE_CANDIDATES_SIMILARITY_THRESHOLD) return;
  }

  let startIndex = 0;
  for (let line = 0; line < match.start; line += 1) startIndex += originalLines[line].length + 1;
  let endIndex = startIndex;
  for (let line = match.start; line <= match.end; line += 1) {
    endIndex += originalLines[line].length;
    if (line < match.end) endIndex += 1;
  }
  yield content.substring(startIndex, endIndex);
}

function* whitespaceNormalizedReplacer(content, find) {
  const normalize = (value) => value.replace(/\s+/g, " ").trim();
  const normalizedFind = normalize(find);
  const lines = content.split("\n");

  for (const line of lines) {
    if (normalize(line) === normalizedFind) {
      yield line;
      continue;
    }
    if (!normalize(line).includes(normalizedFind)) continue;
    const words = find.trim().split(/\s+/);
    if (words.length === 0) continue;
    const pattern = words.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+");
    try {
      const match = line.match(new RegExp(pattern));
      if (match) yield match[0];
    } catch {
      // Ignore malformed fallback patterns.
    }
  }

  const findLines = find.split("\n");
  if (findLines.length <= 1) return;
  for (let index = 0; index <= lines.length - findLines.length; index += 1) {
    const block = lines.slice(index, index + findLines.length).join("\n");
    if (normalize(block) === normalizedFind) yield block;
  }
}

function* indentationFlexibleReplacer(content, find) {
  const removeIndentation = (value) => {
    const lines = value.split("\n");
    const nonempty = lines.filter((line) => line.trim().length > 0);
    if (nonempty.length === 0) return value;
    const minimum = Math.min(...nonempty.map((line) => line.match(/^(\s*)/)?.[1].length ?? 0));
    return lines.map((line) => (line.trim().length === 0 ? line : line.slice(minimum))).join("\n");
  };
  const normalizedFind = removeIndentation(find);
  const contentLines = content.split("\n");
  const findLines = find.split("\n");
  for (let index = 0; index <= contentLines.length - findLines.length; index += 1) {
    const block = contentLines.slice(index, index + findLines.length).join("\n");
    if (removeIndentation(block) === normalizedFind) yield block;
  }
}

function* escapeNormalizedReplacer(content, find) {
  const unescape = (value) =>
    value.replace(/\\(n|t|r|'|"|`|\\|\n|\$)/g, (match, character) => {
      const values = { n: "\n", t: "\t", r: "\r", "'": "'", '"': '"', "`": "`", "\\": "\\", "\n": "\n", $: "$" };
      return values[character] ?? match;
    });
  const unescapedFind = unescape(find);
  if (content.includes(unescapedFind)) yield unescapedFind;
  const lines = content.split("\n");
  const findLines = unescapedFind.split("\n");
  for (let index = 0; index <= lines.length - findLines.length; index += 1) {
    const block = lines.slice(index, index + findLines.length).join("\n");
    if (unescape(block) === unescapedFind) yield block;
  }
}

function* trimmedBoundaryReplacer(content, find) {
  const trimmed = find.trim();
  if (trimmed === find) return;
  if (content.includes(trimmed)) yield trimmed;
  const lines = content.split("\n");
  const findLines = find.split("\n");
  for (let index = 0; index <= lines.length - findLines.length; index += 1) {
    const block = lines.slice(index, index + findLines.length).join("\n");
    if (block.trim() === trimmed) yield block;
  }
}

function* contextAwareReplacer(content, find) {
  const findLines = find.split("\n");
  if (findLines.length < 3) return;
  if (findLines.at(-1) === "") findLines.pop();
  const contentLines = content.split("\n");
  const first = findLines[0].trim();
  const last = findLines.at(-1).trim();

  for (let start = 0; start < contentLines.length; start += 1) {
    if (contentLines[start].trim() !== first) continue;
    for (let end = start + 2; end < contentLines.length; end += 1) {
      if (contentLines[end].trim() !== last) continue;
      const blockLines = contentLines.slice(start, end + 1);
      if (blockLines.length === findLines.length) {
        let matching = 0;
        let total = 0;
        for (let line = 1; line < blockLines.length - 1; line += 1) {
          const actual = blockLines[line].trim();
          const expected = findLines[line].trim();
          if (actual.length === 0 && expected.length === 0) continue;
          total += 1;
          if (actual === expected) matching += 1;
        }
        if (total === 0 || matching / total >= 0.5) yield blockLines.join("\n");
      }
      break;
    }
  }
}

function* multiOccurrenceReplacer(content, find) {
  let start = 0;
  while (true) {
    const index = content.indexOf(find, start);
    if (index === -1) return;
    yield find;
    start = index + find.length;
  }
}

function isDisproportionateMatch(search, oldString) {
  const oldLines = oldString.split("\n").length;
  const searchLines = search.split("\n").length;
  if (searchLines >= Math.max(oldLines + 3, oldLines * 2)) return true;
  if (oldLines === 1) return false;
  return search.trim().length > Math.max(oldString.trim().length + 500, oldString.trim().length * 4);
}

export function replaceOpenCodeStyle(content, oldString, newString, replaceAll = false) {
  if (oldString === newString) {
    throw new Error("No changes to apply: oldString and newString are identical.");
  }
  if (oldString === "") {
    throw new Error(
      "oldString cannot be empty when editing an existing file. Provide the exact text to replace, or use write for an intentional full-file replacement.",
    );
  }

  let notFound = true;
  const replacers = [
    simpleReplacer,
    lineTrimmedReplacer,
    blockAnchorReplacer,
    whitespaceNormalizedReplacer,
    indentationFlexibleReplacer,
    escapeNormalizedReplacer,
    trimmedBoundaryReplacer,
    contextAwareReplacer,
    multiOccurrenceReplacer,
  ];

  for (const replacer of replacers) {
    for (const search of replacer(content, oldString)) {
      const index = content.indexOf(search);
      if (index === -1) continue;
      notFound = false;
      if (isDisproportionateMatch(search, oldString)) {
        throw new Error(
          "Refusing replacement because the matched span is much larger than oldString. Re-read the file and provide the full exact oldString for the intended replacement.",
        );
      }
      if (replaceAll) return content.replaceAll(search, newString);
      if (index !== content.lastIndexOf(search)) continue;
      return content.substring(0, index) + newString + content.substring(index + search.length);
    }
  }

  if (notFound) {
    throw new Error(
      "Could not find oldString in the file. It must match exactly, including whitespace, indentation, and line endings.",
    );
  }
  throw new Error("Found multiple matches for oldString. Provide more surrounding context to make the match unique.");
}
