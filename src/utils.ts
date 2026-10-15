import type { ReplayBatchEnvelope } from "./schema";
import type { WebReplayConfig } from "./types";

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

/**
 * Header names whose *values* are masked before any network event
 * leaves the browser. Case-insensitive. Covers cookies, auth tokens,
 * and the common API-key / CSRF header conventions — matching the
 * reference tracker's default ignore-list, extended with the API-key
 * variants we see most.
 */
export const DEFAULT_SENSITIVE_HEADERS = [
  "cookie",
  "set-cookie",
  "authorization",
  "proxy-authorization",
  "www-authenticate",
  "x-api-key",
  "api-key",
  "x-auth-token",
  "x-access-token",
  "x-csrf-token",
  "x-xsrf-token",
  "x-amz-security-token",
];

const REDACTED_HEADER = "[redacted]";

/**
 * Return a copy of `headers` with sensitive values masked. We keep the
 * key (so you can still see that an Authorization header WAS sent) but
 * never ship its value. The built-in deny-list is always applied;
 * `extra` lets a workspace add its own header names on top. Redaction
 * is ON by default — there is no opt-out that ships raw credentials.
 */
export function redactHeaders(
  headers: Record<string, string>,
  extra?: string[],
): Record<string, string> {
  const deny = new Set(
    [...DEFAULT_SENSITIVE_HEADERS, ...(extra ?? [])].map((h) =>
      h.toLowerCase(),
    ),
  );
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k] = deny.has(k.toLowerCase()) ? REDACTED_HEADER : v;
  }
  return out;
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
        new RegExp(`\\b${escapeRegExp(p)}[^&]*`, "gi"),
        `${p}[REDACTED]`,
      );
    } else {
      result = redactMatches(result, p);
    }
  }
  return result;
}

/** Replace EVERY match of `rx` with "[REDACTED]". A match that ends in "="
 *  (a key-only pattern such as `token=`, the dashboard's default kind) also
 *  takes the value after it, up to the next "&" or "#": the value is what the
 *  pattern exists to hide. */
function redactMatches(url: string, rx: RegExp): string {
  const g = new RegExp(rx.source, rx.flags.includes("g") ? rx.flags : rx.flags + "g");
  let out = "";
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = g.exec(url)) !== null) {
    if (m[0].length === 0) {
      g.lastIndex++;
      continue;
    }
    let end = m.index + m[0].length;
    if (m[0].endsWith("=")) {
      while (end < url.length && url[end] !== "&" && url[end] !== "#") end++;
      out += url.slice(last, m.index) + m[0] + "[REDACTED]";
    } else {
      out += url.slice(last, m.index) + "[REDACTED]";
    }
    last = end;
    g.lastIndex = end;
  }
  return out + url.slice(last);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

let warnedBadRedactPattern = false;

/** Compile the workspace's URL redaction patterns. One that is not a valid
 *  regular expression is skipped with a single warning: before, it threw out
 *  of the remote-config handler, so none of the dashboard's privacy settings
 *  applied on that page. */
export function compileRedactPatterns(patterns: readonly string[]): RegExp[] {
  const out: RegExp[] = [];
  for (const p of patterns) {
    try {
      out.push(new RegExp(p, "i"));
    } catch {
      if (!warnedBadRedactPattern) {
        warnedBadRedactPattern = true;
        console.warn("[replay-sdk] skipped an invalid URL redaction pattern:", p);
      }
    }
  }
  return out;
}

/** Query-string keys whose VALUES are ALWAYS scrubbed from any captured URL,
 *  with zero configuration — credentials that must never be stored server-side.
 *  Matched case-insensitively. Mirrors the reference tracker's default URL
 *  sanitizer (tokens leaking into stored nav/entry URLs is a real exposure). */
export const DEFAULT_SENSITIVE_QUERY_KEYS = [
  "jwt", "token", "access_token", "refresh_token", "id_token", "auth",
  "authorization", "password", "passwd", "pwd", "secret", "api_key", "apikey",
  "invitation", "invite", "reset-password", "reset_password", "otp", "sig",
  "signature", "code", "state",
];

const CC_RE = /\b(?:\d[ -]?){13,19}\b/g;

function luhnValid(num: string): boolean {
  let sum = 0;
  let alt = false;
  for (let i = num.length - 1; i >= 0; i -= 1) {
    let d = num.charCodeAt(i) - 48;
    if (alt) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    alt = !alt;
  }
  return sum % 10 === 0;
}

/** Mask any 13–19 digit run that passes the Luhn check (a real card number),
 *  leaving other long digit strings (order ids, timestamps) intact. */
export function scrubCreditCards(text: string): string {
  return text.replace(CC_RE, (m) => {
    const digits = m.replace(/\D/g, "");
    return digits.length >= 13 && digits.length <= 19 && luhnValid(digits)
      ? "[REDACTED_CC]"
      : m;
  });
}

/** Parse a possibly-relative URL, mutate its query, and re-serialize preserving
 *  absolute-vs-relative form. Returns the input unchanged on parse failure. */
function editQuery(url: string, edit: (q: URLSearchParams) => boolean): string {
  try {
    const absolute = /^[a-z][a-z0-9+.-]*:\/\//i.test(url);
    const u = new URL(url, "http://_local_");
    if (!edit(u.searchParams)) return url;
    return absolute ? u.toString() : u.pathname + u.search + u.hash;
  } catch {
    return url;
  }
}

