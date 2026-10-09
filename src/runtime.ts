import type {
  ReplayBatchEnvelope,
  ReplayEvent,
  ReplaySdkDescriptor,
} from "./schema";
import type { WebReplayConfig } from "./types";

interface SessionRuntime {
  sessionId: string;
  segmentId: string;
  startedAt: number;
  /** True when this page load RESUMED an existing session (same tab, within the
   *  inactivity window) instead of minting a fresh one — a reload or same-tab
   *  back/forward. The caller records a resume as a navigation, not a new
   *  session_start, so the original entry page is preserved. */
  resumed: boolean;
  /** Re-anchor a FRESH session's clock to NOW. Called at the visibility-gated
   *  start so the timeline begins when the page is first VISIBLE, not when a
   *  hidden / prerendered tab happened to construct the runtime. The caller only
   *  invokes it for !resumed sessions, so a reload keeps its original startedAt
   *  (offset continuity across the load). */
  beginFreshClock: () => void;
  sdk: ReplaySdkDescriptor;
  makeEventId: () => string;
  push: (event: ReplayEvent) => void;
  drain: () => ReplayEvent[];
  /** Put un-sent events back at the FRONT of the buffer after a failed send, so
   *  the next flush retries them instead of dropping the batch. Bounded. */
  requeue: (events: ReplayEvent[]) => void;
  /** Mark genuine USER activity (an interaction) so a subsequent reload within
   *  the inactivity window continues this session. Cheap + throttled — safe to
   *  call on every pointer/scroll/key event. */
  touch: () => void;
  /** The inactivity window (ms). Governs BOTH the reload resume-vs-fresh decision
   *  AND the live idle-timeout that ends a session with no meaningful activity. */
  inactivityMs: number;
  /** Start a BRAND-NEW session in place — mint a fresh sessionId/segmentId, reset
   *  the clock to now, and drop any residual buffer. The batch sequence is NOT
   *  reset: it is a tab-wide count (see claimSequence). Called
   *  when a user returns after the session was ended for inactivity, so the
   *  return is a new session (new id) rather than a continuation of a stale one.
   *  The transport's identify/fingerprint state is untouched — it's the same
   *  anonymous/identified person. */
  rotate: () => void;
  nextSequence: () => number;
  pageContext: () => ReplayBatchEnvelope["page"];
  startAutoFlush: (flush: () => Promise<void>) => void;
  stopAutoFlush: () => void;
  /** Deliver everything buffered on page-hide/unload, CHUNKED so each piece
   *  stays under the beacon/keepalive ~64KB cap. A single oversized final batch
   *  is silently dropped by the browser → the session's closing frames never
   *  persist (a blank/frozen replay tail). Each chunk goes through the
   *  transport's unload-reliable sendFinal (keepalive-fetch, beacon fallback). */
  flushFinal: (sendFinal: (envelope: ReplayBatchEnvelope) => void) => void;
}

/** Conservative per-chunk byte budget for the final flush. sendBeacon and
 *  keepalive fetch both cap the body near 64KB; 55KB leaves headroom for the
 *  envelope wrapper. rrweb payloads are ~ASCII so string length ≈ byte length. */
const MAX_FINAL_CHUNK_BYTES = 55_000;

function safeTimezone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
}

function pageContext(): ReplayBatchEnvelope["page"] {
  return {
    url: window.location.href,
    title: document.title,
    referrer: document.referrer,
    userAgent: navigator.userAgent,
    viewport: { width: window.innerWidth, height: window.innerHeight },
    screen: { width: window.screen.width, height: window.screen.height },
    timezone: safeTimezone(),
    language: navigator.language,
  };
}

/** Monotonic within a page load — guarantees two ids minted back-to-back
 *  (e.g. sessionId then segmentId) differ even if every RANDOM source below is
 *  degenerate. */
let idSeq = 0;

/** A collision-resistant id. The old version was pure `crypto.getRandomValues`,
 *  which a hostile/headless client can STUB to return constant bytes — a crawler
 *  did exactly that and produced the SAME ses_/seg_ id on two different sites,
 *  merging their recordings server-side. So the id no longer trusts the RNG
 *  alone: it also folds in a high-resolution timestamp, a per-page monotonic
 *  counter, and Math.random (a separate PRNG). A collision now requires the
 *  wall clock, the counter, Math.random AND crypto to ALL coincide — which they
 *  can't for two distinct sessions. `crypto.randomUUID`/`getRandomValues` still
 *  supply the bulk of the entropy on a healthy client. */
