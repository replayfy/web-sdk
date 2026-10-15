import type { ReplayBatchEnvelope, ReplayIngestResponse } from "./schema";
import type { WebReplayConfig } from "./types";
import { utf8Bytes } from "./utils";

export interface IdentifyPayload {
  distinctId?: string;
  email?: string;
  name?: string;
  plan?: string;
  /** Avatar image URL is NOT a discrete field here on purpose — set it via
   *  customProps ({ picture } or { avatar }); the backend picks either key up and
   *  renders it as the user's avatar. Keeping it in customProps means every SDK
   *  (web + mobile) supports avatars today with no per-SDK release. */
  customProps?: Record<string, unknown>;
}

interface ApiSuccess<T> {
  ok: true;
  data: T;
}
interface ApiError {
  ok: false;
  error: { code: string; message: string };
}
type ApiResponse<T> = ApiSuccess<T> | ApiError;

/** What a regular send concluded, for the caller to act on:
 *  - ok:    delivered (2xx, accepted).
 *  - retry: transient (network/CORS rejection, 408/429/5xx, a non-JSON 2xx such
 *           as a captive portal). Keep the events and back off.
 *  - drop:  this batch is unusable (400/413/415 …). Resending it never helps.
 *  - stop:  nothing this page sends will be accepted (bad key, origin not
 *           allowed, wrong endpoint, workspace over its plan). */
export type SendOutcome =
  | { kind: "ok" }
  | { kind: "retry"; status?: number }
  | { kind: "drop"; status: number }
  | { kind: "stop"; reason: StopReason };

export type StopReason =
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "should_not_record";

/** Map an ingest response to a SendOutcome. `body` is the parsed JSON, or
 *  undefined when the body wasn't JSON. */
export function classifyBatchResponse(
  status: number,
  body: unknown,
): SendOutcome {
  if (status >= 200 && status < 300) {
    const payload = body as ApiResponse<ReplayIngestResponse> | undefined;
    if (!payload || typeof payload !== "object") return { kind: "retry", status };
    if (!payload.ok) return { kind: "drop", status };
    // The only accepted:false the ingest sends is the plan cap (shouldNotRecord).
    if (!payload.data?.accepted)
      return { kind: "stop", reason: "should_not_record" };
    return { kind: "ok" };
  }
  if (status === 401) return { kind: "stop", reason: "unauthorized" };
  if (status === 403) return { kind: "stop", reason: "forbidden" };
  if (status === 404 || status === 405 || status === 410)
    return { kind: "stop", reason: "not_found" };
  if (status === 408 || status === 429 || status >= 500)
    return { kind: "retry", status };
  return { kind: "drop", status };
}

export interface BatchSender {
  (envelope: ReplayBatchEnvelope): Promise<SendOutcome>;
  setIdentify: (identify: IdentifyPayload | undefined) => void;
  setFingerprint: (fp: string) => void;
  /** Bind the sender to THIS page load's session. Re-attaches a persisted
   *  identity only when the same session resumed; a fresh session is cleared to
   *  anonymous. Call once, before any setIdentify. */
  bindSession: (sessionId: string, resumed: boolean) => void;
  /** The session id changed mid-page (inactivity rotation, back/forward-cache
   *  restore) for the SAME person: re-tag the stored identity so a reload of the
   *  new session re-attaches it. */
  retagSession: (sessionId: string) => void;
  /** Bytes left for the EVENTS of a hide/unload batch shaped like `shell`
   *  (its events are ignored), within this page's keepalive budget — less
   *  UNLOAD_RESERVE_BYTES when `keepReserve` (a tab switch: a close may follow
   *  while this batch is still in flight). */
  finalRoom: (shell: ReplayBatchEnvelope, keepReserve?: boolean) => number;
  /** Unload-reliable send for the hide/unload batch: one keepalive fetch (it
   *  survives page teardown and carries the api-key header), falling back to
   *  sendBeacon. Fire-and-forget. Returns false, sending nothing, when the
   *  body doesn't fit the remaining budget, so the caller keeps the events. */
  sendFinal: (envelope: ReplayBatchEnvelope) => boolean;
  /** On pagehide: re-send, with keepalive, any regular send still pending
   *  WITHOUT keepalive (mid-gzip, in backoff, or a large body), using the same
   *  bytes and sequence — the browser would otherwise cancel it with the page.
   *  The server dedupes a copy that also landed (same session/segment/sequence).
   *  Returns the pending envelopes too big to re-send now, so the caller can
   *  hand them to the next page load; those sends stop retrying either way. */
  redeliverPending: () => ReplayBatchEnvelope[];
}

