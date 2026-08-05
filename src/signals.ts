import { parse } from "error-stack-parser-es";
import type {
  ConsoleEventData,
  ErrorEventData,
  NavigationEventData,
  NetworkEventData,
  StackFrame,
} from "./schema";
import type { WebReplayConfig } from "./types";
import {
  formatConsoleArg,
  redactHeaders,
  serializeConsoleArg,
  toHeaderRecord,
  redactUrlForStorage,
} from "./utils";

type StopHandle = () => void;

export function createConsoleCapture(
  onEvent: (data: ConsoleEventData) => void,
): StopHandle {
  const methods: Array<ConsoleEventData["level"]> = [
    "log",
    "info",
    "warn",
    "error",
    "debug",
  ];
  const originals = new Map<
    ConsoleEventData["level"],
    (...args: unknown[]) => void
  >();

  for (const level of methods) {
    originals.set(level, console[level].bind(console));
    console[level] = (...args: unknown[]) => {
      const serialized = args.map((arg) => serializeConsoleArg(arg));
      onEvent({
        level,
        // formatConsoleArg renders each arg as JSON when it's an object —
        // gives us a real `{"foo":1,"bar":2}` in `message` instead of the
        // `[object Object]` you get from Array.prototype.join.
        message: serialized.map(formatConsoleArg).join(" "),
        args: serialized,
        stack: level === "error" ? new Error().stack : undefined,
      });
      originals.get(level)?.(...args);
    };
  }

  return () => {
    for (const level of methods) {
      const original = originals.get(level);
      if (original) {
        console[level] = original;
      }
    }
  };
}

/**
 * Parse an Error's stack into normalised frames. Wrapped because
 * `parse()` throws on malformed / empty stacks (cross-origin "Script
 * error.", synthetic errors) — we degrade to no frames rather than
 * losing the whole error.
 */
function framesFromError(error: Error): StackFrame[] {
  try {
    return parse(error).map((f) => ({
      functionName: f.functionName,
      fileName: f.fileName,
      lineNumber: f.lineNumber,
      columnNumber: f.columnNumber,
    }));
  } catch {
    return [];
  }
}

/**
 * Split a stackless error string like "TypeError: x is undefined" into
 * {name, message}. Only treats the prefix as an error name when it
 * genuinely looks like one (single identifier, or *Error suffix) — so a
 * message that merely contains a URL ("failed: https://…") isn't
 * mis-split. This is deliberately stricter than the reference, which
 * naively splits on the first ":" and mangles such messages.
 */
function splitErrorName(raw: string): { name: string; message: string } {
  const idx = raw.indexOf(":");
  if (idx > 0) {
    const prefix = raw.slice(0, idx).trim();
    const looksLikeName =
      /Error$/.test(prefix) ||
      (/^[A-Za-z_$][\w$]*$/.test(prefix) && !prefix.includes("/"));
    if (looksLikeName) {
      return { name: prefix, message: raw.slice(idx + 1).trim() };
    }
  }
  return { name: "Error", message: raw };
}

/**
 * Build an ErrorEventData from an arbitrary caught/thrown value. Shared by the
 * public captureException so a developer-reported error is byte-identical to an
 * uncaught one (same name/message/stack/frames parsing) apart from `handled`.
 */
export function errorDataFromValue(
  value: unknown,
  handled: boolean,
): ErrorEventData {
  if (value instanceof Error) {
    return {
      kind: "error",
      name: value.name || "Error",
      message: value.message || String(value),
      stack: value.stack,
      frames: framesFromError(value),
      handled,
    };
  }
  // Non-Error thrown value: serialise best-effort; there is no stack to parse.
  let raw: string;
  try {
    raw = typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    raw = String(value);
  }
  const { name, message } = splitErrorName(raw || "");
  return {
    kind: "error",
    name: name || "Error",
    message: message || raw || String(value),
    frames: [],
    handled,
  };
}

