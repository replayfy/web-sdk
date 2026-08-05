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
  nextSequence: () => number;
  pageContext: () => ReplayBatchEnvelope["page"];
  startAutoFlush: (flush: () => Promise<void>) => void;
  stopAutoFlush: () => void;
  flushWithBeacon: (
    sendBatch: (
      envelope: ReplayBatchEnvelope,
      useBeacon?: boolean,
    ) => Promise<void>,
  ) => void;
}

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

function shortId(prefix: string): string {
  const bytes = new Uint8Array(7);
  globalThis.crypto.getRandomValues(bytes);
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(
    "",
  );
  return `${prefix}${hex}`;
}

/** Hard cap on buffered events so a sustained ingest outage (every flush failing
 *  and re-queuing) can't grow the buffer without bound. A few MB of rrweb. */
const MAX_BUFFERED_EVENTS = 20000;

/** Where a session's identity lives BETWEEN page loads. sessionStorage is
 *  per-tab: it survives a reload/same-tab navigation but is cleared when the tab
 *  closes — so a reload CONTINUES the session while a brand-new tab starts a
 *  fresh one. That's the reference tracker's per-tab continuation model, minus
 *  its bespoke token format. */
const SESSION_STORAGE_KEY = "replay:ses";

/** Default inactivity window: a reload only continues the session if the last
 *  user interaction was within this long. 30 min is the session-analytics norm.
 *  Overridable via config.sessionInactivityMs. */
const DEFAULT_INACTIVITY_MS = 30 * 60 * 1000;

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

function readPersistedSession(): PersistedSession | null {
  try {
    const raw = sessionStorage.getItem(SESSION_STORAGE_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as Partial<PersistedSession>;
    if (
      typeof p.sid === "string" &&
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

export function createSessionRuntime(config: WebReplayConfig): SessionRuntime {
  const now = Date.now();
  const inactivityMs = config.sessionInactivityMs ?? DEFAULT_INACTIVITY_MS;

  // Decide this page load's session identity:
  //   1. an explicit config.sessionId always wins (host-controlled).
  //   2. otherwise resume the tab's stored session if the last USER interaction
  //      was within the inactivity window (reload / same-tab back-forward) —
  //      reusing its original startedAt so offsets stay monotonic across loads.
  //   3. otherwise mint a fresh session.
  let sessionId: string;
  let startedAt: number;
  let lastActivityAt: number;
  let resumed = false;
  if (config.sessionId) {
    sessionId = config.sessionId;
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

  const segmentId = shortId("seg_");
  const buffer: ReplayEvent[] = [];
  let sequence = 0;
  let timer: number | undefined;
  let lastActivityPersist = now;

  const sdk: ReplaySdkDescriptor = {
    name: config.sdk?.name ?? "@replay/web-sdk",
    version: config.sdk?.version ?? "0.1.0",
    platform: config.sdk?.platform ?? "web",
    ...(config.revId ? { revId: config.revId } : {}),
  };

  return {
    sessionId,
    segmentId,
    startedAt,
    resumed,
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
    nextSequence: () => {
      sequence += 1;
      return sequence;
    },
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
    flushWithBeacon: (sendBatch) => {
      const events = buffer.splice(0, buffer.length);
      if (events.length === 0) return;
      void sendBatch(
        {
          projectId: config.projectId,
          sessionId,
          segmentId,
          sequence: sequence + 1,
          sentAt: Date.now(),
          sdk,
          page: pageContext(),
          events,
        },
        true,
      );
    },
  };
}