/**
 * Worker source (as a string so it bundles with a plain `tsc` build —
 * no separate worker chunk to load). It gzips a JSON string off the
 * main thread using the native Compression Streams API and returns the
 * bytes as a transferable ArrayBuffer. Zero dependencies.
 */
const GZIP_WORKER_SRC = `self.onmessage=async(e)=>{var d=e.data,id=d.id,json=d.json;try{var cs=new CompressionStream('gzip');var stream=new Blob([json]).stream().pipeThrough(cs);var buf=await new Response(stream).arrayBuffer();self.postMessage({id:id,buffer:buf},[buf])}catch(err){self.postMessage({id:id,error:(err&&err.message)||String(err)})}};`;

interface GzipWorker {
  compress(json: string): Promise<ArrayBuffer>;
  terminate(): void;
}

/** Build an inline gzip worker, or null if the environment lacks
 *  Worker / Blob / Compression Streams (older Safari, JSDOM, SSR). */
function createGzipWorker(): GzipWorker | null {
  const g = globalThis as {
    Worker?: unknown;
    Blob?: unknown;
    URL?: { createObjectURL?: unknown };
    CompressionStream?: unknown;
  };
  if (
    typeof g.Worker === "undefined" ||
    typeof g.Blob === "undefined" ||
    typeof g.URL === "undefined" ||
    typeof g.URL.createObjectURL === "undefined" ||
    typeof g.CompressionStream === "undefined"
  ) {
    return null;
  }
  let worker: Worker;
  try {
    const url = URL.createObjectURL(
      new Blob([GZIP_WORKER_SRC], { type: "text/javascript" }),
    );
    worker = new Worker(url);
    URL.revokeObjectURL(url);
  } catch {
    return null;
  }
  let seq = 0;
  const pending = new Map<
    number,
    { resolve: (b: ArrayBuffer) => void; reject: (e: unknown) => void }
  >();
  worker.onmessage = (e: MessageEvent) => {
    const { id, buffer, error } = e.data as {
      id: number;
      buffer?: ArrayBuffer;
      error?: string;
    };
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    if (error || !buffer) p.reject(new Error(error ?? "gzip failed"));
    else p.resolve(buffer);
  };
  worker.onerror = () => {
    for (const [, p] of pending) p.reject(new Error("gzip worker error"));
    pending.clear();
  };
  return {
    compress: (json) =>
      new Promise<ArrayBuffer>((resolve, reject) => {
        const id = ++seq;
        pending.set(id, { resolve, reject });
        worker.postMessage({ id, json });
      }),
    terminate: () => worker.terminate(),
  };
}

/** Main-thread gzip fallback for when a worker can't be created but the
 *  Compression Streams API is still available. */
async function gzipMainThread(json: string): Promise<ArrayBuffer | null> {
  const CS = (
    globalThis as {
      CompressionStream?: new (format: string) => ReadableWritablePair;
    }
  ).CompressionStream;
  if (
    !CS ||
    typeof Blob === "undefined" ||
    typeof Response === "undefined"
  ) {
    return null;
  }
  try {
    const stream = new Blob([json]).stream().pipeThrough(new CS("gzip"));
    return await new Response(
      stream as unknown as BodyInit,
    ).arrayBuffer();
  } catch {
    return null;
  }
}