export function createErrorCapture(
  onEvent: (data: ErrorEventData) => void,
): StopHandle {
  const onError = (event: ErrorEvent) => {
    // Preferred path: a real Error object with a parseable stack.
    if (event.error instanceof Error) {
      const err = event.error;
      onEvent({
        kind: "error",
        name: err.name || "Error",
        message: err.message || event.message,
        stack: err.stack,
        frames: framesFromError(err),
      });
      return;
    }
    // Fallback: no Error object (thrown non-Error, or a cross-origin
    // "Script error." with details stripped). Synthesize one frame from
    // the event's filename/line/column so the throw site is still known.
    const { name, message } = splitErrorName(event.message || "");
    const frames: StackFrame[] = [];
    if (event.filename || event.lineno || event.colno) {
      frames.push({
        fileName: event.filename || undefined,
        lineNumber: event.lineno || undefined,
        columnNumber: event.colno || undefined,
      });
    }
    onEvent({ kind: "error", name, message, frames });
  };

  const onRejection = (event: PromiseRejectionEvent) => {
    const reason = event.reason;
    if (reason instanceof Error) {
      onEvent({
        kind: "unhandledrejection",
        name: reason.name || "UnhandledRejection",
        message: reason.message,
        stack: reason.stack,
        frames: framesFromError(reason),
      });
      return;
    }
    // Non-Error rejection value — serialise it best-effort for the
    // message; there is no stack to parse.
    let message: string;
    try {
      message = typeof reason === "string" ? reason : JSON.stringify(reason);
    } catch {
      message = String(reason);
    }
    onEvent({
      kind: "unhandledrejection",
      name: "UnhandledRejection",
      message: message || String(reason),
      frames: [],
    });
  };

  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onRejection);

  return () => {
    window.removeEventListener("error", onError);
    window.removeEventListener("unhandledrejection", onRejection);
  };
}

export function createNavigationCapture(
  onEvent: (data: NavigationEventData) => void,
): StopHandle {
  const originalPushState = history.pushState.bind(history);
  const originalReplaceState = history.replaceState.bind(history);
  let currentUrl = window.location.href;

  const emit = (trigger: NavigationEventData["trigger"]) => {
    const nextUrl = window.location.href;
    // Skip no-op emits: a pushState/replaceState that doesn't change the URL
    // (common — routers re-push the same route) shouldn't create a screen event.
    // 'load' always emits (it's the entry).
    if (trigger !== "load" && nextUrl === currentUrl) return;
    onEvent({
      // Scrub credentials out of the stored URLs (tokens/reset-links routinely
      // ride in the query string). Default key scrub — always on, no config.
      from: redactUrlForStorage(currentUrl),
      to: redactUrlForStorage(nextUrl),
      trigger,
    });
    currentUrl = nextUrl;
  };

  history.pushState = (...args) => {
    originalPushState(...args);
    emit("pushState");
  };

  history.replaceState = (...args) => {
    originalReplaceState(...args);
    emit("replaceState");
  };

  const onPopState = () => emit("popstate");
  const onHashChange = () => emit("hashchange");

  window.addEventListener("popstate", onPopState);
  window.addEventListener("hashchange", onHashChange);
  emit("load");

  return () => {
    history.pushState = originalPushState;
    history.replaceState = originalReplaceState;
    window.removeEventListener("popstate", onPopState);
    window.removeEventListener("hashchange", onHashChange);
  };
}

export function createViewportCapture(onEvent: () => void): StopHandle {
  window.addEventListener("resize", onEvent);
  return () => {
    window.removeEventListener("resize", onEvent);
  };
}

/**
 * Rage / dead click detector.
 *
 * Rage clicks = ≥3 clicks on roughly the same coordinates within 1 s.
 *   Users do this when something they tap doesn't respond — a clear signal
 *   the page is broken or unresponsive.
 *
 * Dead clicks = a click that produced no visible mutation in the next
 *   ~500 ms. We can't introspect React renders, but we can listen for the
 *   browser's MutationObserver — if zero mutations fire, we call it dead.
 *
 * Both fire as custom rrweb events ({ kind: 'rage_click' | 'dead_click' }).
 * The persistence service increments session.rageCount / deadCount based
 * on these.
 */
