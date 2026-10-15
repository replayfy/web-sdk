import type {
  ReplayBatchEnvelope,
  ReplayEvent,
  ReplaySdkDescriptor,
} from "./schema";
import { SDK_NAME, SDK_VERSION } from "./version";
import type { SendOutcome } from "./transport";
import type { WebReplayConfig } from "./types";
import { redactUrlForStorage, utf8Bytes } from "./utils";

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
  /** Bumped whenever the session identity changes in place (rotate(), or a
   *  back/forward-cache restore that lands in another session). Read it before
   *  building a batch and pass it back to requeue(). */
  readonly generation: number;
  /** Put a batch whose send failed back at the FRONT of `carried`, whole: its
   *  segment, page, sequence and events as they went out (after beforeSend).
   *  The next flush resends exactly that batch under the same number, so a copy
   *  that did reach the server (the response was lost: a timeout, a proxy
   *  504/524, a reset connection) is deduped there instead of stored twice
   *  under two numbers. It stays under its own segment even when the page came
   *  back from the back/forward cache meanwhile. A batch built under an older
   *  generation belongs to a session that has since ended: it is dropped
   *  (returns false), never shipped under the new id. Bounded with the buffer
   *  (MAX_BUFFERED_EVENTS). */
  requeue: (batch: CarriedBatch, generation: number) => boolean;
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
  /** Ship the buffer on hide/unload as ONE batch that fits `roomFor(shell)`
   *  bytes of events (the browser's keepalive/beacon budget, shared by every
   *  in-flight unload request of the document — several chunks at once would
   *  just get the later ones rejected). It carries the most valuable events
   *  first (selectForFinalBatch); everything else goes back to the buffer, so
   *  if the page lives on (a tab switch, a back/forward-cache page) the next
   *  regular flush sends it. With `withCarried` (the page is going away; a tab
   *  switch leaves them to the regular flush, which retries), carried batches
   *  go out first, whole, while they leave FINAL_TAIL_ROOM_BYTES for this one.
   *  A failed send waiting for its retry (requeue) that is too big to go whole
   *  sends its priority events on their own (see sendPriorityPart); on a tab
   *  switch it goes too, once per failed send: a copy that stays carried, or
   *  that priority part.
   *  `sendFinal` returns false when nothing was sent; `hooked` says beforeSend
   *  already ran on the batch (see CarriedBatch.hooked). */
  flushFinal: (
    sendFinal: (envelope: ReplayBatchEnvelope, hooked: boolean) => boolean,
    roomFor: (shell: ReplayBatchEnvelope) => number,
    withCarried: boolean,
  ) => void;
  /** Uploads of this session the page is leaving behind unfinished (too big to
   *  re-send within the unload budget): carried, under their own segment, page
   *  and sequence, ahead of everything else. `about(envelope)` gives what the
   *  caller knows of each: whether beforeSend already ran on it (resent as it
   *  is) and the privacy rules it was recorded under. Other sessions' are
   *  dropped. */
  carryUnsent: (
    envelopes: ReplayBatchEnvelope[],
    about?: (envelope: ReplayBatchEnvelope) => Pick<CarriedBatch, "hooked" | "rules">,
  ) => void;
  /** Batches waiting to be sent ahead of the buffer, oldest first: a regular
   *  send that failed (requeue), or what an earlier page load of THIS session
   *  couldn't send before it went away (past the unload budget) or left
   *  buffered before a back/forward-cache restore. The next flushes send them
   *  first, each under its own segment and page (and number, once it has one).
   *  Mutable: the caller takes from the front. */
  carried: CarriedBatch[];
  /** The page is going away with events it couldn't send (past the unload
   *  budget, or before its first snapshot): hand anything still carried, and
   *  the buffer unless `carriedOnly`, to the next page load of this session in
   *  this tab, through sessionStorage. A buffer too big for the outbox goes
   *  without its replay stream (what stays behind is lost unless the page
   *  comes back from the back/forward cache). Returns false when there was
   *  nothing to keep or it didn't fit (then it's dropped). */
  stashForNextPage: (carriedOnly?: boolean) => boolean;
  /** The page came back from the back/forward cache. Decide its identity the
   *  way a page load would (continue the tab's session when its last activity
   *  is within the inactivity window, else start a new one) and always start a
   *  NEW segment: the replay needs a fresh base snapshot for this page. What
   *  was buffered before the freeze is carried under the old segment, after
   *  what the outbox gives back (older: stashed at pagehide). Returns true
   *  when the session continued. */
  restoreFromBfcache: () => boolean;
  /** Take what another page load of this session left in the outbox after
   *  this one began (the page left by going back or forward to this one from
   *  the back/forward cache: the browser can fire its pagehide only after the
   *  restore), carried after what is already held. An outbox of another
   *  session is left alone. */
  adoptOutbox: () => void;
}

