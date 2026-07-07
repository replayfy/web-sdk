import type { ReplayBatchEnvelope } from "./schema";
import type { WebReplayConfig } from "./types";

export interface IdentifyPayload {
  distinctId?: string;
  email?: string;
  name?: string;
  plan?: string;
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

export function createBatchSender(config: WebReplayConfig): BatchSender {
  const endpoint = new URL("/v1/replay/batch", config.apiHost).toString();
  const fetchImpl = config.fetchImpl ?? window.fetch.bind(window);
  let currentIdentify: IdentifyPayload | undefined;

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
      // sendBeacon is sync and can't set headers, so it stays
      // uncompressed — it only fires on unload where the last small
      // batch isn't worth the async gzip round-trip.
      const url = `${endpoint}?${new URLSearchParams({ k: config.apiKey }).toString()}`;
      navigator.sendBeacon(url, new Blob([json], { type: "application/json" }));
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

    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers,
      body,
    });

    if (!response.ok) {
      throw new Error(`Replay batch failed with status ${response.status}`);
    }

    const payload = (await response.json()) as ApiResponse<{
      accepted: boolean;
    }>;
    if (!payload.ok || !payload.data.accepted) {
      throw new Error("Replay batch rejected by server");
    }
  };

  send.setIdentify = (identify) => {
    if (!identify) {
      currentIdentify = undefined;
      return;
    }
    currentIdentify = { ...(currentIdentify ?? {}), ...identify };
  };
  send.setFingerprint = (fp) => {
    currentFingerprint = fp;
  };

  return send;
}
