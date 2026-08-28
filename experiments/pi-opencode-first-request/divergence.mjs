import { isDeepStrictEqual } from "node:util";

function firstDifference(left, right, path = []) {
  if (isDeepStrictEqual(left, right)) return undefined;

  if (Array.isArray(left) && Array.isArray(right)) {
    const length = Math.max(left.length, right.length);
    for (let index = 0; index < length; index += 1) {
      const difference = firstDifference(left[index], right[index], [...path, index]);
      if (difference) return difference;
    }
  }

  if (left && right && typeof left === "object" && typeof right === "object") {
    const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort();
    for (const key of keys) {
      const difference = firstDifference(left[key], right[key], [...path, key]);
      if (difference) return difference;
    }
  }

  return path;
}

function valueAt(root, path) {
  let current = root;
  for (const segment of path) {
    if (current === null || typeof current !== "object" || !Object.hasOwn(current, segment)) {
      return { present: false };
    }
    current = current[segment];
  }
  return { present: true, value: current };
}

function pathLabel(path) {
  return path.reduce((label, segment) => {
    if (typeof segment === "number") return `${label}[${segment}]`;
    if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(segment)) return `${label}.${segment}`;
    return `${label}[${JSON.stringify(segment)}]`;
  }, "$");
}

function conversationItemKind(item) {
  if (!item || typeof item !== "object") return "conversation item";
  if (item.type === "function_call_output" || item.role === "tool") return "tool result";
  if (item.type === "function_call" || Array.isArray(item.tool_calls)) return "tool call";
  if (item.type === "reasoning" || item.role === "assistant") return "model output";
  if (["system", "developer", "user"].includes(item.role)) return "model input";
  return "conversation item";
}

function replacementFor(openCodeRequest, piRequest, differencePath) {
  if (
    ["input", "messages"].includes(differencePath[0]) &&
    Number.isInteger(differencePath[1])
  ) {
    const path = [differencePath[0], differencePath[1]];
    const openCodeItem = valueAt(openCodeRequest, path);
    const piItem = valueAt(piRequest, path);
    return {
      kind: conversationItemKind(openCodeItem.value ?? piItem.value),
      path,
    };
  }

  if (differencePath[0] === "tools") {
    const path = Number.isInteger(differencePath[1])
      ? ["tools", differencePath[1]]
      : ["tools"];
    return { kind: "tool definition", path };
  }

  return {
    kind: differencePath[0] === "model" ? "model selection" : "model request",
    path: differencePath.length > 0 ? [differencePath[0]] : [],
  };
}

function comparableValue(value) {
  return value.present
    ? { present: true, value: value.value }
    : { present: false, value: null };
}

export function describeDivergence(openCodeRequest, piRequest, requestOrdinal) {
  const differencePath = firstDifference(openCodeRequest, piRequest);
  if (!differencePath) return undefined;

  const replacement = replacementFor(openCodeRequest, piRequest, differencePath);
  return {
    request: requestOrdinal,
    kind: replacement.kind,
    pointer: pathLabel(replacement.path),
    detailPointer: pathLabel(differencePath),
    replacementPath: replacement.path,
    openCode: comparableValue(valueAt(openCodeRequest, replacement.path)),
    pi: comparableValue(valueAt(piRequest, replacement.path)),
  };
}

export function replaceWithOpenCodeValue(piRequest, openCodeRequest, replacementPath) {
  const source = valueAt(openCodeRequest, replacementPath);
  if (replacementPath.length === 0) {
    return source.present ? structuredClone(source.value) : undefined;
  }

  const result = structuredClone(piRequest);
  let parent = result;
  for (let index = 0; index < replacementPath.length - 1; index += 1) {
    const segment = replacementPath[index];
    const next = replacementPath[index + 1];
    if (parent[segment] === null || typeof parent[segment] !== "object") {
      parent[segment] = typeof next === "number" ? [] : {};
    }
    parent = parent[segment];
  }

  const last = replacementPath.at(-1);
  if (source.present) {
    if (Array.isArray(parent) && typeof last === "number" && last >= parent.length) {
      parent.splice(last, 0, structuredClone(source.value));
    } else {
      parent[last] = structuredClone(source.value);
    }
  } else if (Array.isArray(parent) && typeof last === "number") {
    parent.splice(last, 1);
  } else {
    delete parent[last];
  }
  return result;
}

export function valueAtPathMatches(root, path, expected) {
  const actual = valueAt(root, path);
  return (
    actual.present === expected.present &&
    (!actual.present || isDeepStrictEqual(actual.value, expected.value))
  );
}

export function createDivergenceController(onDivergence) {
  let handled = false;
  let acceptedOverride;

  return async function resolveDivergence(openCodeRequest, piRequest, requestOrdinal) {
    let effectiveBody = piRequest;
    let overrideApplied = false;

    if (
      acceptedOverride &&
      valueAtPathMatches(piRequest, acceptedOverride.replacementPath, acceptedOverride.pi)
    ) {
      effectiveBody = replaceWithOpenCodeValue(
        effectiveBody,
        openCodeRequest,
        acceptedOverride.replacementPath,
      );
      overrideApplied = true;
    }

    if (isDeepStrictEqual(openCodeRequest, effectiveBody) || handled || !onDivergence) {
      return { effectiveBody, overrideApplied };
    }

    const divergence = describeDivergence(openCodeRequest, effectiveBody, requestOrdinal);
    if (!divergence) return { effectiveBody, overrideApplied };

    handled = true;
    const useOpenCode = Boolean(await onDivergence(divergence));
    if (useOpenCode) {
      acceptedOverride = {
        replacementPath: divergence.replacementPath,
        pi: divergence.pi,
      };
      effectiveBody = replaceWithOpenCodeValue(
        effectiveBody,
        openCodeRequest,
        divergence.replacementPath,
      );
      overrideApplied = true;
    }

    return {
      effectiveBody,
      overrideApplied,
      decision: {
        ...divergence,
        decision: useOpenCode ? "use-opencode" : "keep-pi",
        effectiveRequestMatches: isDeepStrictEqual(openCodeRequest, effectiveBody),
      },
    };
  };
}