/** How many times the hide/unload batch is tried, halving its room each time. */
const FINAL_BATCH_TRIES = 4;

/** Budget a carried batch must leave free on hide/unload for the current page's
 *  own tail (its session end, errors and page view come first in it). */
const FINAL_TAIL_ROOM_BYTES = 8 * 1024;

/** A page load's events waiting to be sent under that page load's segment,
 *  with that page's context: the server takes a session's entry page, referrer
 *  and UTM tags from its first batch, so a landing page's held events must not
 *  go out under the next page's URL. */
export interface CarriedBatch {
  segmentId: string;
  events: ReplayEvent[];
  page?: ReplayBatchEnvelope["page"];
  /** Set for a batch already sent once (a send that failed, or an upload the
   *  page left before it finished): resent under the same number, so a copy
   *  that did land is deduped by the server instead of stored twice. */
  sequence?: number;
  /** A beforeSend hook already ran on `events` and `page` (they are what was
   *  sent): the batch is resent as it is, the hook only asked whether it may
   *  go (recheckBeforeSend). Running the hook on its own output again could
   *  change the batch under a number the server may already hold (a hook that
   *  hashes a value would hash the hash). Unset when no hook ran, so a page
   *  that has one still scrubs a batch sent by a page that had none. */
  hooked?: boolean;
  /** The privacy rules its events were recorded under, as the caller (see
   *  SessionRuntimeOptions.privacyTag) describes them: opaque here. The page
   *  that sends the batch checks them against the rules it knows by then.
   *  Unset for a batch an older SDK version left. */
  rules?: Record<string, unknown>;
}

/** Where a page that is going away leaves the events it couldn't send (past
 *  the browser's unload budget) for the next page load of the same session in
 *  this tab: a same-tab navigation continues the session, so they still reach
 *  the server. If no page continues the session (tab closed, session expired),
 *  they're discarded with the tab. One outbox per ingest host + key (see
 *  outboxKey), so another project's SDK on the same site never sends them. */
const OUTBOX_STORAGE_KEY = "replay:outbox";

/** The outbox key for one ingest host + api key: a short hash, so the key
 *  itself isn't repeated in storage. */
function outboxKey(config: WebReplayConfig): string {
  const owner = `${config.apiHost}|${config.apiKey}`;
  let h = 5381;
  for (let i = 0; i < owner.length; i += 1) h = ((h * 33) ^ owner.charCodeAt(i)) >>> 0;
  return `${OUTBOX_STORAGE_KEY}:${h.toString(36)}`;
}

/** Cap on what the outbox may hold, in UTF-16 code units: sessionStorage is
 *  shared with the host page (quota ~5 MB), so a bigger hold is dropped. */
const OUTBOX_MAX_CHARS = 1_000_000;

interface Outbox {
  sid: string;
  batches: CarriedBatch[];
}

/** Read and always remove the outbox: it is for the very next page load. */
function takeOutbox(key: string): Outbox | null {
  const o = readOutbox(key);
  try {
    sessionStorage.removeItem(key);
  } catch {
    /* storage blocked: nothing was read either */
  }
  return o;
}