type RageDeadEmit = (data: {
  kind: "rage_click" | "dead_click";
  x: number;
  y: number;
  selector: string;
  count?: number;
}) => void;

export function createRageDeadClickCapture(onEvent: RageDeadEmit): StopHandle {
  const recent: Array<{ x: number; y: number; ts: number }> = [];
  const PROXIMITY_PX = 24;
  const RAGE_WINDOW_MS = 1000;
  const DEAD_OBSERVE_MS = 500;

  const observer = new MutationObserver(() => {
    /* presence is what matters */
  });
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    characterData: true,
  });

  const onClick = (ev: MouseEvent) => {
    const now = ev.timeStamp ?? Date.now();
    // Trim entries older than the rage window so the list stays O(N) tiny.
    while (recent.length > 0 && now - recent[0].ts > RAGE_WINDOW_MS)
      recent.shift();
    recent.push({ x: ev.clientX, y: ev.clientY, ts: now });

    // Rage: count clicks in the last RAGE_WINDOW_MS within PROXIMITY_PX of
    // the current point. Three or more = a rage event. Reset the buffer on
    // each fire so we don't spam events for sustained mashing.
    const close = recent.filter(
      (r) =>
        Math.abs(r.x - ev.clientX) < PROXIMITY_PX &&
        Math.abs(r.y - ev.clientY) < PROXIMITY_PX,
    );
    if (close.length >= 3) {
      onEvent({
        kind: "rage_click",
        x: ev.clientX,
        y: ev.clientY,
        selector: describe(ev.target as Element | null),
        count: close.length,
      });
      recent.length = 0;
    }

    // Dead-click probe: if no mutation fires within the next 500 ms after
    // a click, mark it dead. We use the existing observer to keep a single
    // global subscription rather than churning per-click.
    const baseline = Math.random(); // we just need a key
    let mutated = false;
    const obs = new MutationObserver(() => {
      mutated = true;
    });
    obs.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      characterData: true,
    });
    window.setTimeout(() => {
      obs.disconnect();
      if (!mutated) {
        onEvent({
          kind: "dead_click",
          x: ev.clientX,
          y: ev.clientY,
          selector: describe(ev.target as Element | null),
        });
      }
      void baseline; // keep TS quiet about unused
    }, DEAD_OBSERVE_MS);
  };

  document.addEventListener("click", onClick, true);
  return () => {
    document.removeEventListener("click", onClick, true);
    observer.disconnect();
  };
}

/**
 * Web performance capture.
 *
 * We delegate the Core Web Vitals math to Google's `web-vitals`
 * library (the same code Lighthouse + PageSpeed Insights use), so the
 * numbers we report are canonical:
 *
 *   • LCP   (Largest Contentful Paint, ms)   — `onLCP`
 *   • CLS   (Cumulative Layout Shift, score) — `onCLS`, with the
 *            official session-window aggregation (1s gap / 5s cap)
 *            instead of the monotonic sum we used to do
 *   • INP   (Interaction to Next Paint, ms)  — `onINP`. Replaces FID
 *            (Google deprecated FID in March 2024; CrUX no longer
 *            reports it)
 *   • FCP   (First Contentful Paint, ms)     — `onFCP`
 *   • TTFB  (Time to First Byte, ms)         — `onTTFB`
 *
 * We still own:
 *   • Long Animation Frames (LoAF) — richer than the old Long Tasks
 *     API: carries blocking time + attribution to the specific script
 *     that caused the jank. Falls back to Long Tasks where LoAF is
 *     unsupported (Firefox/Safari).
 *   • Page-load timings — navigation milestones (TTFB, DOM interactive,
 *     DCL, load, first paint / FCP) from the Navigation Timing API.
 *   • Resource timings — per-asset load breakdown (DNS/TCP/TTFB/download)
 *     from the Resource Timing API.
 *   • Memory snapshots — periodic `performance.memory` poll
 *
 * `reportAllChanges: true` means we get every high-water-mark update
 * as the user interacts, not just the final value on pagehide. Our
 * persistence path takes the max across batches, which is exactly
 * the right merge for LCP/INP/CLS (they only grow). Web-vitals also
 * handles bfcache restoration so a back/forward navigation resets
 * the metric cleanly.
 */
