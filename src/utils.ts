/**
 * Convert a single console.log argument into something JSON-safe.
 *
 * We preserve structure (objects stay objects, arrays stay arrays) so the
 * dashboard can render a collapsible tree instead of a stringified blob.
 * Errors keep their stack trace. Functions, DOM nodes, and circular refs
 * fall back to a readable label so they don't explode JSON.stringify.
 */
export function serializeConsoleArg(value: unknown): unknown {
  if (value instanceof Error) {
    return {
      __type: "Error",
      name: value.name,
      message: value.message,
      stack: value.stack,
    };
  }
  if (typeof value === "function")
    return `[Function ${value.name || "anonymous"}]`;
  if (typeof value === "undefined") return "undefined";
  if (typeof value === "symbol") return value.toString();
  if (typeof value === "bigint") return `${value.toString()}n`;
  if (value === null) return null;
  if (typeof value !== "object") return value;
  if (value instanceof Date)
    return { __type: "Date", iso: value.toISOString() };
  if (value instanceof RegExp)
    return { __type: "RegExp", source: value.toString() };
  if (typeof Node !== "undefined" && value instanceof Node) {
    const el = value as Element;
    return `[${el.tagName?.toLowerCase() ?? "Node"}${el.id ? "#" + el.id : ""}]`;
  }
  // Strip circular refs with a WeakSet — JSON.stringify throws otherwise.
  const seen = new WeakSet();
  try {
    return JSON.parse(
      JSON.stringify(value, (_k, v) => {
        if (typeof v === "object" && v !== null) {
          if (seen.has(v)) return "[Circular]";
          seen.add(v);
        }
        if (typeof v === "bigint") return `${v.toString()}n`;
        if (typeof v === "function")
          return `[Function ${(v as { name?: string }).name || "anonymous"}]`;
        return v;
      }),
    );
  } catch {
    return String(value);
  }
}

/**
 * Format a serialized arg for the human-readable `message` string the
 * console panel falls back to when it doesn't render the tree. Strings
 * pass through; objects/arrays become compact JSON; primitives use String().
 */
export function formatConsoleArg(value: unknown): string {
  if (value == null) return String(value);
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean")
    return String(value);
  if (typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return "[Unserialisable]";
    }
  }
  return String(value);
}

export function toHeaderRecord(headers: Headers): Record<string, string> {
  const record: Record<string, string> = {};
  headers.forEach((value, key) => {
    record[key] = value;
  });
  return record;
}

export function withRedactedUrl(
  url: string,
  patterns: Array<string | RegExp> | undefined,
): string {
  if (!patterns || patterns.length === 0) return url;
  let result = url;
  for (const p of patterns) {
    if (typeof p === "string") {
      // Replace `key=value` substrings (treat string as a key name).
      result = result.replace(
        new RegExp(`\\b${p}[^&]*`, "gi"),
        `${p}[REDACTED]`,
      );
    } else {
      result = result.replace(p, "[REDACTED]");
    }
  }
  return result;
}