/** Read the outbox and leave it in place. */
function readOutbox(key: string): Outbox | null {
  try {
    const raw = sessionStorage.getItem(key);
    if (raw === null) return null;
    const o = JSON.parse(raw) as Partial<Outbox>;
    if (typeof o.sid !== "string" || !Array.isArray(o.batches)) return null;
    const batches = o.batches.filter(
      (b): b is CarriedBatch =>
        !!b &&
        typeof b.segmentId === "string" &&
        Array.isArray(b.events) &&
        b.events.length > 0 &&
        (b.page === undefined || (typeof b.page === "object" && b.page !== null)) &&
        (b.sequence === undefined ||
          (Number.isInteger(b.sequence) && b.sequence > 0 && b.sequence <= MAX_SEQUENCE)) &&
        (b.hooked === undefined || typeof b.hooked === "boolean") &&
        (b.rules === undefined || (typeof b.rules === "object" && b.rules !== null)),
    );
    return { sid: o.sid, batches };
  } catch {
    return null;
  }
}

/** Event types the hide/unload batch keeps first: small and what the session's
 *  end, errors, page views and custom events depend on. */
const FINAL_PRIORITY_TYPES = new Set<string>([
  "session_end",
  "session_start",
  "error",
  "navigation",
  "custom",
  "viewport",
]);

/** rrweb's stream: the full snapshot and every event applied on top of it. */
const isReplayEvent = (e: ReplayEvent) =>
  e.type === "full_snapshot" || e.type === "incremental_snapshot";

/**
 * Pick which buffered events the hide/unload batch carries within `room`
 * bytes (exact UTF-8 cost of each event plus its separator), in three passes:
 *  1. FINAL_PRIORITY_TYPES, newest first, so a big backlog can't crowd out the
 *     session's end or its errors;
 *  2. the replay stream (full/incremental snapshots), oldest first and without
 *     gaps — each incremental is a diff on the ones before it, so the run stops
 *     at the first one that doesn't fit;
 *  3. everything else (console, network, performance…), oldest first.
 * Returns a flag per event; the batch keeps the original order.
 */
function selectForFinalBatch(events: ReplayEvent[], room: number): boolean[] {
  const take = new Array<boolean>(events.length).fill(false);
  let left = room;
  const tryTake = (i: number): boolean => {
    const cost = utf8Bytes(JSON.stringify(events[i])) + 1;
    if (cost > left) return false;
    take[i] = true;
    left -= cost;
    return true;
  };
  for (let i = events.length - 1; i >= 0; i -= 1) {
    if (FINAL_PRIORITY_TYPES.has(events[i].type)) tryTake(i);
  }
  for (let i = 0; i < events.length; i += 1) {
    if (isReplayEvent(events[i]) && !tryTake(i)) break;
  }
  for (let i = 0; i < events.length && left > 256; i += 1) {
    const e = events[i];
    if (!take[i] && !isReplayEvent(e) && !FINAL_PRIORITY_TYPES.has(e.type)) tryTake(i);
  }
  return take;
}

/** Paces regular uploads: at most one send in flight, an exponential backoff
 *  (jittered, capped at 60s) after transient failures, and a halt once three
 *  batches in a row came back unusable or the server said to stop. */
export interface UploadGate {
  /** False while a send is in flight, or during a backoff unless
   *  `ignoreBackoff` (stop() delivering its last batch). */
  canSend(ignoreBackoff?: boolean): boolean;
  begin(): void;
  /** Record a finished send. Returns "halt" when uploads should stop for the
   *  rest of this page load. */
  end(outcome: SendOutcome): "halt" | undefined;
}

export function createUploadGate(
  intervalMs: number,
  now: () => number = Date.now,
  rand: () => number = Math.random,
): UploadGate {
  let inFlight = false;
  let failures = 0;
  let drops = 0;
  let retryAt = 0;
  return {
    canSend: (ignoreBackoff) =>
      !inFlight && (ignoreBackoff === true || now() >= retryAt),
    begin: () => {
      inFlight = true;
    },
    end: (outcome) => {
      inFlight = false;
      switch (outcome.kind) {
        case "ok":
          failures = 0;
          drops = 0;
          retryAt = 0;
          return undefined;
        case "retry":
          failures += 1;
          retryAt =
            now() +
            Math.min(60_000, intervalMs * 2 ** failures) * (0.5 + rand() / 2);
          return undefined;
        case "drop":
          failures = 0;
          retryAt = 0;
          drops += 1;
          return drops >= 3 ? "halt" : undefined;
        case "stop":
          return "halt";
      }
    },
  };
}