type PerfMetric =
  | "lcp"
  | "cls"
  | "fid"
  | "inp"
  | "fcp"
  | "ttfb"
  | "long_task"
  | "long_animation_frame"
  | "page_load"
  | "resource"
  | "memory";

type PerfEmit = (data: {
  kind: "perf";
  metric: PerfMetric;
  value: number;
  /** Unit hint for the UI. e.g. "ms", "bytes", "score". */
  unit?: "ms" | "bytes" | "score";
  /** web.dev rating bucket — surfaced unchanged so the dashboard
   *  doesn't have to re-derive it. Only present for Core Vitals. */
  rating?: "good" | "needs-improvement" | "poor";
  /** Absolute timestamp in ms — useful for memory series rendering. */
  ts?: number;
  /** Structured payload for multi-field metrics (LoAF script
   *  attribution, page-load milestones, per-resource timing). */
  detail?: Record<string, number | string | undefined>;
}) => void;

/** Options for the performance capture — the ingest host (so we don't
 *  record our own batch calls as resources) and the resource-timing
 *  knobs from config. */
export interface PerfCaptureOptions {
  apiHost?: string;
  captureResourceTimings?: boolean;
  resourceMinDurationMs?: number;
}

/** One script's attribution inside a Long Animation Frame entry. The
 *  DOM lib in our TS version predates LoAF, so we type it ourselves. */
interface LoAFScript {
  name?: string;
  duration?: number;
  invoker?: string;
  invokerType?: string;
  sourceURL?: string;
  sourceFunctionName?: string;
}
interface LoAFEntry extends PerformanceEntry {
  duration: number;
  blockingDuration?: number;
  scripts?: LoAFScript[];
}