/** In-call retries for a transient failure (network/CORS rejection, 408/5xx).
 *  After the last one the caller keeps the events and backs off. 429 returns
 *  at once so the caller's backoff, not these quick retries, paces it. */
const MAX_SEND_ATTEMPTS = 3;
const SEND_BACKOFF_MS = 300;

/** Browsers cap the request bodies of all in-flight keepalive fetches AND
 *  sendBeacon calls of one document at 64 KiB in total — the host page's own
 *  unload beacons included. The SDK keeps to 48 KiB of it. */
const KEEPALIVE_BUDGET_BYTES = 48 * 1024;
/** Regular sends use keepalive (so a navigation can't cancel them) only when
 *  small, and only while at least the rest of the budget stays free for the
 *  hide/unload batch. Bigger regular sends use a normal fetch. */
const REGULAR_KEEPALIVE_MAX_BYTES = 16 * 1024;
const REGULAR_KEEPALIVE_SHARE_BYTES = 24 * 1024;
/** Kept free by a tab-switch batch and by pagehide's re-sends, so the closing
 *  batch (session end, errors, page view first) always fits. */
const UNLOAD_RESERVE_BYTES = 8 * 1024;
/** sendBeacon reports no completion: its bytes count against the budget for
 *  this long (browsers send a queued beacon within well under that). */
const BEACON_HOLD_MS = 10_000;
/** A regular upload with no response by then is aborted and retried, so one
 *  hung request (a half-open mobile connection) can't block every later one.
 *  Bigger bodies get longer, at an assumed floor of 1 KB/s, so a slow but
 *  working connection still gets a large snapshot through. */
const SEND_TIMEOUT_MS = 30_000;
const MIN_UPLOAD_BYTES_PER_MS = 1;

/** Firefox before 133 ignores `keepalive` (the request dies with the page), so
 *  the unload path uses sendBeacon there. */
const KEEPALIVE_SUPPORTED =
  typeof Request !== "undefined" && "keepalive" in Request.prototype;

/** A regular send that hasn't finished yet. */
interface PendingSend {
  envelope: ReplayBatchEnvelope;
  json: string;
  /** gzip bytes, once compression finished */
  gz?: ArrayBuffer;
  /** the request in flight right now uses keepalive (the browser keeps it) */
  keepaliveActive: boolean;
  /** re-sent by redeliverPending(): this send must not POST again */
  superseded: boolean;
}

/** Where the current tab's identify() payload is stashed, TAGGED with the session
 *  id it belongs to. A reload re-attaches it ONLY when the same session resumed
 *  (bindSession checks the sid) — so it closes the "identify lost on reload" gap
 *  without leaking identity into a DIFFERENT session that happens to share the
 *  tab (a post-inactivity rollover, or a logged-out visitor on a shared machine).
 *  sessionStorage (per-tab, cleared on tab-close) also keeps identity from
 *  sticking to the browser forever with no logout hook. */
const IDENTIFY_STORAGE_KEY = "replay:identify";

interface StoredIdentify {
  sid: string;
  payload: IdentifyPayload;
}