function safeTimezone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
}

function pageContext(
  maskTitle?: (title: string) => string,
): ReplayBatchEnvelope["page"] {
  return {
    // Credential-style query keys (token, jwt, password, …) are masked before
    // they reach storage, the same as in session_start and navigation events.
    url: redactUrlForStorage(window.location.href),
    // Masked like the replay's <title> text, when the caller gives a masker.
    title: maskTitle ? maskTitle(document.title) : document.title,
    referrer: redactUrlForStorage(document.referrer),
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

/** Hard cap on held events — carried batches and the buffer together — so a
 *  sustained ingest outage (every send failing and re-queuing) can't grow them
 *  without bound. A few MB of rrweb. */
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

/** True when `id` holds a character the ingest rejects in an id: a C0 control
 *  (incl. NUL), DEL, or a lone UTF-16 surrogate. A char-code scan, not a regex:
 *  the lookbehind a regex needs for lone low surrogates is a syntax error in
 *  Safari before 16.4, which would stop the whole bundle from loading there. */
function hasInvalidIdChar(id: string): boolean {
  for (let i = 0; i < id.length; i += 1) {
    const c = id.charCodeAt(i);
    if (c <= 0x1f || c === 0x7f) return true;
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = i + 1 < id.length ? id.charCodeAt(i + 1) : 0;
      if (next < 0xdc00 || next > 0xdfff) return true;
      i += 1; // a valid pair: skip its low half
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return true;
    }
  }
  return false;
}

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
    !hasInvalidIdChar(id)
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

export interface SessionRuntimeOptions {
  /** Masks document.title before it goes into a batch's page context. */
  maskTitle?: (title: string) => string;
  /** The privacy rules the buffered events are recorded under, kept with them
   *  when they leave the buffer for `carried` or the outbox
   *  (CarriedBatch.rules). */
  privacyTag?: () => Record<string, unknown> | undefined;
}

export function createSessionRuntime(
  config: WebReplayConfig,
  options: SessionRuntimeOptions = {},
): SessionRuntime {
  const now = Date.now();
  const page = () => pageContext(options.maskTitle);
  // The buffer as one carried batch of this page load's segment.
  const bufferBatch = (events: ReplayEvent[]): CarriedBatch => {
    const rules = options.privacyTag?.();
    return { segmentId, events, page: page(), ...(rules ? { rules } : {}) };
  };
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
  let generation = 0;
  const buffer: ReplayEvent[] = [];
  // A previous page load of this session held events back for us.
  const stashKey = outboxKey(config);
  const outbox = takeOutbox(stashKey);
  const carried: CarriedBatch[] =
    outbox && outbox.sid === sessionId && (resumed || !!hostSessionId)
      ? outbox.batches
      : [];
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
  // Carried batches whose regular send failed, waiting for their retry
  // (requeue), and those of them already sent on a tab switch (flushFinal).
  // By identity: nothing is kept alive or stashed in the outbox for them.
  const failedSends = new WeakSet<CarriedBatch>();
  const sentOnHide = new WeakSet<CarriedBatch>();

  // Bound memory during a sustained outage, while a failed batch waits in
  // `carried` and new events pile up in the buffer behind it: keep the OLDEST
  // MAX_BUFFERED_EVENTS events (carried batches in order, then the buffer) and
  // drop the newest beyond the cap — the rrweb FullSnapshot lives in the oldest
  // and losing it makes the whole recording unplayable. The first carried batch
  // is always kept whole, even past the cap: it holds that base, and it is the
  // one being resent under its number.
  const boundBacklog = () => {
    let room = MAX_BUFFERED_EVENTS;
    for (let i = 0; i < carried.length; i += 1) {
      const c = carried[i];
      if (i > 0 && c.events.length > room) {
        // Keep this batch's oldest events if any room is left — unless it was
        // sent once: its number may already be stored with all its events,
        // and a resend under it must be that same batch, so it is dropped
        // whole. Every newer batch is dropped.
        const cut = room > 0 && c.sequence === undefined;
        if (cut) carried[i] = { ...c, events: c.events.slice(0, room) };
        carried.length = cut ? i + 1 : i;
        room = 0;
        break;
      }
      room -= c.events.length;
    }
    if (buffer.length > Math.max(0, room)) buffer.length = Math.max(0, room);
  };

  // Prepend un-sent (older) events ahead of anything captured since, preserving
  // order — without spreading a possibly-large array into unshift() (which can
  // overflow the call stack). Bounded with the carried batches (boundBacklog).
  const requeueFront = (events: ReplayEvent[]) => {
    if (events.length === 0) return;
    const tail = buffer.splice(0, buffer.length);
    for (let i = 0; i < events.length; i += 1) buffer.push(events[i]);
    for (let i = 0; i < tail.length; i += 1) buffer.push(tail[i]);
    boundBacklog();
  };

  const sdk: ReplaySdkDescriptor = {
    name: config.sdk?.name ?? SDK_NAME,
    version: config.sdk?.version ?? SDK_VERSION,
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
    // start, and the emit() reads must see the updated value.
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
      // A send of the ended session still in flight that fails later is dropped
      // too (generation), not requeued into the new session.
      buffer.length = 0;
      carried.length = 0;
      generation += 1;
      writePersistedSession({ sid: sessionId, st: startedAt, la: startedAt });
    },
    sdk,
    makeEventId: () => globalThis.crypto.randomUUID(),
    push: (event) => {
      buffer.push(event);
    },
    drain: () => buffer.splice(0, buffer.length),
    get generation() {
      return generation;
    },
    requeue: (batch, gen) => {
      if (gen !== generation) return false;
      // At the front: one send is in flight at a time and carried batches go
      // before the buffer, so the failed batch is older than anything carried
      // since (a back/forward-cache restore's leftovers, another page's outbox).
      carried.unshift(batch);
      failedSends.add(batch);
      boundBacklog();
      return true;
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
    pageContext: page,
    startAutoFlush: (flush) => {
      const flushIntervalMs = config.flushIntervalMs ?? 3000;
      timer = window.setInterval(() => {
        void flush();
      }, flushIntervalMs);
    },
    stopAutoFlush: () => {
      if (timer !== undefined) window.clearInterval(timer);
    },
    flushFinal: (sendFinal, roomFor, withCarried) => {
      // A carried batch's envelope, under its own segment and page, measured
      // with the widest number (the real one is set on send).
      const shellFor = (c: CarriedBatch): ReplayBatchEnvelope => ({
        projectId: config.projectId,
        sessionId,
        segmentId: c.segmentId,
        sequence: MAX_SEQUENCE,
        sentAt: Date.now(),
        sdk,
        page: c.page ?? page(),
        events: [],
      });
      // Send one carried batch whole, if it still leaves FINAL_TAIL_ROOM_BYTES
      // for the tail. False when not sent.
      const sendCarried = (c: CarriedBatch): boolean => {
        const shell = shellFor(c);
        let size = 0;
        for (let i = 0; i < c.events.length; i += 1) {
          size += utf8Bytes(JSON.stringify(c.events[i])) + 1;
        }
        if (size > roomFor(shell) - FINAL_TAIL_ROOM_BYTES) return false;
        const sequence = c.sequence ?? claimSequence();
        return sendFinal({ ...shell, sequence, events: c.events }, c.hooked === true);
      };
      // The oldest carried batch is a failed send too big to go whole: its
      // priority events (the errors, custom events and page views 0.1.18 sent
      // from the buffer here) go on their own, newest first within the room,
      // and leave it; it keeps its number for the rest (its replay stream).
      // Under a NEW number: a part under the batch's own would be deduped
      // against the whole batch, or overwrite it. The cost: if an earlier
      // attempt did land, those few events are stored twice — never its rrweb
      // diffs, which a duplicate breaks.
      const sendPriorityPart = () => {
        const c = carried[0];
        const priority = c.events.filter((e) => FINAL_PRIORITY_TYPES.has(e.type));
        if (priority.length === 0) return;
        const shell = shellFor(c);
        const take = selectForFinalBatch(priority, roomFor(shell) - FINAL_TAIL_ROOM_BYTES);
        const part = priority.filter((_, i) => take[i]);
        if (part.length === 0) return;
        const sequence = claimSequence();
        if (!sendFinal({ ...shell, sequence, events: part }, c.hooked === true)) return;
        const sent = new Set(part);
        const rest = c.events.filter((e) => !sent.has(e));
        if (rest.length === 0) {
          carried.shift();
          return;
        }
        const kept: CarriedBatch = { ...c, events: rest };
        carried[0] = kept;
        failedSends.add(kept);
        if (sentOnHide.has(c)) sentOnHide.add(kept);
      };
      // Going away: the oldest first, each leaving memory once sent.
      while (withCarried && carried.length > 0 && sendCarried(carried[0])) {
        carried.shift();
      }
      const held = carried[0];
      if (held !== undefined && failedSends.has(held)) {
        if (withCarried) {
          sendPriorityPart();
        } else if (!sentOnHide.has(held)) {
          // A tab switch leaves carried batches to the regular flush, which
          // retries and sees the answer. But a hidden page can be discarded
          // with no further event, so a failed send waiting for its retry
          // also goes now: a copy under its number that stays carried (the
          // server can dedupe it against the retry), or its priority part.
          // Once per failed send, however often the tab is switched during
          // its backoff: each copy is one more resend under that number.
          sentOnHide.add(held);
          if (!sendCarried(held)) sendPriorityPart();
        }
      }
      if (buffer.length === 0) return;
      const events = buffer.splice(0, buffer.length);
      const shell: ReplayBatchEnvelope = {
        projectId: config.projectId,
        sessionId,
        segmentId,
        // Measured with the widest number; the real one is claimed on send.
        sequence: MAX_SEQUENCE,
        sentAt: Date.now(),
        sdk,
        page: page(),
        events: [],
      };
      // A batch that didn't go out (beforeSend made it bigger than the room, or
      // the browser refused the beacon) is retried smaller, so the session end
      // and errors (selected first) still leave. One sequence number for all
      // tries: only one of them can be sent.
      let room = roomFor(shell);
      let sequenceForTry: number | undefined;
      for (let attempt = 0; attempt < FINAL_BATCH_TRIES; attempt += 1) {
        const take = selectForFinalBatch(events, room);
        const chosen: ReplayEvent[] = [];
        const rest: ReplayEvent[] = [];
        for (let i = 0; i < events.length; i += 1) {
          (take[i] ? chosen : rest).push(events[i]);
        }
        if (chosen.length === 0) break;
        sequenceForTry ??= claimSequence();
        if (sendFinal({ ...shell, sequence: sequenceForTry, events: chosen }, false)) {
          requeueFront(rest);
          return;
        }
        room = Math.floor(room / 2);
      }
      requeueFront(events);
    },
    carried,
    carryUnsent: (envelopes, about) => {
      // The transport holds what it sent: after beforeSend, if one ran.
      const mine = envelopes
        .filter((e) => e.sessionId === sessionId && e.events.length > 0)
        .map((e): CarriedBatch => {
          const known = about?.(e) ?? {};
          return {
            segmentId: e.segmentId,
            events: e.events,
            page: e.page,
            sequence: e.sequence,
            ...(known.hooked ? { hooked: true } : {}),
            ...(known.rules ? { rules: known.rules } : {}),
          };
        });
      carried.unshift(...mine);
    },
    stashForNextPage: (carriedOnly) => {
      const own: CarriedBatch | null =
        !carriedOnly && buffer.length > 0 ? bufferBatch(buffer.slice()) : null;
      const mine = own ? [...carried, own] : carried.slice();
      if (mine.length === 0) return false;
      // An outbox of this session already there (this page's own stash at
      // pagehide, then a stop() from the app's pagehide handler) keeps its
      // batches, ahead: they are older.
      const prior = readOutbox(stashKey);
      const candidates = prior && prior.sid === sessionId ? [...prior.batches, ...mine] : mine;
      // Oldest first; a batch that would push the outbox past its cap is left
      // out (and stays in memory) without costing the ones that fit. The
      // buffer's events then go without their replay stream (a big snapshot,
      // most of the time): the session start, page views and errors still
      // reach the next page load.
      const kept: CarriedBatch[] = [];
      let ownKept: CarriedBatch | null = null;
      let size = 64 + sessionId.length;
      for (const b of candidates) {
        let batch = b;
        let n = JSON.stringify(batch).length + 1;
        if (size + n > OUTBOX_MAX_CHARS && batch === own) {
          const rest = own.events.filter((e) => !isReplayEvent(e));
          batch = { ...own, events: rest };
          n = rest.length > 0 ? JSON.stringify(batch).length + 1 : Infinity;
        }
        if (size + n > OUTBOX_MAX_CHARS) continue;
        kept.push(batch);
        if (b === own) ownKept = batch;
        size += n;
      }
      // Nothing of this page's fits: the outbox stays as it is.
      if (!kept.some((b) => b === ownKept || mine.indexOf(b) !== -1)) return false;
      try {
        sessionStorage.setItem(
          stashKey,
          JSON.stringify({ sid: sessionId, batches: kept } satisfies Outbox),
        );
      } catch {
        // Storage full or blocked: everything stays in memory, so a page
        // restored from the back/forward cache still sends it.
        return false;
      }
      // Written: what went into the outbox leaves memory (the next page load,
      // or this page once restored, takes it back from there).
      const keptSet = new Set(kept);
      const remaining = carried.filter((c) => !keptSet.has(c));
      carried.length = 0;
      carried.push(...remaining);
      if (ownKept === own && own) {
        buffer.splice(0, own.events.length);
      } else if (ownKept) {
        // Only the replay stream stays, in order.
        const stashed = new Set(ownKept.events);
        const left = buffer.splice(0, buffer.length);
        for (let i = 0; i < left.length; i += 1) {
          if (!stashed.has(left[i])) buffer.push(left[i]);
        }
      }
      return true;
    },
    restoreFromBfcache: () => {
      const t = Date.now();
      const before = sessionId;
      let continued = true;
      if (!hostSessionId) {
        // Another page in this tab may have refreshed the activity marker or
        // rotated the session while this one sat in the cache.
        const prior = readPersistedSession();
        const la = prior
          ? Math.max(prior.la, prior.sid === sessionId ? lastActivityAt : 0)
          : lastActivityAt;
        if (t - la < inactivityMs) {
          if (prior && prior.sid !== sessionId) {
            sessionId = prior.sid;
            startedAt = prior.st;
            generation += 1;
            carried.length = 0;
          }
        } else {
          sessionId = shortId("ses_");
          startedAt = t;
          generation += 1;
          carried.length = 0;
          continued = false;
        }
      }
      // Events a page shown in between left for this session, this page's own
      // stash from its pagehide among them.
      const outbox = takeOutbox(stashKey);
      if (outbox && outbox.sid === sessionId) carried.push(...outbox.batches);
      // Events still buffered from before the freeze (not sent yet: held by the
      // upload gate, past the unload budget, or recorded after the stash at
      // pagehide) belong to the OLD segment: send them under it, after that
      // segment's stashed events, which are older. If the session changed they
      // belong to an ended one and are dropped, like rotate() does.
      if (sessionId === before && buffer.length > 0) {
        carried.push(bufferBatch(buffer.splice(0, buffer.length)));
      }
      buffer.length = 0;
      segmentId = shortId("seg_");
      lastActivityAt = t;
      lastActivityPersist = t;
      writePersistedSession({ sid: sessionId, st: startedAt, la: t });
      return continued;
    },
    adoptOutbox: () => {
      const outbox = readOutbox(stashKey);
      if (!outbox || outbox.sid !== sessionId) return;
      takeOutbox(stashKey);
      carried.push(...outbox.batches);
      boundBacklog();
    },
  };
}
