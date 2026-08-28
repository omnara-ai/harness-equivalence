function responseEvents(rawResponse) {
  const events = [];
  for (const line of rawResponse.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    try {
      events.push(JSON.parse(data));
    } catch {
      // Ignore non-JSON SSE data.
    }
  }
  return events;
}

function completedItems(events) {
  const items = events
    .filter((event) => event.type === "response.output_item.done" && event.item)
    .map((event) => event.item);
  if (items.length > 0) return items;

  const completed = events.findLast((event) => event.type === "response.completed");
  return Array.isArray(completed?.response?.output) ? completed.response.output : [];
}

function relativeWorkspacePath(value) {
  if (typeof value !== "string") return value;
  for (const marker of ["/fixture/", "\\fixture\\"]) {
    const index = value.lastIndexOf(marker);
    if (index >= 0) return value.slice(index + marker.length);
  }
  if (value.endsWith("/fixture") || value.endsWith("\\fixture")) return ".";
  return value;
}

function cleanToolArguments(value, key) {
  if (Array.isArray(value)) return value.map((item) => cleanToolArguments(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, item]) => [
        childKey,
        cleanToolArguments(item, childKey),
      ]),
    );
  }
  return ["filePath", "path", "workdir"].includes(key)
    ? relativeWorkspacePath(value)
    : value;
}

function toolArguments(item) {
  const raw = item.arguments ?? item.input;
  if (typeof raw !== "string") return raw === undefined ? "" : JSON.stringify(raw);
  try {
    return JSON.stringify(cleanToolArguments(JSON.parse(raw)));
  } catch {
    return raw;
  }
}

function messageText(item) {
  return (item.content ?? [])
    .filter((content) => content.type === "output_text" || content.type === "refusal")
    .map((content) => content.text ?? content.refusal ?? "")
    .join("");
}

function displayItem(item) {
  if (item.type === "reasoning") return undefined;
  if (item.type === "message") {
    const text = messageText(item);
    if (!text) return undefined;
    const label = item.phase === "commentary" ? "commentary" : "final";
    return `[${label}] ${text}`;
  }
  if (item.type === "function_call" || item.type === "custom_tool_call") {
    const arguments_ = toolArguments(item);
    return `[tool] ${item.name}${arguments_ ? ` ${arguments_}` : ""}`;
  }
  if (item.type?.endsWith("_call")) return `[tool] ${item.type}`;
  return undefined;
}

export function formatModelResponse(rawResponse) {
  const output = completedItems(responseEvents(rawResponse)).map(displayItem).filter(Boolean);
  return output.length > 0 ? output.join("\n") : "(no visible output)";
}
