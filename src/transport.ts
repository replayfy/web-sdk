import type { ReplayBatchEnvelope } from "./schema";
import type { WebReplayConfig } from "./types";

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

export interface BatchSender {
  (envelope: ReplayBatchEnvelope, useBeacon?: boolean): Promise<void>;
  setIdentify: (identify: IdentifyPayload | undefined) => void;
  setFingerprint: (fp: string) => void;
  /** Bind the sender to THIS page load's session. Re-attaches a persisted
   *  identity only when the same session resumed; a fresh session is cleared to
   *  anonymous. Call once, before any setIdentify. */
  bindSession: (sessionId: string, resumed: boolean) => void;
  /** Unload-reliable send for the final flush: a keepalive fetch (survives page
   *  teardown AND sets the api-key header, so it authenticates even where ?k=
   *  isn't accepted), falling back to sendBeacon. Fire-and-forget. */
  sendFinal: (envelope: ReplayBatchEnvelope) => void;
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

/** Retry a failed replay batch a few times before giving up. Transient failures
 *  (network/CORS rejection, 5xx, 429) are retried; a 4xx or a 2xx-but-rejected is
 *  terminal. On a hard outage the caller re-queues the batch for the next flush. */
const MAX_SEND_ATTEMPTS = 3;
const SEND_BACKOFF_MS = 300;

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

  const send: BatchSender = async (
    envelope: ReplayBatchEnvelope,
    useBeacon = false,
  ): Promise<void> => {
    const json = JSON.stringify({
      envelope,
      identify: currentIdentify,
      fingerprint: currentFingerprint,
    });

    if (useBeacon && "sendBeacon" in navigator) {
      // sendBeacon is sync and can't set headers, so it stays uncompressed and
      // the key rides as ?k= — it only fires on unload where the last small
      // batch isn't worth the async gzip round-trip.
      // The Blob MUST be text/plain, not application/json: the ingest host is
      // cross-origin to every customer site, and a non-CORS-safelisted
      // content-type (application/json) turns the POST into a PREFLIGHTED
      // request — which sendBeacon cannot satisfy, so the browser blocks it
      // ("CORS error"/provisional headers) and the tail batch is dropped.
      // text/plain is safelisted → no preflight; the backend parses it as JSON.
      const url = `${endpoint}?${new URLSearchParams({ k: config.apiKey }).toString()}`;
      navigator.sendBeacon(url, new Blob([json], { type: "text/plain" }));
      return;
    }

    const { body, gzip } = await compressBody(json);
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "x-replay-api-key": config.apiKey,
    };
    // Content-Encoding: gzip lets the server (express body-parser)
    // transparently inflate before JSON parsing.
    if (gzip) headers["content-encoding"] = "gzip";

    // Retry transient failures with exponential backoff. A fetch rejection
    // (network/CORS) or a 5xx/429 is transient; a 4xx or a 2xx-but-rejected is
    // terminal (retrying won't help), so we surface those immediately. After the
    // last attempt the error propagates and the caller re-queues the batch.
    let lastError: unknown;
    for (let attempt = 1; attempt <= MAX_SEND_ATTEMPTS; attempt += 1) {
      try {
        const response = await fetchImpl(endpoint, {
          method: "POST",
          headers,
          body,
        });
        if (response.ok) {
          const payload = (await response.json()) as ApiResponse<{
            accepted: boolean;
          }>;
          if (!payload.ok || !payload.data.accepted) {
            throw new Error("Replay batch rejected by server");
          }
          return; // delivered
        }
        // Only 5xx / 429 are worth retrying; any other status is terminal.
        if (response.status < 500 && response.status !== 429) {
          throw new Error(`Replay batch failed with status ${response.status}`);
        }
        lastError = new Error(
          `Replay batch failed with status ${response.status}`,
        );
      } catch (e) {
        // Terminal errors thrown above must not burn retries — re-throw them.
        if (
          e instanceof Error &&
          (e.message.startsWith("Replay batch failed with status") ||
            e.message === "Replay batch rejected by server")
        ) {
          throw e;
        }
        // Otherwise it's a network/CORS fetch rejection → retryable.
        lastError = e;
      }
      if (attempt < MAX_SEND_ATTEMPTS) {
        await new Promise((r) =>
          setTimeout(r, SEND_BACKOFF_MS * 2 ** (attempt - 1)),
        );
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error("Replay batch send failed after retries");
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
  const beaconFallback = (json: string) => {
    try {
      if (typeof navigator !== "undefined" && navigator.sendBeacon) {
        // Beacon can't set headers, so the key rides as ?k= (the backend accepts
        // either). Kept < 55KB per chunk by the caller so it isn't dropped. The
        // Blob is text/plain (a CORS-safelisted type) so this cross-origin beacon
        // isn't preflighted — application/json would be, and sendBeacon can't do
        // a preflight, so the browser would CORS-block it.
        const url = `${endpoint}?${new URLSearchParams({ k: config.apiKey }).toString()}`;
        navigator.sendBeacon(url, new Blob([json], { type: "text/plain" }));
      }
    } catch {
      /* nothing left to try — the page is going away */
    }
  };
  send.sendFinal = (envelope) => {
    const json = JSON.stringify({
      envelope,
      identify: currentIdentify,
      fingerprint: currentFingerprint,
    });
    // Primary: keepalive fetch. It survives the unload and, unlike sendBeacon,
    // sets the x-replay-api-key HEADER. Only fall back to a beacon if the fetch
    // rejects/throws while the page is still alive (no double-send on success).
    try {
      void fetchImpl(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-replay-api-key": config.apiKey,
        },
        body: json,
        keepalive: true,
      }).catch(() => beaconFallback(json));
    } catch {
      beaconFallback(json);
    }
  };

  return send;
}