function loadStoredIdentify(): StoredIdentify | null {
  try {
    const raw = sessionStorage.getItem(IDENTIFY_STORAGE_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as Partial<StoredIdentify>;
    if (
      s &&
      typeof s.sid === "string" &&
      s.payload &&
      typeof s.payload === "object" &&
      (s.payload.distinctId || s.payload.email)
    ) {
      return { sid: s.sid, payload: s.payload };
    }
  } catch {
    /* sessionStorage blocked / corrupt — start anonymous */
  }
  return null;
}

function persistIdentify(
  sid: string | undefined,
  payload: IdentifyPayload | undefined,
): void {
  try {
    if (!sid || !payload || (!payload.distinctId && !payload.email)) {
      sessionStorage.removeItem(IDENTIFY_STORAGE_KEY);
      return;
    }
    sessionStorage.setItem(IDENTIFY_STORAGE_KEY, JSON.stringify({ sid, payload }));
  } catch {
    /* ignore — identity just won't survive this reload */
  }
}

export function createBatchSender(config: WebReplayConfig): BatchSender {
  const endpoint = new URL("/v1/replay/batch", config.apiHost).toString();
  const fetchImpl = config.fetchImpl ?? window.fetch.bind(window);
  // Identity is seeded by bindSession() (called from initReplay once the session
  // id + resumed flag are known) — NOT unconditionally at construction, so a
  // fresh session never inherits a prior session's user. See bindSession.
  let currentIdentify: IdentifyPayload | undefined;
  let currentSessionId: string | undefined;

  let currentFingerprint: string | undefined;

  // Lazily-created gzip worker. `undefined` = not tried yet, `null` =
  // tried and unavailable (env lacks Worker/CompressionStream).
  let gzipWorker: GzipWorker | null | undefined;

  // Compress the JSON body. Prefers the off-main-thread worker, falls
  // back to main-thread gzip, then to uncompressed — so a missing API
  // never blocks a send.
  const compressBody = async (
    json: string,
  ): Promise<{ body: BodyInit; gzip: boolean }> => {
    if (gzipWorker === undefined) gzipWorker = createGzipWorker();
    if (gzipWorker) {
      try {
        const buf = await gzipWorker.compress(json);
        return { body: buf, gzip: true };
      } catch {
        // Worker died — stop using it and fall through.
        gzipWorker.terminate();
        gzipWorker = null;
      }
    }
    const buf = await gzipMainThread(json);
    if (buf) return { body: buf, gzip: true };
    return { body: json, gzip: false };
  };

  // Regular sends not finished yet (see redeliverPending), and the keepalive
  // body bytes this sender has in flight (see KEEPALIVE_BUDGET_BYTES).
  const pending = new Set<PendingSend>();
  let keepaliveInflight = 0;
  // Bytes of recent sendBeacon calls, still counted (see BEACON_HOLD_MS).
  let beaconBytes = 0;
  const budgetUsed = () => keepaliveInflight + beaconBytes;
  // Set once a keepalive request was refused but a plain retry right after got
  // a real HTTP response: this browser rejects keepalive here (some engines
  // can't combine it with a CORS preflight). Regular sends then skip it, and
  // the unload path goes straight to sendBeacon.
  let keepaliveBroken = false;
  const beaconUrl = () =>
    `${endpoint}?${new URLSearchParams({ k: config.apiKey }).toString()}`;

  const readJson = async (response: Response): Promise<unknown> => {
    try {
      return await response.json();
    } catch {
      return undefined;
    }
  };

  const send = (async (envelope: ReplayBatchEnvelope): Promise<SendOutcome> => {
    const json = JSON.stringify({
      envelope,
      identify: currentIdentify,
      fingerprint: currentFingerprint,
    });
    const p: PendingSend = { envelope, json, keepaliveActive: false, superseded: false };
    pending.add(p);
    try {
      const { body, gzip } = await compressBody(json);
      if (gzip) p.gz = body as ArrayBuffer;
      // Re-sent on pagehide while compressing: that copy is the delivery.
      if (p.superseded) return { kind: "ok" };
      const bytes = gzip ? (body as ArrayBuffer).byteLength : utf8Bytes(json);
      const headers: Record<string, string> = {
        "content-type": "application/json",
        "x-replay-api-key": config.apiKey,
      };
      // Content-Encoding: gzip lets the server (express body-parser)
      // transparently inflate before JSON parsing.
      if (gzip) headers["content-encoding"] = "gzip";

      let keepaliveRefused = false;
      for (let attempt = 1; attempt <= MAX_SEND_ATTEMPTS; attempt += 1) {
        if (p.superseded) return { kind: "ok" };
        const keepalive =
          KEEPALIVE_SUPPORTED &&
          !keepaliveBroken &&
          !keepaliveRefused &&
          bytes <= REGULAR_KEEPALIVE_MAX_BYTES &&
          budgetUsed() + bytes <= REGULAR_KEEPALIVE_SHARE_BYTES;
        if (keepalive) {
          keepaliveInflight += bytes;
          p.keepaliveActive = true;
        }
        let outcome: SendOutcome;
        const abort =
          typeof AbortController === "function" ? new AbortController() : undefined;
        let timedOut = false;
        const timer = abort
          ? setTimeout(() => {
              timedOut = true;
              abort.abort();
            }, SEND_TIMEOUT_MS + Math.ceil(bytes / MIN_UPLOAD_BYTES_PER_MS))
          : undefined;
        try {
          const response = await fetchImpl(endpoint, {
            method: "POST",
            headers,
            body,
            ...(keepalive ? { keepalive: true } : {}),
            ...(abort ? { signal: abort.signal } : {}),
          });
          // A real response right after a refused keepalive: keepalive is
          // what failed, not the network.
          if (!keepalive && keepaliveRefused) keepaliveBroken = true;
          outcome = classifyBatchResponse(
            response.status,
            await readJson(response),
          );
        } catch {
          // Network/CORS rejection, a timeout, or the browser refused the
          // keepalive (budget full, old engine) → transient; retry, without
          // keepalive unless it was only slow.
          if (keepalive && !timedOut) keepaliveRefused = true;
          outcome = { kind: "retry" };
        } finally {
          if (timer !== undefined) clearTimeout(timer);
          if (keepalive) {
            keepaliveInflight -= bytes;
            p.keepaliveActive = false;
          }
        }
        // Handed to pagehide's re-send or to the next page load meanwhile: that
        // copy delivers these events, so a failure here must not requeue them.
        if (p.superseded && outcome.kind === "retry") return { kind: "ok" };
        if (outcome.kind !== "retry" || outcome.status === 429) return outcome;
        if (attempt < MAX_SEND_ATTEMPTS) {
          await new Promise((r) =>
            setTimeout(r, SEND_BACKOFF_MS * 2 ** (attempt - 1)),
          );
        }
      }
      return p.superseded ? { kind: "ok" } : { kind: "retry" };
    } finally {
      pending.delete(p);
    }
  }) as BatchSender;

  // Fire one keepalive POST within the budget (sendBeacon where keepalive isn't
  // supported, or as the fallback when the fetch is refused). Returns false,
  // sending nothing, when it doesn't fit.
  const fireUnloadSafe = (
    body: string | ArrayBuffer,
    gzip: boolean,
    json: string,
    reserve = 0,
  ): boolean => {
    const bytes = typeof body === "string" ? utf8Bytes(body) : body.byteLength;
    if (budgetUsed() + bytes + reserve > KEEPALIVE_BUDGET_BYTES) return false;
    if (!KEEPALIVE_SUPPORTED || keepaliveBroken) return beacon(json, reserve);
    keepaliveInflight += bytes;
    const release = () => {
      keepaliveInflight -= bytes;
    };
    try {
      const headers: Record<string, string> = {
        "content-type": "application/json",
        "x-replay-api-key": config.apiKey,
      };
      if (gzip) headers["content-encoding"] = "gzip";
      void fetchImpl(endpoint, { method: "POST", headers, body, keepalive: true })
        .then(release, () => {
          release();
          beacon(json);
        });
      return true;
    } catch {
      release();
      return beacon(json, reserve);
    }
  };

  // sendBeacon can't set headers, so the key rides as ?k= (the backend accepts
  // either). The Blob is text/plain (a CORS-safelisted type) so this
  // cross-origin beacon isn't preflighted — application/json would be, and
  // sendBeacon can't do a preflight, so the browser would CORS-block it. It
  // shares the 64 KiB budget, so only bodies that fit are tried.
  const beacon = (json: string, reserve = 0): boolean => {
    try {
      if (typeof navigator === "undefined" || !navigator.sendBeacon) return false;
      const bytes = utf8Bytes(json);
      if (budgetUsed() + bytes + reserve > KEEPALIVE_BUDGET_BYTES) return false;
      const queued = navigator.sendBeacon(
        beaconUrl(),
        new Blob([json], { type: "text/plain" }),
      );
      if (queued) {
        beaconBytes += bytes;
        setTimeout(() => {
          beaconBytes -= bytes;
        }, BEACON_HOLD_MS);
      }
      return queued;
    } catch {
      return false; // nothing left to try — the page is going away
    }
  };

  send.bindSession = (sessionId, resumed) => {
    currentSessionId = sessionId;
    // Re-attach a persisted identity ONLY when this page load resumed the SAME
    // session it was captured under. A freshly minted session (new tab, or a
    // post-inactivity rollover in the same tab) starts anonymous until the host
    // re-identifies — otherwise it would inherit the previous session's
    // (possibly logged-out or different) user. Ties identity to the session's
    // lifetime, matching the reference tracker's per-session user id.
    const stored = loadStoredIdentify();
    if (resumed && stored && stored.sid === sessionId) {
      currentIdentify = stored.payload;
    } else {
      currentIdentify = undefined;
      persistIdentify(undefined, undefined); // drop any stale prior-session identity
    }
  };
  send.setIdentify = (identify) => {
    if (!identify) {
      currentIdentify = undefined;
      persistIdentify(currentSessionId, undefined);
      return;
    }
    // REPLACE (not merge) when the distinctId changes — a shallow merge would
    // ship the previous user's email/name/plan/customProps under the new user's
    // id (cross-user PII contamination). Merge only for a same-user trait update
    // or a trait-only call (no distinctId).
    const prev = currentIdentify;
    const switchingUser =
      !!identify.distinctId &&
      !!prev?.distinctId &&
      identify.distinctId !== prev.distinctId;
    currentIdentify = switchingUser
      ? { ...identify }
      : { ...(prev ?? {}), ...identify };
    // Persist (tagged with this session) so a reload of the SAME session
    // re-attaches it; bindSession guards against a different session reusing it.
    persistIdentify(currentSessionId, currentIdentify);
  };
  send.setFingerprint = (fp) => {
    currentFingerprint = fp;
  };
  send.retagSession = (sessionId) => {
    currentSessionId = sessionId;
    persistIdentify(sessionId, currentIdentify);
  };
  send.finalRoom = (shell, keepReserve) =>
    KEEPALIVE_BUDGET_BYTES -
    budgetUsed() -
    (keepReserve ? UNLOAD_RESERVE_BYTES : 0) -
    utf8Bytes(
      JSON.stringify({
        envelope: { ...shell, events: [] },
        identify: currentIdentify,
        fingerprint: currentFingerprint,
      }),
    );
  send.sendFinal = (envelope) => {
    const json = JSON.stringify({
      envelope,
      identify: currentIdentify,
      fingerprint: currentFingerprint,
    });
    return fireUnloadSafe(json, false, json);
  };
  send.redeliverPending = () => {
    const unsent: ReplayBatchEnvelope[] = [];
    for (const p of pending) {
      if (p.keepaliveActive || p.superseded) continue;
      // The gzip bytes when compression finished (smaller), else the JSON.
      // Older events, but the closing batch after them must still fit.
      const sent = p.gz
        ? fireUnloadSafe(p.gz, true, p.json, UNLOAD_RESERVE_BYTES)
        : fireUnloadSafe(p.json, false, p.json, UNLOAD_RESERVE_BYTES);
      // Too big to re-send now: handed back (same sequence) for the next page
      // load, so this send must not requeue its events as well.
      p.superseded = true;
      if (!sent) unsent.push(p.envelope);
    }
    return unsent;
  };

  return send;
}