function shortId(prefix: string): string {
  idSeq = (idSeq + 1) & 0xffffff;
  let rnd = "";
  try {
    const c = globalThis.crypto;
    if (c && typeof c.randomUUID === "function") {
      rnd = c.randomUUID().replace(/-/g, "");
    } else if (c && typeof c.getRandomValues === "function") {
      const b = new Uint8Array(12);
      c.getRandomValues(b);
      rnd = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
    }
  } catch {
    /* crypto unavailable — the non-crypto sources below still keep it unique */
  }
  const now =
    Date.now().toString(36) +
    (typeof performance !== "undefined" && performance.now
      ? Math.floor(performance.now() * 1000).toString(36)
      : "");
  const jitter =
    idSeq.toString(36) + Math.floor(Math.random() * 0x100000000).toString(36);
  return `${prefix}${now}${jitter}${rnd}`;
}

/** Hard cap on buffered events so a sustained ingest outage (every flush failing
 *  and re-queuing) can't grow the buffer without bound. A few MB of rrweb. */
const MAX_BUFFERED_EVENTS = 20000;

/** Where a session's identity lives BETWEEN page loads. sessionStorage is
 *  per-tab: it survives a reload/same-tab navigation but is cleared when the tab
 *  closes — so a reload CONTINUES the session while a brand-new tab starts a
 *  fresh one. This is a deliberate per-tab session model: each tab is its own
 *  session, and what ties a person's tabs together is the shared anonymous id
 *  (see fingerprint.ts, in per-origin localStorage), which the backend uses to
 *  stitch the tabs' sessions to one user. Cross-tab session sharing — one
 *  session spanning several open tabs — is intentionally NOT done here; it would
 *  need a per-tab id in the capture format plus a tab-aware player, and is
 *  tracked as separate future work. */
const SESSION_STORAGE_KEY = "replay:ses";

/** Default inactivity window: a reload only continues the session if the last
 *  user interaction was within this long. 30 min is the session-analytics norm.
 *  Overridable via config.sessionInactivityMs. */
const DEFAULT_INACTIVITY_MS = 30 * 60 * 1000;

/** Where the tab's batch counter lives: the highest batch `sequence` used in this
 *  tab so far. Each page load continues from it, so a session that spans page
 *  loads (a reload, a same-tab navigation) never reuses a number. SDKs up to
 *  0.1.16 restarted at 1 per page load, and servers keying batches on
 *  (sessionId, sequence) then dropped or overwrote one page's batches. A key of
 *  its own (not a field of SESSION_STORAGE_KEY) keeps the session record written
 *  exactly as before, so an older SDK page in the same tab can't erase it. */
const SEQUENCE_STORAGE_KEY = "replay:sq";

/** Highest batch sequence the ingest accepts (it is stored as INT4). */
const MAX_SEQUENCE = 2_147_483_647;

/** Largest host-supplied sessionId the ingest accepts, in UTF-8 bytes. */
const MAX_SESSION_ID_BYTES = 2000;

/** Characters the ingest rejects in an id: C0 controls (incl. NUL) and lone
 *  UTF-16 surrogates. */
const INVALID_ID_CHARS =
  /[\u0000-\u001F\u007F]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** Don't persist the last-activity marker on every pointer/scroll event — once
 *  every few seconds keeps the reload window accurate at negligible cost. The
 *  window (minutes) dwarfs this staleness, so it never changes a resume verdict. */
const ACTIVITY_PERSIST_THROTTLE_MS = 5000;

interface PersistedSession {
  /** sessionId */
  sid: string;
  /** original session start — kept across reloads so offsetMs stays monotonic */
  st: number;
  /** last USER-activity timestamp — drives the inactivity/resume decision */
  la: number;
}

/** True for a session id the ingest will accept. */
function isUsableSessionId(id: unknown): id is string {
  return (
    typeof id === "string" &&
    id.length > 0 &&
    new TextEncoder().encode(id).length <= MAX_SESSION_ID_BYTES &&
    !INVALID_ID_CHARS.test(id)
  );
}