// Lazy-require web-vitals so SSR / non-browser environments that
// happen to import this module don't crash at module-eval time.
// We re-import inside the function body when window exists.
export function createPerformanceCapture(
  onEvent: PerfEmit,
  options: PerfCaptureOptions = {},
): StopHandle {
  if (typeof window === "undefined") return () => {};
  const observers: PerformanceObserver[] = [];
  const timers: number[] = [];
  const supportsEntry = (t: string) =>
    typeof PerformanceObserver !== "undefined" &&
    Array.isArray(PerformanceObserver.supportedEntryTypes) &&
    PerformanceObserver.supportedEntryTypes.includes(t);

  // Web-vitals subscribes to the underlying PerformanceObserver entries
  // for us and handles all the canonical-aggregation logic. Each `onX`
  // callback fires with `{ name, value, delta, rating, ... }`. We
  // forward each one through our `perf` event channel.
  //
  // `reportAllChanges` is set so we report incremental updates (each
  // new max) rather than waiting for pagehide. That gives the
  // dashboard a near-live picture if the user is sitting on a session.
  void import("web-vitals").then(({ onLCP, onCLS, onINP, onFCP, onTTFB }) => {
    onLCP(
      (m) =>
        onEvent({
          kind: "perf",
          metric: "lcp",
          value: Math.round(m.value),
          unit: "ms",
          rating: m.rating,
        }),
      { reportAllChanges: true },
    );
    onCLS(
      (m) =>
        onEvent({
          kind: "perf",
          metric: "cls",
          // CLS is a small fractional score (typically 0.0–1.0). We
          // round to 4dp here; the backend stores it scaled ×1000 to
          // fit in an indexable Int. The session-window logic is done
          // by web-vitals internally; we just forward the result.
          value: Number(m.value.toFixed(4)),
          unit: "score",
          rating: m.rating,
        }),
      { reportAllChanges: true },
    );
    onINP(
      (m) =>
        onEvent({
          kind: "perf",
          metric: "inp",
          value: Math.round(m.value),
          unit: "ms",
          rating: m.rating,
        }),
      { reportAllChanges: true },
    );
    onFCP((m) =>
      onEvent({
        kind: "perf",
        metric: "fcp",
        value: Math.round(m.value),
        unit: "ms",
        rating: m.rating,
      }),
    );
    onTTFB((m) =>
      onEvent({
        kind: "perf",
        metric: "ttfb",
        value: Math.round(m.value),
        unit: "ms",
        rating: m.rating,
      }),
    );
  }).catch(() => {
    /* web-vitals not available — fail silently rather than break the SDK */
  });

  /**
   * Defensive observer creator. Browsers throw if a type is unknown
   * (Firefox lacks `longtask` for example), so we wrap it.
   */
  const safeObserve = (
    type: string,
    cb: (list: PerformanceObserverEntryList) => void,
    options: PerformanceObserverInit = { type, buffered: true } as PerformanceObserverInit,
  ) => {
    try {
      const obs = new PerformanceObserver((list) => cb(list));
      obs.observe(options);
      observers.push(obs);
    } catch {
      /* unsupported entry type — silently skip */
    }
  };

  // Jank — prefer the modern Long Animation Frames API, which attributes
  // the slow frame to the specific script (source URL + function) that
  // blocked the main thread. That attribution is what lets the AI say
  // "checkout froze because analytics.js ran 240ms", not just "a frame
  // was slow". Fall back to the older Long Tasks API where LoAF is
  // unsupported (Firefox/Safari) — coarser, no attribution.
  if (supportsEntry("long-animation-frame")) {
    safeObserve("long-animation-frame", (list) => {
      for (const e of list.getEntries()) {
        const entry = e as LoAFEntry;
        // Attribute to the single longest script in the frame — that's
        // the culprit; shipping the whole scripts[] array would bloat
        // every jank event for little extra signal.
        let top: LoAFScript | undefined;
        for (const s of entry.scripts ?? []) {
          if (!top || (s.duration ?? 0) > (top.duration ?? 0)) top = s;
        }
        onEvent({
          kind: "perf",
          metric: "long_animation_frame",
          value: Math.round(entry.duration),
          unit: "ms",
          ts: Date.now(),
          detail: {
            blockingDuration: Math.round(entry.blockingDuration ?? 0),
            scriptDuration:
              top && typeof top.duration === "number"
                ? Math.round(top.duration)
                : undefined,
            scriptSource: top?.sourceURL || undefined,
            scriptFunction: top?.sourceFunctionName || undefined,
            scriptInvoker: top?.invoker || undefined,
          },
        });
      }
    });
  } else {
    safeObserve("longtask", (list) => {
      for (const entry of list.getEntries()) {
        onEvent({
          kind: "perf",
          metric: "long_task",
          value: Math.round(entry.duration),
          unit: "ms",
          ts: Date.now(),
        });
      }
    });
  }

  // Page-load milestones — one shot per navigation, read from the
  // Navigation Timing API (PerformanceNavigationTiming, the non-
  // deprecated successor to `performance.timing`). Values are ms from
  // navigation start. Paired with the paint entries for FP/FCP.
  let pageLoadSent = false;
  const emitPageLoad = () => {
    if (pageLoadSent) return;
    const nav = performance.getEntriesByType("navigation")[0] as
      | PerformanceNavigationTiming
      | undefined;
    // loadEventEnd is 0 until the load event fully settles — wait for it.
    if (!nav || nav.loadEventEnd === 0) return;
    pageLoadSent = true;
    const paints = performance.getEntriesByType("paint");
    const fp = paints.find((p) => p.name === "first-paint")?.startTime;
    const fcp = paints.find(
      (p) => p.name === "first-contentful-paint",
    )?.startTime;
    onEvent({
      kind: "perf",
      metric: "page_load",
      value: Math.round(nav.loadEventEnd),
      unit: "ms",
      ts: Date.now(),
      detail: {
        ttfb: Math.round(nav.responseStart),
        responseEnd: Math.round(nav.responseEnd),
        domInteractive: Math.round(nav.domInteractive),
        domContentLoaded: Math.round(nav.domContentLoadedEventEnd),
        load: Math.round(nav.loadEventEnd),
        firstPaint: fp !== undefined ? Math.round(fp) : undefined,
        firstContentfulPaint:
          fcp !== undefined ? Math.round(fcp) : undefined,
        transferSize: nav.transferSize,
        navigationType: nav.type,
      },
    });
  };
  if (document.readyState === "complete") {
    // load already fired — loadEventEnd is set a tick later, so defer.
    timers.push(window.setTimeout(emitPageLoad, 0));
  } else {
    window.addEventListener(
      "load",
      () => timers.push(window.setTimeout(emitPageLoad, 0)),
      { once: true },
    );
  }

  // Resource timings — per-asset load breakdown. Highest-volume perf
  // channel, so we skip our own ingest calls and data: URIs, and honour
  // the `resourceMinDurationMs` floor from config to trim volume.
  const captureResources = options.captureResourceTimings !== false;
  const minResourceMs = options.resourceMinDurationMs ?? 0;
  let ownHost: string | undefined;
  try {
    ownHost = options.apiHost ? new URL(options.apiHost).host : undefined;
  } catch {
    ownHost = undefined;
  }
  if (captureResources) {
    safeObserve("resource", (list) => {
      for (const e of list.getEntries()) {
        const entry = e as PerformanceResourceTiming;
        if (entry.duration < minResourceMs) continue;
        const url = entry.name;
        if (url.startsWith("data:")) continue;
        // Never record the SDK's own batch/config/presence traffic.
        if (ownHost && url.includes(ownHost)) continue;
        onEvent({
          kind: "perf",
          metric: "resource",
          value: Math.round(entry.duration),
          unit: "ms",
          ts: Math.round(entry.startTime + performance.timeOrigin),
          detail: {
            name: url.slice(0, 512),
            initiatorType: entry.initiatorType,
            ttfb: Math.round(
              Math.max(0, entry.responseStart - entry.requestStart),
            ),
            dnsLookup: Math.round(
              Math.max(0, entry.domainLookupEnd - entry.domainLookupStart),
            ),
            tcp: Math.round(
              Math.max(0, entry.connectEnd - entry.connectStart),
            ),
            contentDownload: Math.round(
              Math.max(0, entry.responseEnd - entry.responseStart),
            ),
            transferSize: entry.transferSize,
            encodedBodySize: entry.encodedBodySize,
            decodedBodySize: entry.decodedBodySize,
            // Heuristic: served from cache when nothing came over the
            // wire but the body decoded to something.
            cached:
              entry.transferSize === 0 && entry.decodedBodySize > 0 ? 1 : 0,
          },
        });
      }
    });
  }

  // Memory — Chrome/Edge only. Sampled every 10s + once at startup.
  // The API isn't standardised so we feature-detect carefully.
  type PerfMemoryLike = { usedJSHeapSize?: number };
  const perfMem = (performance as Performance & { memory?: PerfMemoryLike }).memory;
  const sampleMemory = () => {
    const used = perfMem?.usedJSHeapSize;
    if (typeof used === "number") {
      onEvent({ kind: "perf", metric: "memory", value: used, unit: "bytes", ts: Date.now() });
    }
  };
  if (perfMem) {
    sampleMemory();
    const id = window.setInterval(sampleMemory, 10_000);
    timers.push(id);
  }

  return () => {
    for (const obs of observers) {
      try { obs.disconnect(); } catch { /* already disconnected */ }
    }
    for (const id of timers) window.clearInterval(id);
    // web-vitals doesn't expose an unsubscribe (the observers it
    // installs live for the page lifetime, which matches our session
    // lifetime). No cleanup needed.
  };
}

