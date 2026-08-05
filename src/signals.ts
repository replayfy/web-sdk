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

  // Flood guard: a console.log in a tight loop shouldn't drown the session in
  // events. Cap captured messages per rolling window (the real console is still
  // called, so devtools output is unchanged) — parity with the reference tracker.
  const THROTTLE_LIMIT = 30;
  const THROTTLE_WINDOW_MS = 1000;
  let windowStart = Date.now();
  let windowCount = 0;

  for (const level of methods) {
    originals.set(level, console[level].bind(console));
    console[level] = (...args: unknown[]) => {
      const now = Date.now();
      if (now - windowStart > THROTTLE_WINDOW_MS) {
        windowStart = now;
        windowCount = 0;
      }
      windowCount += 1;
      if (windowCount <= THROTTLE_LIMIT) {
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
      }
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
  metadata?: Record<string, unknown>,
): ErrorEventData {
  const meta = metadata ? { metadata } : {};
  if (value instanceof Error) {
    return {
      kind: "error",
      name: value.name || "Error",
      message: value.message || String(value),
      stack: value.stack,
      frames: framesFromError(value),
      handled,
      ...meta,
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
    ...meta,
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

  // Attach to the top window AND every SAME-ORIGIN iframe, so uncaught errors /
  // rejections thrown inside embedded editors, widget hosts, and micro-frontends
  // are captured too (they'd otherwise be invisible). Cross-origin frames are
  // inaccessible and silently skipped.
  const attached = new Set<Window>();
  const attach = (w: Window | null) => {
    if (!w || attached.has(w)) return;
    try {
      w.addEventListener("error", onError);
      w.addEventListener("unhandledrejection", onRejection);
      attached.add(w);
    } catch {
      /* cross-origin window — inaccessible */
    }
  };
  const attachFrame = (frame: HTMLIFrameElement) => {
    try {
      // Reading contentWindow.document throws for cross-origin — the same-origin gate.
      if (frame.contentWindow?.document) attach(frame.contentWindow);
    } catch {
      /* cross-origin — skip */
    }
  };
  attach(window);
  const frames = document.getElementsByTagName("iframe");
  for (let i = 0; i < frames.length; i += 1) attachFrame(frames[i]);

  // Catch iframes added later; wait for load so contentWindow is ready.
  let mo: MutationObserver | undefined;
  try {
    mo = new MutationObserver((records) => {
      for (const rec of records) {
        rec.addedNodes.forEach((n) => {
          if (n instanceof HTMLIFrameElement) {
            attachFrame(n);
            n.addEventListener("load", () => attachFrame(n), { once: true });
          } else if (n instanceof Element) {
            n.querySelectorAll("iframe").forEach((f) =>
              attachFrame(f as HTMLIFrameElement),
            );
          }
        });
      }
    });
    mo.observe(document.documentElement, { childList: true, subtree: true });
  } catch {
    /* document not ready */
  }

  return () => {
    mo?.disconnect();
    for (const w of attached) {
      try {
        w.removeEventListener("error", onError);
        w.removeEventListener("unhandledrejection", onRejection);
      } catch {
        /* window gone */
      }
    }
    attached.clear();
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
      // Human-readable screen name so the dashboard can label screens by title,
      // not just an opaque URL (parity with the reference tracker's page location).
      title: document.title || undefined,
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
type ClickEmit = (
  data:
    | { kind: "rage_click"; x: number; y: number; selector: string; count: number }
    | { kind: "dead_click"; x: number; y: number; selector: string }
    | {
        kind: "click";
        selector: string;
        label: string;
        nx: number;
        ny: number;
        uiId: string;
      },
) => void;

export function createRageDeadClickCapture(onEvent: ClickEmit): StopHandle {
  const recent: Array<{ x: number; y: number; ts: number }> = [];
  const PROXIMITY_PX = 24;
  const RAGE_WINDOW_MS = 1000;
  const DEAD_OBSERVE_MS = 500;

  // ONE shared observer with a dirty-timestamp — not a fresh observer per click.
  // A click is "dead" only if nothing mutated AND the URL didn't change within
  // the window (a navigation IS a response).
  let lastMutation = 0;
  const observer = new MutationObserver(() => {
    lastMutation = Date.now();
  });
  try {
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      characterData: true,
    });
  } catch {
    /* document not ready — best effort */
  }

  const onClick = (ev: MouseEvent) => {
    const now = Date.now();
    // Resolve the raw target to the meaningful clickable ancestor; null = the
    // element (or an ancestor) is masked, so we emit NO identity for it.
    const target = resolveClickable(ev.target);
    if (!target) return;
    const selector = cssPath(target);

    // Semantic click event — every real click, for heatmaps / click funnels.
    // Mirrors our mobile TapEventData (selector + label + content-normalized
    // coords 0..1e4 + a stable uiId bucket).
    const label = targetLabel(target);
    const nx = normCoord(
      ev.pageX,
      document.documentElement.scrollWidth || window.innerWidth,
    );
    const ny = normCoord(
      ev.pageY,
      document.documentElement.scrollHeight || window.innerHeight,
    );
    onEvent({
      kind: "click",
      selector,
      label,
      nx,
      ny,
      uiId: hashId(`${location.pathname}#${selector}#${label}`),
    });

    // Rage: ≥3 clicks within PROXIMITY_PX in RAGE_WINDOW_MS.
    while (recent.length > 0 && now - recent[0].ts > RAGE_WINDOW_MS)
      recent.shift();
    recent.push({ x: ev.clientX, y: ev.clientY, ts: now });
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
        selector,
        count: close.length,
      });
      recent.length = 0;
    }

    // Dead-click: no mutation AND no navigation within the window.
    const hrefBefore = location.href;
    window.setTimeout(() => {
      const mutated = lastMutation >= now;
      const navigated = location.href !== hrefBefore;
      if (!mutated && !navigated) {
        onEvent({ kind: "dead_click", x: ev.clientX, y: ev.clientY, selector });
      }
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

/** Meaningful clickable element types — mirrors the reference tracker's getTarget. */
const CLICKABLE_TAGS = new Set([
  "BUTTON", "A", "SELECT", "LI", "TR", "TH", "TD",
  "INPUT", "TEXTAREA", "SUMMARY", "OPTION", "LABEL",
]);

/** rrweb-style privacy classes/attrs that mark a subtree as blocked/masked. */
function isMaskedNode(node: Element): boolean {
  const c = node.classList;
  return (
    (!!c && (c.contains("rr-block") || c.contains("rr-ignore") || c.contains("rr-mask"))) ||
    node.getAttribute("data-rr-block") === "true" ||
    node.getAttribute("data-replay-block") === "true"
  );
}

/** Walk from the raw event target up to the nearest MEANINGFUL clickable element
 *  (control, [role=button], [onclick], [tabindex], or clickable tag), climbing
 *  out of SVG internals to the owning <svg>. Returns null if the target or any
 *  ancestor on the way is masked — we then emit no identity for that click. */
function resolveClickable(raw: EventTarget | null): Element | null {
  let el: Element | null = raw instanceof Element ? raw : null;
  if (el && el.namespaceURI === "http://www.w3.org/2000/svg") {
    const owner = el.closest("svg");
    if (owner) el = owner;
  }
  let node: Element | null = el;
  let depth = 0;
  while (node && depth < 12) {
    if (isMaskedNode(node)) return null;
    if (
      CLICKABLE_TAGS.has(node.tagName) ||
      node.getAttribute("role") === "button" ||
      node.hasAttribute("onclick") ||
      node.hasAttribute("tabindex")
    ) {
      return node;
    }
    node = node.parentElement;
    depth += 1;
  }
  return el;
}

// Reject hashed / utility class tokens (e.g. "css-1a2b3c", "sc-bdVaJa") so the
// selector prefers stable, human-authored classes.
const WORD_LIKE_CLASS = /^[a-zA-Z][a-zA-Z-]{2,}$/;
const DATA_ID_ATTRS = ["data-testid", "data-test", "data-qa", "data-cy"];

function cssEscape(s: string): string {
  try {
    const g = window as unknown as { CSS?: { escape?: (v: string) => string } };
    if (g.CSS?.escape) return g.CSS.escape(s);
  } catch {
    /* fall through */
  }
  return s.replace(/([^a-zA-Z0-9_-])/g, "\\$1");
}

/** A reasonably-unique, stable CSS path: id → data-* test id → word-like class →
 *  tag:nth-of-type, up to a few ancestors. Far more stable than tag + first-two
 *  classes (parity with the reference tracker's getCSSPath). */
function cssPath(el: Element | null): string {
  if (!el) return "";
  const segs: string[] = [];
  let node: Element | null = el;
  let depth = 0;
  while (node && node.nodeType === 1 && depth < 5) {
    if (node.id) {
      segs.unshift(`#${cssEscape(node.id)}`);
      break; // an id is unique enough — stop climbing
    }
    let seg = node.tagName.toLowerCase();
    const dataAttr = DATA_ID_ATTRS.find((a) => node!.hasAttribute(a));
    if (dataAttr) {
      seg += `[${dataAttr}="${cssEscape(node.getAttribute(dataAttr) ?? "")}"]`;
      segs.unshift(seg);
      break;
    }
    const className =
      typeof (node as HTMLElement).className === "string"
        ? (node as HTMLElement).className
        : "";
    const cls = className.split(/\s+/).find((c) => WORD_LIKE_CLASS.test(c));
    if (cls) {
      seg += `.${cssEscape(cls)}`;
    } else if (node.parentElement) {
      const siblings = Array.prototype.filter.call(
        node.parentElement.children,
        (c: Element) => c.tagName === node!.tagName,
      ) as Element[];
      if (siblings.length > 1) {
        seg += `:nth-of-type(${siblings.indexOf(node) + 1})`;
      }
    }
    segs.unshift(seg);
    node = node.parentElement;
    depth += 1;
  }
  return segs.join(" > ").slice(0, 200);
}

function normSpaces(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** A human label for a clicked element — attribute label, input placeholder, or
 *  short trimmed text. NEVER an input's actual value (that's user data), except a
 *  submit button's caption. Capped at 100 chars. */
function targetLabel(el: Element | null): string {
  if (!el) return "";
  const attr =
    el.getAttribute("data-label") ||
    el.getAttribute("aria-label") ||
    el.getAttribute("title") ||
    el.getAttribute("alt") ||
    el.getAttribute("name");
  if (attr) return normSpaces(attr).slice(0, 100);
  if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
    const ph = el.getAttribute("placeholder");
    if (ph) return normSpaces(ph).slice(0, 100);
    const input = el as HTMLInputElement;
    if (input.type === "submit" || input.type === "button") {
      return normSpaces(input.value || "").slice(0, 100);
    }
    return "";
  }
  const text = (el as HTMLElement).innerText || el.textContent || "";
  return normSpaces(text).slice(0, 100);
}

/** Content-normalized coordinate in 0..10000 (like the reference tracker), so a
 *  click maps to the same heatmap bucket across viewport sizes. */
function normCoord(page: number, extent: number): number {
  if (!extent || extent <= 0) return 0;
  return Math.max(0, Math.min(10000, Math.round((page / extent) * 10000)));
}

/** djb2 hash → short base36 id. Buckets clicks on the same logical target across
 *  sessions (route # selector # label) for heatmaps/funnels. */
function hashId(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i += 1) h = ((h << 5) + h) ^ s.charCodeAt(i);
  return (h >>> 0).toString(36);
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
  /** Live URL-redaction policy (strip/allowlist/blockCC) — read fresh per
   *  request so a remote-config update applies WITHOUT re-installing the capture
   *  (the network patches are installed once). Cheap: a closure read. */
  getUrlPolicy?: () => {
    strip?: boolean;
    allowed?: string[];
    blockCC?: boolean;
  },
): StopHandle {
  const originalFetch = (config.fetchImpl ?? window.fetch).bind(window);
  const originalXhrOpen = XMLHttpRequest.prototype.open;
  const originalXhrSend = XMLHttpRequest.prototype.send;
  const originalSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;

  const MAX_BODY = config.maxBodyBytes ?? 8 * 1024;
  // The full URL-redaction policy for THIS request: always-on default key scrub
  // (inside redactUrlForStorage) + host redactUrls + the live remote policy.
  const urlPolicy = () => ({
    patterns: config.redactUrls,
    ...(getUrlPolicy?.() ?? {}),
  });
  // Apply the host body sanitizer, if any. null → drop the body.
  const redactBody = (
    body: string | undefined,
    direction: "request" | "response",
    url: string,
  ): string | undefined => {
    if (body === undefined || !config.sanitizeBody) return body;
    try {
      const out = config.sanitizeBody({ url, direction, body });
      return out === null ? undefined : (out ?? body);
    } catch {
      return body;
    }
  };

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
        url: redactUrlForStorage(request.url, urlPolicy()),
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
        requestBody: redactBody(requestBody, "request", request.url),
        responseBody: redactBody(responseBody, "response", request.url),
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
        url: redactUrlForStorage(request.url, urlPolicy()),
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
          url: redactUrlForStorage(meta.url, urlPolicy()),
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
            url: redactUrlForStorage(meta.url, urlPolicy()),
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

  // navigator.sendBeacon capture (analytics pings, unload telemetry) — the
  // reference tracker patches it too. Skip OUR OWN ingest beacons (the unload
  // path) so we never record ourselves.
  const originalSendBeacon =
    typeof navigator !== "undefined" && navigator.sendBeacon
      ? navigator.sendBeacon.bind(navigator)
      : undefined;
  const isOwnIngest = (u: string) =>
    u.indexOf("/v1/replay") !== -1 ||
    (!!config.apiHost && u.indexOf(config.apiHost) === 0);
  if (originalSendBeacon) {
    navigator.sendBeacon = (
      url: string | URL,
      data?: BodyInit | null,
    ): boolean => {
      const urlStr = String(url);
      const ok = originalSendBeacon(url, data ?? undefined);
      try {
        if (!isOwnIngest(urlStr)) {
          let body: string | undefined;
          if (typeof data === "string") body = data.slice(0, MAX_BODY);
          else if (data instanceof URLSearchParams)
            body = data.toString().slice(0, MAX_BODY);
          const at = Date.now();
          onEvent({
            requestId: globalThis.crypto.randomUUID(),
            transport: "beacon",
            method: "POST",
            url: redactUrlForStorage(urlStr, urlPolicy()),
            statusCode: ok ? 200 : undefined,
            startedAt: at,
            endedAt: at,
            durationMs: 0,
            ok,
            requestBody: body,
          });
        }
      } catch {
        /* never let capture break the caller's beacon */
      }
      return ok;
    };
  }

  return () => {
    window.fetch = originalFetch;
    XMLHttpRequest.prototype.open = originalXhrOpen;
    XMLHttpRequest.prototype.send = originalXhrSend;
    XMLHttpRequest.prototype.setRequestHeader = originalSetRequestHeader;
    if (originalSendBeacon) navigator.sendBeacon = originalSendBeacon;
  };
}