function readPersistedSession(): PersistedSession | null {
  try {
    const raw = sessionStorage.getItem(SESSION_STORAGE_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as Partial<PersistedSession>;
    if (
      isUsableSessionId(p.sid) &&
      typeof p.st === "number" &&
      typeof p.la === "number"
    ) {
      return { sid: p.sid, st: p.st, la: p.la };
    }
  } catch {
    /* sessionStorage blocked (private mode) or corrupt JSON — treat as no prior
       session; we just mint a fresh one, recording is otherwise unaffected. */
  }
  return null;
}

function writePersistedSession(p: PersistedSession): void {
  try {
    sessionStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(p));
  } catch {
    /* sessionStorage unavailable/full — the session simply won't survive a
       reload; nothing else breaks. */
  }
}

/** The tab's highest batch sequence so far, or 0 when there is none (or it is
 *  unreadable or out of range). */
function readStoredSequence(): number {
  try {
    const n = Number(sessionStorage.getItem(SEQUENCE_STORAGE_KEY));
    return Number.isInteger(n) && n > 0 && n <= MAX_SEQUENCE ? n : 0;
  } catch {
    return 0;
  }
}

function writeStoredSequence(n: number): void {
  try {
    sessionStorage.setItem(SEQUENCE_STORAGE_KEY, String(n));
  } catch {
    /* unavailable/full — the next page load restarts numbering at 1, which the
       server still keeps apart by segmentId. */
  }
}