/** Produce a short CSS selector for an element — `button.primary#checkout` */
function describe(el: Element | null): string {
  if (!el) return "";
  const tag = el.tagName?.toLowerCase() ?? "";
  const id = el.id ? `#${el.id}` : "";
  const cls =
    (el as HTMLElement).className &&
    typeof (el as HTMLElement).className === "string"
      ? "." +
        (el as HTMLElement).className
          .split(/\s+/)
          .filter(Boolean)
          .slice(0, 2)
          .join(".")
      : "";
  return `${tag}${id}${cls}`.slice(0, 80);
}

/**
 * Snapshot the browser's idea of network quality right now. Falls back to
 * undefined on Safari/Firefox where Network Information API isn't exposed —
 * we just store whatever Chrome/Edge give us. Cheap (synchronous lookup).
 */
function snapshotConnection(): { rtt?: number; effectiveType?: string } {
  type ConnLike = { rtt?: number; effectiveType?: string };
  const c = (navigator as Navigator & { connection?: ConnLike }).connection;
  if (!c) return {};
  return { rtt: c.rtt, effectiveType: c.effectiveType };
}

export function createNetworkCapture(
  config: WebReplayConfig,
  onEvent: (data: NetworkEventData) => void,
): StopHandle {
  const originalFetch = (config.fetchImpl ?? window.fetch).bind(window);
  const originalXhrOpen = XMLHttpRequest.prototype.open;
  const originalXhrSend = XMLHttpRequest.prototype.send;
  const originalSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;

  const MAX_BODY = config.maxBodyBytes ?? 8 * 1024;

  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const startedAt = Date.now();
    const request = input instanceof Request ? input : new Request(input, init);
    const requestId = globalThis.crypto.randomUUID();

    // Best-effort request body capture — string/JSON only, capped.
    let requestBody: string | undefined;
    try {
      if (typeof init?.body === "string")
        requestBody = String(init.body).slice(0, MAX_BODY);
      else if (init?.body instanceof URLSearchParams)
        requestBody = init.body.toString().slice(0, MAX_BODY);
    } catch {
      /* ignore */
    }

    try {
      const response = await originalFetch(input, init);
      // Clone the response so we can read the body without breaking the caller.
      let responseBody: string | undefined;
      try {
        const ct = response.headers.get("content-type") ?? "";
        if (/json|text|xml|javascript|html/i.test(ct)) {
          const clone = response.clone();
          const text = await clone.text();
          responseBody = text.slice(0, MAX_BODY);
        }
      } catch {
        /* response body unreadable */
      }

      const conn = snapshotConnection();
      onEvent({
        requestId,
        transport: "fetch",
        method: request.method,
        url: redactUrlForStorage(request.url, { patterns: config.redactUrls }),
        startedAt,
        endedAt: Date.now(),
        durationMs: Date.now() - startedAt,
        statusCode: response.status,
        ok: response.ok,
        requestHeaders: config.captureHeaders
          ? redactHeaders(
              toHeaderRecord(request.headers),
              config.redactHeaderNames,
            )
          : undefined,
        responseHeaders: config.captureHeaders
          ? redactHeaders(
              toHeaderRecord(response.headers),
              config.redactHeaderNames,
            )
          : undefined,
        requestBody,
        responseBody,
        connectionRtt: conn.rtt,
        connectionEffectiveType: conn.effectiveType,
      });
      return response;
    } catch (error) {
      const conn = snapshotConnection();
      onEvent({
        requestId,
        transport: "fetch",
        method: request.method,
        url: redactUrlForStorage(request.url, { patterns: config.redactUrls }),
        startedAt,
        endedAt: Date.now(),
        durationMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
        connectionRtt: conn.rtt,
        connectionEffectiveType: conn.effectiveType,
      });
      throw error;
    }
  };

  XMLHttpRequest.prototype.open = function open(
    method: string,
    url: string | URL,
    ...rest: unknown[]
  ) {
    Reflect.set(this, "__replay_request_meta__", {
      requestId: globalThis.crypto.randomUUID(),
      method,
      url: String(url),
      startedAt: 0,
      headers: {} as Record<string, string>,
    });
    const [asyncFlag, username, password] = rest as [
      boolean?,
      string?,
      string?,
    ];
    if (typeof asyncFlag === "boolean") {
      return originalXhrOpen.call(
        this,
        method,
        String(url),
        asyncFlag,
        username,
        password,
      );
    }

    return originalXhrOpen.call(this, method, String(url), true);
  };

  XMLHttpRequest.prototype.setRequestHeader = function setRequestHeader(
    name: string,
    value: string,
  ) {
    const meta = Reflect.get(this, "__replay_request_meta__") as
      | { headers?: Record<string, string> }
      | undefined;
    if (meta?.headers) {
      meta.headers[name] = value;
    }
    return originalSetRequestHeader.call(this, name, value);
  };

  XMLHttpRequest.prototype.send = function send(
    ...args: Parameters<XMLHttpRequest["send"]>
  ) {
    const meta = Reflect.get(this, "__replay_request_meta__") as
      | {
          requestId: string;
          method: string;
          url: string;
          startedAt: number;
          headers: Record<string, string>;
        }
      | undefined;

    if (meta) {
      meta.startedAt = Date.now();
      const finalize = () => {
        const conn = snapshotConnection();
        // Best-effort response body — only for text-ish content types.
        let responseBody: string | undefined;
        try {
          const ct = this.getResponseHeader("content-type") ?? "";
          if (
            /json|text|xml|javascript|html/i.test(ct) &&
            typeof this.responseText === "string"
          ) {
            responseBody = this.responseText.slice(0, MAX_BODY);
          }
        } catch {
          /* unreadable */
        }
        // Parse response headers from getAllResponseHeaders() — comes back as one
        // big newline-separated string. Cheap to parse.
        const responseHeaders: Record<string, string> = {};
        if (config.captureHeaders) {
          try {
            for (const line of (this.getAllResponseHeaders() || "").split(
              /\r?\n/,
            )) {
              const idx = line.indexOf(":");
              if (idx > 0)
                responseHeaders[line.slice(0, idx).trim().toLowerCase()] = line
                  .slice(idx + 1)
                  .trim();
            }
          } catch {
            /* ignore */
          }
        }
        onEvent({
          requestId: meta.requestId,
          transport: "xhr",
          method: meta.method,
          url: redactUrlForStorage(meta.url, { patterns: config.redactUrls }),
          startedAt: meta.startedAt,
          endedAt: Date.now(),
          durationMs: Date.now() - meta.startedAt,
          statusCode: this.status,
          ok: this.status >= 200 && this.status < 400,
          requestHeaders: config.captureHeaders
            ? redactHeaders(meta.headers, config.redactHeaderNames)
            : undefined,
          responseHeaders: config.captureHeaders
            ? redactHeaders(responseHeaders, config.redactHeaderNames)
            : undefined,
          responseBody,
          connectionRtt: conn.rtt,
          connectionEffectiveType: conn.effectiveType,
        });
      };

      this.addEventListener("loadend", finalize, { once: true });
      this.addEventListener(
        "error",
        () => {
          const conn = snapshotConnection();
          onEvent({
            requestId: meta.requestId,
            transport: "xhr",
            method: meta.method,
            url: redactUrlForStorage(meta.url, { patterns: config.redactUrls }),
            startedAt: meta.startedAt,
            endedAt: Date.now(),
            durationMs: Date.now() - meta.startedAt,
            error: "XMLHttpRequest failed",
            connectionRtt: conn.rtt,
            connectionEffectiveType: conn.effectiveType,
          });
        },
        { once: true },
      );
    }

    return originalXhrSend.apply(this, args);
  };

  return () => {
    window.fetch = originalFetch;
    XMLHttpRequest.prototype.open = originalXhrOpen;
    XMLHttpRequest.prototype.send = originalXhrSend;
    XMLHttpRequest.prototype.setRequestHeader = originalSetRequestHeader;
  };
}
