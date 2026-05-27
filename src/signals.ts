import type {
  ConsoleEventData,
  ErrorEventData,
  NavigationEventData,
  NetworkEventData,
} from "./schema";
import type { WebReplayConfig } from "./types";
import {
  formatConsoleArg,
  serializeConsoleArg,
  toHeaderRecord,
  withRedactedUrl,
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

export function createErrorCapture(
  onEvent: (data: ErrorEventData) => void,
): StopHandle {
  const onError = (event: ErrorEvent) => {
    onEvent({
      kind: "error",
      message: event.message,
      stack: event.error instanceof Error ? event.error.stack : undefined,
    });
  };

  const onRejection = (event: PromiseRejectionEvent) => {
    onEvent({
      kind: "unhandledrejection",
      message: String(event.reason),
      stack: event.reason instanceof Error ? event.reason.stack : undefined,
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
    onEvent({
      from: currentUrl,
      to: nextUrl,
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
 *   • Long tasks ≥ 50ms — emitted per occurrence
 *   • Memory snapshots — periodic `performance.memory` poll
 *
 * `reportAllChanges: true` means we get every high-water-mark update
 * as the user interacts, not just the final value on pagehide. Our
 * persistence path takes the max across batches, which is exactly
 * the right merge for LCP/INP/CLS (they only grow). Web-vitals also
 * handles bfcache restoration so a back/forward navigation resets
 * the metric cleanly.
 */
type PerfEmit = (data: {
  kind: "perf";
  metric: "lcp" | "cls" | "fid" | "inp" | "fcp" | "ttfb" | "long_task" | "memory";
  value: number;
  /** Unit hint for the UI. e.g. "ms", "bytes", "score". */
  unit?: "ms" | "bytes" | "score";
  /** web.dev rating bucket — surfaced unchanged so the dashboard
   *  doesn't have to re-derive it. Only present for Core Vitals. */
  rating?: "good" | "needs-improvement" | "poor";
  /** Absolute timestamp in ms — useful for memory series rendering. */
  ts?: number;
}) => void;

// Lazy-require web-vitals so SSR / non-browser environments that
// happen to import this module don't crash at module-eval time.
// We re-import inside the function body when window exists.
export function createPerformanceCapture(onEvent: PerfEmit): StopHandle {
  if (typeof window === "undefined") return () => {};
  const observers: PerformanceObserver[] = [];
  const timers: number[] = [];

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

  // Long tasks — emit each one with its duration. Useful for spotting
  // jank correlated with a frame the user was looking at. web-vitals
  // doesn't surface long tasks as a Core Vital so we keep this one.
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
        url: withRedactedUrl(request.url, config.redactUrls),
        startedAt,
        endedAt: Date.now(),
        durationMs: Date.now() - startedAt,
        statusCode: response.status,
        ok: response.ok,
        requestHeaders: config.captureHeaders
          ? toHeaderRecord(request.headers)
          : undefined,
        responseHeaders: config.captureHeaders
          ? toHeaderRecord(response.headers)
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
        url: withRedactedUrl(request.url, config.redactUrls),
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
          url: withRedactedUrl(meta.url, config.redactUrls),
          startedAt: meta.startedAt,
          endedAt: Date.now(),
          durationMs: Date.now() - meta.startedAt,
          statusCode: this.status,
          ok: this.status >= 200 && this.status < 400,
          requestHeaders: config.captureHeaders ? meta.headers : undefined,
          responseHeaders: config.captureHeaders ? responseHeaders : undefined,
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
            url: withRedactedUrl(meta.url, config.redactUrls),
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