export function createSessionRuntime(config: WebReplayConfig): SessionRuntime {
  const now = Date.now();
  const inactivityMs = config.sessionInactivityMs ?? DEFAULT_INACTIVITY_MS;

  // Decide this page load's session identity:
  //   1. a usable explicit config.sessionId always wins (host-controlled).
  //   2. otherwise resume the tab's stored session if the last USER interaction
  //      was within the inactivity window (reload / same-tab back-forward) —
  //      reusing its original startedAt so offsets stay monotonic across loads.
  //   3. otherwise mint a fresh session.
  let sessionId: string;
  let startedAt: number;
  let lastActivityAt: number;
  let resumed = false;
  // The ingest rejects an unusable id, so sending one would fail every batch:
  // ignore it (with a warning) and fall back to the SDK's own id.
  const hostSessionId = isUsableSessionId(config.sessionId)
    ? config.sessionId
    : undefined;
  if (config.sessionId && !hostSessionId) {
    console.warn(
      `[replay-sdk] config.sessionId ignored: it must be a string of at most ${MAX_SESSION_ID_BYTES} bytes with no control characters.`,
    );
  }
  if (hostSessionId) {
    sessionId = hostSessionId;
    startedAt = now;
    lastActivityAt = now;
  } else {
    const prior = readPersistedSession();
    if (prior && now - prior.la < inactivityMs) {
      sessionId = prior.sid;
      startedAt = prior.st;
      lastActivityAt = prior.la;
      resumed = true;
    } else {
      sessionId = shortId("ses_");
      startedAt = now;
      lastActivityAt = now;
    }
  }
  // Persist right away so even an instant reload (before any interaction) still
  // resumes, and so `st` is pinned to this session's true origin.
  writePersistedSession({ sid: sessionId, st: startedAt, la: lastActivityAt });

  let segmentId = shortId("seg_");
  const buffer: ReplayEvent[] = [];
  // Continue the tab's batch count (see SEQUENCE_STORAGE_KEY).
  let sequence = readStoredSequence();
  // Claim the next batch number: one above the highest used in this tab (by
  // us, or by another runtime sharing this tab's sessionStorage — a second
  // init() on the page, a same-origin iframe), persisted synchronously before
  // the batch is sent so the next page load (even one started from this page's
  // unload handler) continues after it. Past the ingest's INT4 cap it restarts
  // at 1, which is safe: the server keys batches per page load (segmentId).
  const claimSequence = () => {
    const next = Math.max(sequence, readStoredSequence()) + 1;
    sequence = next <= MAX_SEQUENCE ? next : 1;
    writeStoredSequence(sequence);
    return sequence;
  };
  let timer: number | undefined;
  let lastActivityPersist = now;

  const sdk: ReplaySdkDescriptor = {
    name: config.sdk?.name ?? "@replay/web-sdk",
    version: config.sdk?.version ?? "0.1.0",
    platform: config.sdk?.platform ?? "web",
    ...(config.revId ? { revId: config.revId } : {}),
  };

  return {
    // Getters, not snapshots — rotate() reassigns the identity mid-flight (a
    // return after an inactivity end), and every reader (flush's envelope, the
    // controller's `sessionId`) must see the CURRENT session, not the one that
    // existed at init.
    get sessionId() {
      return sessionId;
    },
    get segmentId() {
      return segmentId;
    },
    // Live getter — `beginFreshClock()` can re-anchor it at the visibility-gated
    // start, and the emit()/minDuration reads must see the updated value.
    get startedAt() {
      return startedAt;
    },
    resumed,
    inactivityMs,
    beginFreshClock: () => {
      startedAt = Date.now();
      lastActivityAt = startedAt;
      lastActivityPersist = startedAt;
      writePersistedSession({ sid: sessionId, st: startedAt, la: startedAt });
    },
    rotate: () => {
      sessionId = shortId("ses_");
      segmentId = shortId("seg_");
      startedAt = Date.now();
      lastActivityAt = startedAt;
      lastActivityPersist = startedAt;
      // `sequence` is NOT reset: the tab-wide count continues (claimSequence).
      // The ended session was flushed before we got here; drop any residual so
      // the new session starts clean (its first batch must be full_snapshot-led).
      buffer.length = 0;
      writePersistedSession({ sid: sessionId, st: startedAt, la: startedAt });
    },
    sdk,
    makeEventId: () => globalThis.crypto.randomUUID(),
    push: (event) => {
      buffer.push(event);
    },
    drain: () => buffer.splice(0, buffer.length),
    requeue: (events) => {
      if (events.length === 0) return;
      // Prepend the un-sent (older) events ahead of anything captured during the
      // failed send, preserving order — without spreading a possibly-large array
      // into unshift() (which can overflow the call stack).
      const tail = buffer.splice(0, buffer.length);
      for (let i = 0; i < events.length; i += 1) buffer.push(events[i]);
      for (let i = 0; i < tail.length; i += 1) buffer.push(tail[i]);
      // Bound memory during a sustained outage: keep the OLDEST events — the rrweb
      // FullSnapshot lives there and losing it makes the whole recording
      // unplayable — dropping the newest beyond the cap.
      if (buffer.length > MAX_BUFFERED_EVENTS) buffer.length = MAX_BUFFERED_EVENTS;
    },
    touch: () => {
      const t = Date.now();
      lastActivityAt = t;
      // Throttle the write — in-memory lastActivityAt is always current; only the
      // persisted copy lags (<= throttle), which the minutes-long window absorbs.
      if (t - lastActivityPersist >= ACTIVITY_PERSIST_THROTTLE_MS) {
        lastActivityPersist = t;
        writePersistedSession({ sid: sessionId, st: startedAt, la: t });
      }
    },
    nextSequence: claimSequence,
    pageContext,
    startAutoFlush: (flush) => {
      const flushIntervalMs = config.flushIntervalMs ?? 3000;
      timer = window.setInterval(() => {
        void flush();
      }, flushIntervalMs);
    },
    stopAutoFlush: () => {
      if (timer !== undefined) window.clearInterval(timer);
    },
    flushFinal: (sendFinal) => {
      const events = buffer.splice(0, buffer.length);
      if (events.length === 0) return;
      let chunk: ReplayEvent[] = [];
      let chunkBytes = 0;
      const ship = () => {
        if (chunk.length === 0) return;
        sendFinal({
          projectId: config.projectId,
          sessionId,
          segmentId,
          sequence: claimSequence(),
          sentAt: Date.now(),
          sdk,
          page: pageContext(),
          events: chunk,
        });
        chunk = [];
        chunkBytes = 0;
      };
      for (let i = 0; i < events.length; i += 1) {
        const ev = events[i];
        const evBytes = JSON.stringify(ev).length;
        // Close the current chunk before an event that would overflow it — but
        // never emit an empty chunk, so a single event over the cap still ships
        // alone (the best we can do without async compression on unload).
        if (chunkBytes + evBytes > MAX_FINAL_CHUNK_BYTES && chunk.length > 0) {
          ship();
        }
        chunk.push(ev);
        chunkBytes += evBytes;
      }
      ship();
    },
  };
}