/** Redact a URL before it is stored. Always masks the built-in sensitive query
 *  keys; then applies the workspace policy: strip all query params except an
 *  allowlist, custom redact patterns, and a Luhn-checked credit-card scrub. */
export function redactUrlForStorage(
  url: string,
  policy?: {
    strip?: boolean;
    allowed?: string[];
    blockCC?: boolean;
    patterns?: Array<string | RegExp>;
  },
): string {
  let out = editQuery(url, (q) => {
    const keys: string[] = [];
    q.forEach((_v, k) => keys.push(k));
    let changed = false;
    for (const k of keys) {
      if (DEFAULT_SENSITIVE_QUERY_KEYS.includes(k.toLowerCase())) {
        q.set(k, "[REDACTED]");
        changed = true;
      }
    }
    return changed;
  });
  if (policy?.strip) {
    const allow = new Set((policy.allowed ?? []).map((a) => a.toLowerCase()));
    out = editQuery(out, (q) => {
      const keys: string[] = [];
      q.forEach((_v, k) => keys.push(k));
      let changed = false;
      for (const k of keys) {
        if (!allow.has(k.toLowerCase())) {
          q.delete(k);
          changed = true;
        }
      }
      return changed;
    });
  }
  if (policy?.patterns && policy.patterns.length > 0) {
    out = withRedactedUrl(out, policy.patterns);
  }
  if (policy?.blockCC) out = scrubCreditCards(out);
  return out;
}

/**
 * Derive the dashboard app host from the ingest/API host, mirroring the mobile
 * SDKs: `https://api.replayfy.app` → `https://app.replayfy.app`. A host that does
 * not start with `api.` (self-hosted / custom) is returned unchanged.
 */
export function dashboardHostFromApiHost(apiHost: string): string {
  try {
    const u = new URL(apiHost);
    if (u.hostname.startsWith("api.")) {
      u.hostname = "app." + u.hostname.slice(4);
    }
    return u.origin;
  } catch {
    return apiHost.replace(/\/+$/, "");
  }
}

/** Exact UTF-8 byte length of a string (what a request body actually costs).
 *  `.length` counts UTF-16 units, which undercounts non-ASCII text up to 3x. */
export function utf8Bytes(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        n += 4; // a surrogate pair is one 4-byte code point
        i += 1;
      } else n += 3; // lone surrogate: encoded as U+FFFD
    } else n += 3;
  }
  return n;
}

let beforeSendWarned = false;

/**
 * Run the host's `beforeSend` hook on a batch, for EVERY send path (the regular
 * flush and the hide/unload batch alike). Fails closed: a hook that throws,
 * returns a Promise (it must be synchronous) or returns no events drops the
 * batch instead of sending what the scrubber didn't finish. Warns once per page.
 */
export function applyBeforeSend(
  hook: WebReplayConfig["beforeSend"],
  envelope: ReplayBatchEnvelope,
): ReplayBatchEnvelope | null {
  if (!hook) return envelope;
  let out: unknown;
  try {
    out = hook({ envelope });
  } catch (e) {
    warnBeforeSend(`beforeSend threw, batch dropped: ${String(e)}`);
    return null;
  }
  if (out && typeof (out as { then?: unknown }).then === "function") {
    warnBeforeSend("beforeSend must be synchronous; batch dropped");
    return null;
  }
  const next = (out as { envelope?: ReplayBatchEnvelope } | null)?.envelope;
  return next && Array.isArray(next.events) && next.events.length > 0
    ? next
    : null;
}

/**
 * `applyBeforeSend` on a copy of the batch, for events the SDK keeps when they
 * aren't sent (the hide/unload batch: a try that doesn't fit is retried
 * smaller, and what is refused goes back to the buffer). A hook that edits the
 * events in place then never runs on its own output when they go out later.
 * The copy costs one serialization of the batch: a hide/unload batch fits the
 * keepalive budget, and a resend (recheckBeforeSend) only follows a failure.
 */
export function applyBeforeSendToCopy(
  hook: WebReplayConfig["beforeSend"],
  envelope: ReplayBatchEnvelope,
): ReplayBatchEnvelope | null {
  if (!hook) return envelope;
  // The events are plain JSON (they are sent as JSON), so this is a deep copy.
  const copy = JSON.parse(JSON.stringify(envelope)) as ReplayBatchEnvelope;
  return applyBeforeSend(hook, copy);
}

/**
 * `beforeSend` for a batch the hook already ran on, resent under the same
 * sequence (a failed upload's retry). The hook still decides WHETHER it goes —
 * one that now returns null (consent withdrawn, an opt-out) drops it — but not
 * what goes: the batch is resent exactly as first sent, since a hook that
 * isn't idempotent (one that hashes a value) would change it under a number
 * the server may already hold. The hook gets a copy, so editing it in place
 * can't change the held batch either.
 */
export function recheckBeforeSend(
  hook: WebReplayConfig["beforeSend"],
  envelope: ReplayBatchEnvelope,
): ReplayBatchEnvelope | null {
  return applyBeforeSendToCopy(hook, envelope) ? envelope : null;
}

function warnBeforeSend(message: string): void {
  if (beforeSendWarned) return;
  beforeSendWarned = true;
  // eslint-disable-next-line no-console
  console.warn(`[replay-sdk] ${message}`);
}

/**
 * `s` cut to at most `max` UTF-16 units without splitting a surrogate pair. A
 * plain `slice` through an emoji leaves half of it, and the ingest stores reject
 * the whole batch over that one character (this broke real click labels).
 */
export function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}
