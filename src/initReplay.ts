import {
  type ConsoleEventData,
  type ErrorEventData,
  type NavigationEventData,
  type NetworkEventData,
  type ReplayBatchEnvelope,
  type ReplayEvent,
  type SessionEndEventData,
  type SessionStartEventData,
  type SnapshotEventData,
  type ViewportEventData,
} from "./schema";
import { record, addCustomEvent } from "rrweb";
import type { eventWithTime } from "rrweb";
import {
  createBatchSender,
  type IdentifyPayload,
  type SendOutcome,
} from "./transport";
import { createSessionRuntime, createUploadGate } from "./runtime";
import {
  createConsoleCapture,
  createErrorCapture,
  createNavigationCapture,
  createNetworkCapture,
  createPerformanceCapture,
  createRageDeadClickCapture,
  createViewportCapture,
  errorDataFromValue,
} from "./signals";
import { fetchRemoteConfig } from "./remote-config";
import {
  ALL_INPUT_TYPES,
  createTextMasker,
  selectorEntries,
  validSelector,
  type TextMasker,
} from "./text-mask";
import { getBrowserFingerprint, setStoredFingerprint } from "./fingerprint";
import {
  applyBeforeSend,
  applyBeforeSendToCopy,
  compileRedactPatterns,
  recheckBeforeSend,
  redactUrlForStorage,
  dashboardHostFromApiHost,
  truncate,
} from "./utils";
import type { ReplayController, WebReplayConfig } from "./types";

interface CaptureSlot {
  stop: () => void;
}

export function initReplay(config: WebReplayConfig): ReplayController {
  if (typeof window === "undefined" || typeof document === "undefined") {
    throw new Error("initReplay must run in a browser context");
  }

  // Honor Do-Not-Track when the customer opts in: install NOTHING and return an
  // inert controller, so no data is captured or sent.
  if (config.respectDoNotTrack) {
    const dnt =
      navigator.doNotTrack === "1" ||
      (window as unknown as { doNotTrack?: string }).doNotTrack === "1" ||
      (navigator as unknown as { msDoNotTrack?: string }).msDoNotTrack === "1";
    if (dnt) {
      const noop = () => {};
      return {
        sessionId: "",
        flush: async () => {},
        identify: noop,
        track: noop,
        captureException: noop,
        setAnonymousId: noop,
        setMetadata: noop,
        stop: async () => {},
        urlForCurrentSession: () => null,
      };
    }
  }

  // Each invalid selector is reported once per page, however often the
  // recorder is (re)installed.
  const warnedSelectors = new Set<string>();
  const warnSelectors = (bad: string[], what: string) => {
    const fresh = bad.filter((s) => !warnedSelectors.has(s));
    if (fresh.length === 0) return;
    for (const s of fresh) warnedSelectors.add(s);
    // eslint-disable-next-line no-console
    console.warn(`[replay-sdk] ${what}:`, fresh);
  };
  const warnMaskSelectors = (bad: string[]) =>
    warnSelectors(bad, "invalid mask selector(s), treating the whole page as private");

  // The last dashboard privacy rules seen for this ingest host + key, kept so a
  // page whose remote config is slower than the 300ms race still records its
  // first snapshot with them (they can only add masking). Per-browser
  // localStorage; any failure just means no cached rules.
  const privacyCacheKey = (() => {
    const owner = `${config.apiHost}|${config.apiKey}`;
    let h = 5381;
    for (let i = 0; i < owner.length; i += 1) h = ((h * 33) ^ owner.charCodeAt(i)) >>> 0;
    return `replay:privacy:${h.toString(36)}`;
  })();
  type CachedPrivacy = {
    forceMaskAllInputs: boolean;
    maskSelectors: string[];
    blockSelectors: string[];
    maskInputTypes: string[];
  };
  const strings = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : [];
  const readCachedPrivacy = (): CachedPrivacy | null => {
    try {
      const raw = localStorage.getItem(privacyCacheKey);
      if (!raw) return null;
      const p = JSON.parse(raw) as Record<string, unknown>;
      return {
        forceMaskAllInputs: p.forceMaskAllInputs === true,
        maskSelectors: strings(p.maskSelectors),
        blockSelectors: strings(p.blockSelectors),
        maskInputTypes: strings(p.maskInputTypes),
      };
    } catch {
      return null;
    }
  };
  const writeCachedPrivacy = (p: CachedPrivacy) => {
    try {
      localStorage.setItem(privacyCacheKey, JSON.stringify(p));
    } catch {
      /* storage blocked or full — the next page just races without it */
    }
  };

  // The masker rrweb's text/input hooks, the event post-pass, the click labels
  // and the page titles use. Built from the host config and the cached
  // dashboard selectors now, so the captures installed before rrweb (phase 1)
  // already mask what they send; replaced each time rrweb is (re)installed
  // with the merged privacy settings.
  let activeTextMasker: TextMasker = createTextMasker({
    maskSelectors: [config.maskTextSelector, ...(readCachedPrivacy()?.maskSelectors ?? [])],
    maskEmails: config.maskTextEmails !== false,
    maskNumbers: config.maskTextNumbers === true,
    rootDoc: document,
    warn: warnMaskSelectors,
  });

  const session = createSessionRuntime(config, {
    maskTitle: (t) => activeTextMasker.titleFor(t),
  });
  const sendBatch = createBatchSender(config);
  const { fp: fingerprint } = getBrowserFingerprint();
  sendBatch.setFingerprint(fingerprint);
  // Bind identity to THIS session: re-attach a persisted identify() only when the
  // same session resumed (reload); a fresh/rolled-over session starts anonymous.
  // Must run BEFORE the config/runtime identify() below so they replace/merge
  // over the correct base rather than a stale prior-session identity.
  sendBatch.bindSession(session.sessionId, session.resumed);
  const captures: Record<string, CaptureSlot | null> = {
    console: null,
    network: null,
    errors: null,
    navigation: null,
    viewport: null,
    rrweb: null,
  };
  let sampled = true;
  // The workspace has spent its plan's session allowance (remote shouldNotRecord).
  // A HARD gate, separate from `sampled`, because the always-record overrides
  // below flip `sampled` back on for errors/identified users — and a maxed plan
  // must not record even those. Nothing flips this back within a page load.
  let blocked = false;

  // Visibility gate + snapshot-ordering flags. Following the reference tracker:
  // defer the ENTIRE session start until the tab is first VISIBLE (never record a
  // hidden / prerendered tab), and only let a batch ship once the session's DOM
  // snapshot exists — so a batch never creates a server-side session before its
  // full_snapshot is in it.
  //  - `started`      : the visibility-gated start has run (tab was/became visible).
  //  - `snapshotReady`: rrweb's first full_snapshot has been buffered.
  //  - `rrwebFailed`  : record() threw, so no snapshot will ever arrive.
  // flush()/shipTail() ship nothing until `started && (snapshotReady ||
  // rrwebFailed)`. Net effect: a tab that loads hidden and is closed while still
  // hidden creates NO session, and a started session's first batch always carries
  // the snapshot (or rrweb is known-failed and the no-replay session ships for the
  // backend to keep-if-analytics / reap-if-empty).
  let started = false;
  let snapshotReady = false;
  let rrwebFailed = false;
  // ── Inactivity end + session rotation ──────────────────────────────────────
  // `idle` = the session was ENDED after sessionInactivityMs with no MEANINGFUL
  // activity (interaction / navigation / track — not background network/perf/
  // heartbeat). While idle, emit() drops everything so a page that keeps polling
  // its API can't extend a session nobody is in. The next meaningful activity
  // rotates to a fresh session. `lastMeaningfulAt` is only bumped by markMeaningful().
  let idle = false;
  let lastMeaningfulAt = Date.now();
  let idleTimer: number | undefined;
  // stop() ran: nothing is captured or sent any more.
  let stopped = false;
  // stop() began (it is delivering its last batches): nothing may start or
  // re-install a capture any more — not a first-visible start, not a late
  // remote config.
  let stopping = false;
  // The deferred start of a tab that loaded hidden, until it first shows.
  let onFirstVisible: (() => void) | undefined;
  let stopRun: Promise<void> | undefined;
  // The session a session_end was already emitted for, so it is sent at most
  // once per session per page, whichever path ends it (unload, inactivity,
  // stop()). Cleared when a back/forward-cache restore continues the session.
  let endedSessionId: string | null = null;
  // pagehide ran: the page is going away (or into the back/forward cache).
  let unloading = false;
  // The page went into the back/forward cache after the session started.
  let inBfcache = false;
  // Regular uploads: one in flight at a time, backoff after failures, halt when
  // the server says nothing from this page will be accepted.
  const gate = createUploadGate(config.flushIntervalMs ?? 3000);
  let inFlightSend: Promise<void> | null = null;
  // Regular sends whose events are a beforeSend hook's output (see
  // CarriedBatch.hooked), so an upload carried on at pagehide keeps the flag.
  const hookedEnvelopes = new WeakSet<ReplayBatchEnvelope>();

  if (config.distinctId)
    sendBatch.setIdentify({ distinctId: config.distinctId });

  const emit = <TData>(
    event: Omit<ReplayEvent<TData>, "id" | "offsetMs" | "source">,
  ) => {
    // Session was ended for inactivity and nobody's back yet — drop everything
    // (background network/perf/console/heartbeat) so it can't extend a dead
    // session. resumeFromIdle() clears `idle` before re-emitting into the fresh one.
    // Also nothing once uploads are blocked/halted or stop() ran: it would only
    // grow a buffer that is never sent.
    if (idle || blocked || stopped) return;
    session.push({
      id: session.makeEventId(),
      // Clamp to >= 0. Some events timestamp themselves off performance
      // timeOrigin (paint timing, web vitals via PerformanceObserver), which
      // can predate session.startedAt when the SDK initialises after the page
      // has already loaded — yielding a negative offset. The server's
      // offset_ms column is an unsigned int, so a single negative offset
      // rejects the whole batch insert and silently drops those events.
      offsetMs: Math.max(0, event.ts - session.startedAt),
      source: session.sdk.platform,
      ...event,
    });
  };

  // Console sink. One capture, two destinations:
  //   1. our `type: "console"` event → the queryable session_events
  //      store the AI reads (full serialized args live here).
  //   2. a compact marker teed into the rrweb stream via addCustomEvent
  //      so the player can render console frame-aligned with the DOM.
  // We ship only level+message into rrweb (not the heavy args) to avoid
  // duplicating the full payload, and only while rrweb is recording —
  // addCustomEvent throws if no recording is active.
  const emitConsole = (d: ConsoleEventData) => {
    emit({ ts: Date.now(), type: "console", data: d });
    if (captures.rrweb) {
      try {
        addCustomEvent("console", { level: d.level, message: d.message });
      } catch {
        /* rrweb not recording / plugin unavailable — skip the tee */
      }
    }
  };

  const emitSessionStart = () => {
    const data: SessionStartEventData = {
      // Scrub credentials (jwt/token/password/reset-password/…) out of the entry
      // URL + referrer before they're stored — magic-link / OAuth / reset flows
      // routinely carry them in the query string. Fires before remote config, so
      // only the always-on default key scrub applies here (the critical case).
      href: redactUrlForStorage(window.location.href),
      path: window.location.pathname,
      referrer: redactUrlForStorage(document.referrer),
      // Masked like the replay's <title> text (emails, digits if asked).
      title: activeTextMasker.titleFor(document.title) || undefined,
    };
    emit({ ts: Date.now(), type: "session_start", data });
  };

  // Last time rrweb emitted ANYTHING (full or incremental). Drives the
  // idle-aware heartbeat: on a busy page rrweb is already streaming, so the
  // forced 30s full snapshot is pure overhead — we only force one once the page
  // has gone quiet (where the stream would otherwise end and a mid-join viewer
  // would have no base).
  let lastRrwebActivityAt = Date.now();
  const emitSnapshot = (rrwebEvent: eventWithTime) => {
    // Privacy edits rrweb has no hook for (shadow-root text, href/meta, input
    // values, private media, blocked iframes, select state), while its mirror
    // still matches the page. An event with nothing left to record is dropped.
    if (
      !activeTextMasker.postProcess(
        rrwebEvent,
        (record as unknown as { mirror?: unknown }).mirror,
      )
    )
      return;
    lastRrwebActivityAt = Date.now();
    // The session becomes shippable the moment its first FULL snapshot (type 2)
    // is buffered — every later incremental is a diff against it, so a batch sent
    // before this would create an unplayable "no replay" session server-side.
    if (rrwebEvent.type === 2) snapshotReady = true;
    const data: SnapshotEventData = { recorder: "rrweb", rrwebEvent };
    emit({
      ts: rrwebEvent.timestamp,
      type: rrwebEvent.type === 2 ? "full_snapshot" : "incremental_snapshot",
      data,
    });
    // Ship a full snapshot (initial, heartbeat, checkout) soon rather than on
    // the next tick: a big one still buffered when the page goes away rarely
    // fits the unload batch, and the replay after it needs it as its base.
    // Deferred so rrweb finishes emitting synchronously first.
    if (rrwebEvent.type === 2 && started) setTimeout(scheduleFlush, 0);
  };

  const emitViewport = () => {
    const data: ViewportEventData = {
      width: window.innerWidth,
      height: window.innerHeight,
    };
    emit({ ts: Date.now(), type: "viewport", data });
  };

  const emitSessionEnd = (reason: SessionEndEventData["reason"]) => {
    if (endedSessionId === session.sessionId) return;
    endedSessionId = session.sessionId;
    emit({ ts: Date.now(), type: "session_end", data: { reason } });
  };

  // A sampled-out session was switched back on (always-record errors /
  // identified users). Its buffered base snapshot was discarded while it was
  // off, so take a fresh one now — otherwise the replay has nothing to apply
  // the next diffs to until the 30s heartbeat or the 2-minute checkout.
  const turnSamplingOn = () => {
    if (sampled || blocked) return;
    sampled = true;
    if (captures.rrweb) {
      try {
        record.takeFullSnapshot(true);
      } catch {
        /* recorder inactive — the heartbeat/checkout will provide the base */
      }
    }
  };

  const flush = async (opts?: { ignoreBackoff?: boolean }) => {
    if (stopped) return;
    if (!sampled || blocked) {
      session.drain();
      return;
    }
    // Visibility + snapshot gate: hold (keep buffering, don't ship) until the
    // gated start has run AND rrweb's snapshot is buffered (or rrweb is known to
    // have failed). This is what guarantees the first batch that creates the
    // server-side session carries the full_snapshot — never a snapshot-less "no
    // replay" row — and that a not-yet-visible tab ships nothing at all.
    if (!started || (!snapshotReady && !rrwebFailed)) return;
    // No minimum-duration hold here: the server judges a short session when it
    // settles (keeps it when identified or when it caught an error, deletes it
    // otherwise), and it can only do that with the events it was sent.
    // One send at a time (keeps batches in order; a failed one is requeued in
    // front) and none during a backoff. The events stay buffered; no sequence
    // number is claimed until a batch is actually built.
    if (!gate.canSend(opts?.ignoreBackoff)) return;
    const generation = session.generation;
    // Carried batches go first, each under its own segment: a failed send
    // being retried, or what an earlier page load of this session held back.
    const carried = session.carried.shift();
    const events = carried ? carried.events : session.drain();
    if (events.length === 0) return;
    const envelope: ReplayBatchEnvelope = {
      projectId: config.projectId,
      sessionId: session.sessionId,
      segmentId: carried ? carried.segmentId : session.segmentId,
      // A batch sent before (a failed send, an upload the previous page left
      // unfinished) keeps its number.
      sequence: carried?.sequence ?? session.nextSequence(),
      sentAt: Date.now(),
      sdk: session.sdk,
      // A carried batch keeps the page it was recorded on (entry page, UTM).
      page: carried?.page ?? session.pageContext(),
      events,
    };
    // A batch that already went through the hook is resent as it went out;
    // the hook only decides whether it still may go.
    const nextEnvelope = carried?.hooked
      ? recheckBeforeSend(config.beforeSend, envelope)
      : applyBeforeSend(config.beforeSend, envelope);
    if (!nextEnvelope) return;
    const hooked = carried?.hooked === true || config.beforeSend !== undefined;
    if (hooked) hookedEnvelopes.add(nextEnvelope);
    gate.begin();
    const send = (async () => {
      let outcome: SendOutcome;
      try {
        outcome = await sendBatch(nextEnvelope);
      } catch {
        outcome = { kind: "retry" };
      }
      // Transient failure: keep the batch for the next flush (after the
      // backoff) rather than drop it — dropping the first batch loses the
      // rrweb FullSnapshot and makes the recording unplayable. It is kept
      // WHOLE, as it was sent (after beforeSend), and resent under the same
      // segment and sequence: an attempt may have reached the server with
      // only the response lost (a timeout, a proxy 504/524, a reset
      // connection), and the server can dedupe a resend under the same
      // number — under a new one it stores the events twice, and duplicate rrweb
      // incrementals can break the replay. Unless the session rotated
      // meanwhile: then the batch belongs to the ended session and is dropped
      // (requeue checks the generation). A batch the server refused
      // ("drop"/"stop") is never resent.
      if (outcome.kind === "retry") {
        session.requeue(
          {
            segmentId: nextEnvelope.segmentId,
            events: nextEnvelope.events,
            page: nextEnvelope.page,
            sequence: nextEnvelope.sequence,
            ...(hooked ? { hooked: true } : {}),
          },
          generation,
        );
      }
      if (gate.end(outcome) === "halt") {
        haltUploads(
          outcome.kind === "stop" ? outcome.reason : "batches rejected",
        );
      } else if (carried && outcome.kind === "ok") {
        // A carried batch went first: send the next one (or this page's own
        // events, its base snapshot among them) now, not a whole flush
        // interval later.
        void flush();
      }
    })();
    inFlightSend = send;
    try {
      await send;
    } finally {
      if (inFlightSend === send) inFlightSend = null;
    }
  };

  // Stop every capture (shared by stop() and haltUploads()).
  const stopCaptures = () => {
    for (const k of Object.keys(captures)) {
      const slot = captures[k];
      if (slot) {
        try {
          slot.stop();
        } catch {
          /* ignore */
        }
        captures[k] = null;
      }
    }
  };

  // The server said nothing this page sends will be accepted (bad or revoked
  // key, origin not allowed, workspace over its plan) or three batches in a
  // row were unusable. Stop for the rest of this page load, like the remote
  // config's shouldNotRecord: no captures, no uploads, nothing buffered.
  const haltUploads = (reason: string) => {
    if (blocked) return;
    blocked = true;
    sampled = false;
    session.stopAutoFlush();
    stopCaptures();
    session.drain();
    // eslint-disable-next-line no-console
    console.warn(`[replay-sdk] recording stopped for this page: ${reason}`);
  };

  const scheduleFlush = () => {
    void flush();
  };

  // End the current session because there's been no MEANINGFUL activity for
  // sessionInactivityMs. Ship its closing batch (with session_end), then gate
  // emit() so the page's background polling can't keep the dead session alive.
  const endForIdle = () => {
    if (idle || !started) return;
    emitSessionEnd("inactivity");
    void flush(); // drains synchronously into the send before we gate below
    idle = true;
  };

  // A user came back after an inactivity end → the return is a NEW session, not
  // a continuation. Rotate identity, re-open with session_start + a fresh rrweb
  // FullSnapshot (its base), and resume. Same anon/identified user (transport
  // identify/fingerprint state is untouched).
  const resumeFromIdle = () => {
    if (!idle || stopping) return;
    idle = false;
    session.rotate();
    sendBatch.retagSession(session.sessionId); // same person, new session id
    snapshotReady = false; // the new session must ship its own full_snapshot first
    emitSessionStart();
    if (captures.rrweb) {
      try {
        record.takeFullSnapshot(true);
      } catch {
        // Recorder inactive: release the snapshot gate so the session ships as
        // no-replay instead of holding its events forever.
        rrwebFailed = true;
      }
    }
    emitViewport();
    lastMeaningfulAt = Date.now();
    scheduleFlush();
  };

  // The ONLY signal that resets the inactivity clock: genuine engagement —
  // interactions, real navigations, and explicit track/identify/exception calls.
  // Deliberately NOT background network/perf/console/heartbeat or app-driven DOM
  // re-renders, so a page that merely keeps polling its API ages out. Also
  // revives a session that was already ended.
  const markMeaningful = () => {
    lastMeaningfulAt = Date.now();
    session.touch();
    if (idle) resumeFromIdle();
  };

  const syncCapture = (
    key: string,
    want: boolean,
    install: () => (() => void) | undefined,
  ) => {
    const slot = captures[key];
    if (want && !slot) {
      const stop = install();
      captures[key] = stop ? { stop } : null;
      return;
    }
    if (!want && slot) {
      try {
        slot.stop();
      } catch {
        /* ignore */
      }
      captures[key] = null;
    }
  };

  // Track the privacy options the rrweb recorder was installed with so we
  // can detect a divergence when remote config arrives and tear-down +
  // re-install with the new settings. Without this, a user who flips
  // `maskAllInputs` in Settings would still see plaintext inputs in the
  // current session — the recorder was already running.
  let installedPrivacy: {
    maskAllInputs?: boolean;
    maskTextSelector?: string;
    blockSelector?: string;
    recordCanvas?: boolean;
    recordCrossOriginIframes?: boolean;
    maskInputOptionsKey?: string;
  } | null = null;

  // URL redaction policy applied to outgoing network events. The network
  // capture reads this when serialising each event so query-strings can
  // be stripped / allowlisted, and credit-card-looking text scrubbed,
  // before they leave the browser.
  let urlRedactionPolicy: {
    strip: boolean;
    allowed: string[];
    blockCC: boolean;
  } = { strip: false, allowed: [], blockCC: false };
  // Read live per-request by createNetworkCapture via the getUrlPolicy closure,
  // so a remote-config privacy update applies without re-installing the capture.

  // Sampling overrides — populated when /v1/sdk/config arrives. Referenced
  // inside error + identify handlers so they can flip a dropped session
  // back into recording.
  let sampleOverrides: {
    alwaysRecordErrors: boolean;
    alwaysRecordIdentified: boolean;
  } | null = null;

  const installCaptures = (effective: {
    console: boolean;
    network: boolean;
    errors: boolean;
    /** Web vitals + long tasks + memory. Defaults to ON locally,
     *  but the workspace can flip it off via Settings → Recording. */
    performance?: boolean;
    captureHeaders: boolean;
    captureBodies?: boolean;
    /** The dashboard's "mask all inputs" force. It can only turn masking on:
     *  the app's own maskAllInputs (default true) is never overridden to off. */
    forceMaskAllInputs?: boolean;
    /** Input types the workspace always masks, e.g. ["email", "tel"]. */
    maskInputTypes?: string[];
    /** Workspace mask/block selectors, one entry each. Combined with the host's
     *  maskTextSelector / blockSelector (union), never replacing them. */
    maskSelectors?: string[];
    blockSelectors?: string[];
    recordCanvas?: boolean;
    recordCrossOriginIframes?: boolean;
    blockCreditCardText?: boolean;
    stripQueryParams?: boolean;
    allowedQueryParams?: string[];
    redactUrls?: Array<string | RegExp>;
    /** Phase-1 callers set this — start console/network/errors but defer
     *  rrweb until phase 2 (after remote config or 300ms timeout) so we
     *  don't lose the FullSnapshot to a stop+restart. */
    skipRrweb?: boolean;
  }) => {
    if (effective.skipRrweb) {
      // Bypass rrweb install; install the non-rrweb captures only.
      syncCapture("console", effective.console, () =>
        createConsoleCapture(emitConsole),
      );
      syncCapture("network", effective.network, () =>
        createNetworkCapture(
          {
            ...config,
            captureHeaders: effective.captureHeaders,
            redactUrls: effective.redactUrls ?? config.redactUrls,
          },
          (d: NetworkEventData) =>
            emit({ ts: d.startedAt, type: "network", data: d }),
          // Live URL-redaction policy — read per request so the remote
          // strip/allowlist/blockCC applies without re-installing the capture.
          () => urlRedactionPolicy,
        ),
      );
      syncCapture("errors", effective.errors, () =>
        createErrorCapture((d: ErrorEventData) => {
          if (sampleOverrides?.alwaysRecordErrors) turnSamplingOn();
          emit({ ts: Date.now(), type: "error", data: d });
        }),
      );
      syncCapture("navigation", true, () =>
        createNavigationCapture(
          (d: NavigationEventData) => {
            markMeaningful(); // a real route change revives an idle session
            emit({ ts: Date.now(), type: "navigation", data: d });
          },
          () => activeTextMasker,
        ),
      );
      syncCapture("viewport", true, () =>
        createViewportCapture(() => {
          emitViewport();
          scheduleFlush();
        }),
      );
      syncCapture("rageDead", true, () =>
        createRageDeadClickCapture(
          (d) => emit({ ts: Date.now(), type: "custom", data: d }),
          () => activeTextMasker,
        ),
      );
      // Performance signals (LCP/CLS/FID/longtask/memory) — ride along
      // even in the rrweb-skipped phase-1 branch so we don't miss the
      // initial paint window. Each metric becomes a `kind: "perf"`
      // custom event; the backend extracts them later.
      syncCapture("performance", effective.performance !== false, () =>
        createPerformanceCapture(
          (d) => emit({ ts: d.ts ?? Date.now(), type: "performance", data: d }),
          {
            apiHost: config.apiHost,
            captureResourceTimings: config.captureResourceTimings,
            resourceMinDurationMs: config.resourceMinDurationMs,
          },
        ),
      );
      return;
    }
    // Input masking follows the reference tracker: every value is masked
    // unless the app opts out in code (maskAllInputs: false). The dashboard
    // flag can only force masking on; it never unmasks.
    const maskAllInputs =
      (config.maskAllInputs ?? true) || effective.forceMaskAllInputs === true;
    // Password is not a forced type: the masker sends no value for it at all.
    const forcedTypes = selectorEntries(
      (effective.maskInputTypes ?? []).map((t) => String(t).toLowerCase()),
    )
      .filter((t) => t !== "password")
      .sort();
    const maskInputEmails = config.maskInputEmails !== false;
    const maskInputNumbers = config.maskInputNumbers !== false;
    // Host and workspace selectors are combined (union): either side can add a
    // private region or a blocked element, neither can remove the other's.
    const maskEntries = selectorEntries([
      config.maskTextSelector,
      ...(effective.maskSelectors ?? []),
    ]);
    // An invalid block selector makes rrweb throw on every DOM mutation (the
    // replay freezes on its snapshot): drop bad entries one by one.
    const blockCandidates = selectorEntries([
      config.blockSelector,
      ...(effective.blockSelectors ?? []),
    ]);
    const blockEntries = blockCandidates.filter((s) => validSelector(s, document));
    if (blockEntries.length < blockCandidates.length) {
      warnSelectors(
        blockCandidates.filter((s) => blockEntries.indexOf(s) === -1),
        "invalid block selector(s) ignored",
      );
    }
    const textMasker = createTextMasker({
      maskSelectors: maskEntries,
      maskEmails: config.maskTextEmails !== false,
      maskNumbers: config.maskTextNumbers === true,
      rootDoc: document,
      warn: warnMaskSelectors,
      inputs: {
        maskAll: maskAllInputs,
        forcedTypes,
        maskEmails: maskInputEmails,
        maskNumbers: maskInputNumbers,
      },
      blockSelector: blockEntries.join(", ") || undefined,
    });
    // Images, canvas, video and iframes inside private regions are recorded
    // as blocked placeholders.
    if (textMasker.mediaBlockSelector) blockEntries.push(textMasker.mediaBlockSelector);
    const nextPrivacy = {
      maskAllInputs,
      // The real selectors (not rrweb's "*"), so a change restarts the recorder.
      maskTextSelector: maskEntries.join(", ") || undefined,
      blockSelector: blockEntries.join(", ") || undefined,
      // Host config can force these on without waiting for remote config.
      recordCanvas: effective.recordCanvas ?? config.recordCanvas ?? false,
      recordCrossOriginIframes:
        effective.recordCrossOriginIframes ??
        config.recordCrossOriginIframes ??
        false,
      // Serialise the input-masking rules so the change-detection below can
      // use a simple string equality check.
      maskInputOptionsKey: `${forcedTypes.join(",")}|${maskInputEmails}|${maskInputNumbers}`,
    };
    const privacyChanged =
      installedPrivacy !== null &&
      (installedPrivacy.maskAllInputs !== nextPrivacy.maskAllInputs ||
        installedPrivacy.maskTextSelector !== nextPrivacy.maskTextSelector ||
        installedPrivacy.blockSelector !== nextPrivacy.blockSelector ||
        installedPrivacy.recordCanvas !== nextPrivacy.recordCanvas ||
        installedPrivacy.recordCrossOriginIframes !==
          nextPrivacy.recordCrossOriginIframes ||
        installedPrivacy.maskInputOptionsKey !==
          nextPrivacy.maskInputOptionsKey);
    if (privacyChanged && captures.rrweb) {
      // Stop the old recorder; new snapshot will fire on re-record so the
      // server gets a fresh full snapshot with the new privacy applied.
      captures.rrweb.stop();
      captures.rrweb = null;
    }
    if (!captures.rrweb) {
      // Only pass options to rrweb when we have a value. Some option names
      // are version-sensitive (rrweb 2.0-alpha tightened canvas/iframe
      // option validation) — passing `false` explicitly can throw on init.
      // Letting them default to rrweb's own defaults is safer.
      const rrwebOpts: Record<string, unknown> = { emit: emitSnapshot };
      // Re-emit a full snapshot periodically. rrweb only snapshots once on
      // record(); if THAT batch is lost (network blip / ingest outage), the
      // recording is unplayable — incremental mutations with no base to apply
      // them to. A periodic checkout self-heals a lost initial snapshot and lets
      // a live viewer join mid-session. Paired with the flush re-queue.
      rrwebOpts.checkoutEveryNms = 120000;
      // Visible text. rrweb only calls maskTextFn for text it already decided
      // to mask and then uses its result INSTEAD of its "*" wipe, so every
      // text node is routed through it ("*") and the masker decides per
      // element: private regions wiped, emails (and digits, if asked) masked
      // everywhere else, CSS untouched.
      activeTextMasker = textMasker;
      rrwebOpts.maskTextSelector = "*";
      rrwebOpts.maskTextFn = textMasker.maskTextFn;
      // HTML comments are never recorded (the reference tracker drops them;
      // rrweb would ship them raw, even inside private regions).
      rrwebOpts.slimDOMOptions = { comment: true };
      // Input values. rrweb hands every input type to maskInputFn, which
      // applies maskAllInputs, sends nothing for passwords and for types the
      // reference tracker never records (hidden, file, url, color…), and with
      // the app's opt-out still masks emails, 4+ digit values, workspace-forced
      // types and anything in a private region. rrweb's own maskAllInputs is
      // not used: its map would replace this one and record hidden and file
      // values raw.
      rrwebOpts.maskInputOptions = { ...ALL_INPUT_TYPES };
      rrwebOpts.maskInputFn = textMasker.maskInputFn;
      if (nextPrivacy.blockSelector)
        rrwebOpts.blockSelector = nextPrivacy.blockSelector;
      if (nextPrivacy.recordCanvas) rrwebOpts.recordCanvas = true;
      if (nextPrivacy.recordCrossOriginIframes)
        rrwebOpts.recordCrossOriginIframes = true;
      let stop: (() => void) | undefined;
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      try {
        stop = record(rrwebOpts as Parameters<typeof record>[0]);
        // rrweb only snapshots on ACTIVITY, so an idle page stops emitting and
        // the replay stream ends at the last DOM mutation — far short of the real
        // wall-clock session — while a lost/absent base leaves the whole recording
        // unplayable ("no replay frames"). Force a full snapshot on a wall-clock
        // TIMER (every 30s, regardless of activity): this keeps the stream
        // spanning the whole session (idle included) and guarantees a FRESH BASE
        // exists within 30s of any point — self-healing a lost initial snapshot,
        // surviving the privacy-driven restart below (which doesn't re-snapshot),
        // and enabling live mid-join. The SDK analog of the reference tracker's
        // periodic keepalive.
        heartbeat = setInterval(() => {
          // Never force a snapshot while the tab is HIDDEN. A backgrounded tab has
          // no visible activity to record, so forcing keepalive snapshots there
          // just pads the session with a dead idle tail (the frameless-long-session
          // phantom). The reference tracker likewise lets hidden time drive a
          // restart, not blind timers. It resumes forcing once the tab is visible.
          if (document.visibilityState === "hidden") return;
          // Idle-aware: skip the forced full snapshot when rrweb already emitted
          // within the last interval (the page is active and self-heals via its
          // own stream + the 2-min checkout). Only force one when the page has
          // gone quiet — keeping the self-heal for idle pages without
          // re-serializing a busy large-DOM app every 30s.
          if (Date.now() - lastRrwebActivityAt < 30_000) return;
          try {
            record.takeFullSnapshot(true);
          } catch {
            /* recorder not active — ignore */
          }
        }, 30_000);
        // Priority-flush the initial FullSnapshot now instead of waiting for the
        // 3s auto-flush, so the recording is playable ASAP and the most important
        // batch (the base) is the first one persisted + retried.
        scheduleFlush();
      } catch (e) {
        // Surface in console + telemetry, but don't break the whole SDK —
        // we still want console/network/errors capture even if rrweb fails.
        // eslint-disable-next-line no-console
        console.error("[replay-sdk] rrweb.record failed:", e);
        // No snapshot will ever arrive, so release the flush hold — otherwise the
        // session (console/network/errors, no replay) would buffer forever and
        // never ship. It ships as a no-replay session; the backend keeps it only
        // if it carries analytics/signal, otherwise reaps it.
        rrwebFailed = true;
      }
      if (stop) {
        const stopRec = stop;
        captures.rrweb = {
          stop: () => {
            if (heartbeat) clearInterval(heartbeat);
            stopRec();
          },
        };
      } else if (heartbeat) {
        clearInterval(heartbeat);
      }
      installedPrivacy = nextPrivacy;
    }

    // Remember the URL-redaction policy so other captures (network
    // mostly) can use it to strip query params + credit-card text.
    urlRedactionPolicy = {
      strip: !!effective.stripQueryParams,
      allowed: effective.allowedQueryParams ?? [],
      blockCC: !!effective.blockCreditCardText,
    };
    syncCapture("console", effective.console, () =>
      createConsoleCapture((d: ConsoleEventData) =>
        emit({ ts: Date.now(), type: "console", data: d }),
      ),
    );
    syncCapture("network", effective.network, () =>
      createNetworkCapture(
        {
          ...config,
          captureHeaders: effective.captureHeaders,
          redactUrls: effective.redactUrls ?? config.redactUrls,
        },
        (d: NetworkEventData) =>
          emit({ ts: d.startedAt, type: "network", data: d }),
        () => urlRedactionPolicy,
      ),
    );
    syncCapture("errors", effective.errors, () =>
      createErrorCapture((d: ErrorEventData) => {
        // If sampling-out dropped this session, but the workspace policy
        // says "always record errors", flip sampled back on the moment an
        // error fires. The current event + any in the buffer will ship
        // on the next flush.
        if (sampleOverrides?.alwaysRecordErrors) turnSamplingOn();
        emit({ ts: Date.now(), type: "error", data: d });
      }),
    );
    syncCapture("navigation", true, () =>
      createNavigationCapture((d: NavigationEventData) => {
        markMeaningful(); // a real route change revives an idle session
        emit({ ts: Date.now(), type: "navigation", data: d });
      }),
    );
    syncCapture("viewport", true, () =>
      createViewportCapture(() => {
        emitViewport();
        scheduleFlush();
      }),
    );
    // Rage + dead-click detector emits as custom events; the persistence
    // worker counts these into session.rageCount / deadCount.
    syncCapture("rageDead", true, () =>
      createRageDeadClickCapture(
        (d) => emit({ ts: Date.now(), type: "custom", data: d }),
        () => activeTextMasker,
      ),
    );
    // Performance signals — LCP/CLS/FID via PerformanceObserver,
    // long tasks for jank, and periodic heap-size snapshots. Each
    // metric is wrapped as a `kind: "perf"` rrweb-style event; the
    // persistence service treats the `type: "performance"` channel
    // exactly like custom rage-click events.
    syncCapture("performance", effective.performance !== false, () =>
      createPerformanceCapture(
        (d) => emit({ ts: d.ts ?? Date.now(), type: "performance", data: d }),
        {
          // Give the resource-timing observer our own ingest origin (same options
          // the phase-1 install passes) so its isServiceURL check can always skip
          // /v1/sdk/config etc. even if the perf slot is re-created via this path.
          apiHost: config.apiHost,
          captureResourceTimings: config.captureResourceTimings,
          resourceMinDurationMs: config.resourceMinDurationMs,
        },
      ),
    );
  };

  // The visibility-gated start. Following the reference tracker, NOTHING is
  // emitted, installed, or flushed until the tab is first VISIBLE — a tab that
  // loads hidden (background-opened, prerendered) records nothing until the user
  // actually looks at it, and one closed while still hidden never creates a
  // session. Runs at most once (the `started` guard).
  const startCapture = () => {
    if (started || stopping) return;
    // excludeUrls is the host's own opt-out, so it applies even when the
    // remote config never arrives (applyRemoteConfig re-checks it too).
    if ((config.excludeUrls ?? []).some((g) => matchesGlob(g, window.location.href))) {
      blocked = true;
      sampled = false;
      return;
    }
    started = true;
    // A FRESH session anchors its clock to NOW (first-visible) so the timeline
    // begins when the page is seen, not when a hidden tab constructed the
    // runtime. A resumed session keeps its original startedAt (offset continuity).
    if (!session.resumed) session.beginFreshClock();

    // A fresh session opens with session_start (sets the entry page). A RESUMED
    // session — a reload or same-tab navigation within the inactivity window —
    // doesn't: the original entry page is preserved, and the page view is the
    // navigation(load) the navigation capture emits on install (installed just
    // below, for every page load). Emitting one here too counted every reload
    // as two page views.
    if (!session.resumed) emitSessionStart();
    emitViewport();

    // We install captures in *two phases* to avoid losing the rrweb
    // FullSnapshot. Phase 1 starts everything EXCEPT rrweb. Phase 2 runs
    // after remote config arrives (or 300ms timeout, whichever's first) and
    // starts rrweb with the final privacy/canvas options.
    //
    // Why split? rrweb only fires FullSnapshot on initial `record()`. If we
    // started it in phase 1 with stale config, then stopped+restarted in
    // phase 2 because `recordCanvas` flipped, the new instance does NOT
    // re-emit a FullSnapshot (rrweb 2.0-alpha quirk). The Replayer then
    // has incremental snapshots with nothing to apply them to → blank
    // screen with "no replay frames" in the dashboard.
    installCaptures({
      console: config.captureConsole !== false,
      network: config.captureNetwork !== false,
      errors: config.captureErrors !== false,
      // Default-on in phase 1 so we don't miss the LCP window while remote
      // config is in flight. If remote arrives and says off, the next
      // installCaptures call disables it.
      performance: true,
      captureHeaders: config.captureHeaders ?? false,
      // Phase 1 deliberately skips rrweb — see installCaptures internals.
      skipRrweb: true,
    });

    // Promise race: whichever fires first wins. We never wait > 300ms for
    // remote config — a slow /v1/sdk/config request shouldn't delay
    // recording.
    const remotePromise = fetchRemoteConfig(config);
    const timeoutPromise = new Promise<null>((r) =>
      setTimeout(() => r(null), 300),
    );
    void Promise.race([remotePromise, timeoutPromise]).then(async (remote) => {
      // If the race was won by the timeout, await the actual remote in the
      // background so it can still adjust mid-session — but start recording
      // NOW using local config as the source of truth.
      if (remote === null) {
        if (stopping) return;
        // The workspace's last-seen privacy rules (force flag, selectors,
        // forced types) apply now, so the first snapshot doesn't wait for a
        // slow config to mask what the dashboard asked for.
        const cached = readCachedPrivacy();
        installCaptures({
          console: config.captureConsole !== false,
          network: config.captureNetwork !== false,
          errors: config.captureErrors !== false,
          performance: true,
          captureHeaders: config.captureHeaders ?? false,
          ...(cached ?? {}),
        });
        const lateRemote = await remotePromise.catch(() => null);
        if (lateRemote) applyRemoteConfig(lateRemote);
        return;
      }
      applyRemoteConfig(remote);
    });

    // Start the periodic flush now (not while hidden). Its first tick and any
    // scheduleFlush() are still held by the snapshot gate until the base exists.
    session.startAutoFlush(flush);
  };

  function applyRemoteConfig(
    remote: NonNullable<Awaited<ReturnType<typeof fetchRemoteConfig>>>,
  ) {
    // Uploads were already halted (or stop() ran): a late config must not
    // re-install the captures.
    if (blocked || stopped || stopping) return;
    // ---- Hard cap gate ----------------------------------------------
    // The workspace has spent its plan's session allowance. Record NOTHING and
    // ship NOTHING — this beats every "always record" override below (a maxed
    // plan doesn't record errors or identified users either). The server also
    // rejects any batch that slips through, but honouring the flag here is what
    // saves the upload: the device does no work at all.
    if (remote.shouldNotRecord) {
      blocked = true;
      sampled = false;
      return;
    }

    // Host-configured URL/route EXCLUSION — the "don't record this screen" opt-out
    // for web. A deny-list of path globs (e.g. "/settings/billing", "/admin/**")
    // beats every "always record" override and the sample roll; like
    // shouldNotRecord, an excluded URL does NO capture work and ships nothing.
    // NOTE (SPA follow-up): this is evaluated at init/config time. A single-page
    // app that CLIENT-navigates into an excluded route mid-session is not yet
    // re-gated — that needs a navigation hook that pauses/resumes capture.
    if (
      (config.excludeUrls ?? []).some((g) =>
        matchesGlob(g, window.location.href),
      )
    ) {
      blocked = true;
      sampled = false;
      return;
    }

    // ---- Sampling decision ------------------------------------------
    // Start by rolling the sample rate. The "always record" overrides
    // below can flip the decision back on for this particular session.
    const url = window.location.href;
    const urlForced = (remote.sampling.alwaysRecordOnUrls ?? []).some((g) =>
      matchesGlob(g, url),
    );
    const triggerAllowsRecord =
      remote.capture.trigger !== "identified" || !!config.distinctId;
    const sampledIn = urlForced || Math.random() <= remote.sampling.rate;
    sampled = sampledIn && triggerAllowsRecord;
    if (!sampled) {
      // Still install the rest of the captures so identify() can flip
      // sampling on later. We just won't ship the batches.
    }

    // ---- Capture toggles --------------------------------------------
    // maskSelectors/blockSelectors arrive as arrays of CSS selectors and stay
    // arrays: installCaptures validates them one by one and combines them with
    // the host's. maskAllInputs is the dashboard's force (it can only add
    // masking); maskInputTypes lists the types the workspace always masks.
    const privacy: CachedPrivacy = {
      forceMaskAllInputs: remote.privacy.maskAllInputs === true,
      maskSelectors: strings(remote.privacy.maskSelectors),
      blockSelectors: strings(remote.privacy.blockSelectors),
      maskInputTypes: strings(remote.privacy.maskInputTypes),
    };
    writeCachedPrivacy(privacy);

    // Remember the rules so identify()-triggered re-evaluation can flip
    // sampling on later when alwaysRecordIdentified=true.
    sampleOverrides = {
      alwaysRecordErrors: remote.sampling.alwaysRecordErrors,
      alwaysRecordIdentified: remote.sampling.alwaysRecordIdentified,
    };

    installCaptures({
      console: remote.capture.console,
      network: remote.capture.network,
      errors: remote.capture.errors,
      performance: remote.capture.performance,
      captureHeaders: remote.capture.networkHeaders ?? remote.capture.headers,
      captureBodies: remote.capture.networkBodies,
      ...privacy,
      recordCanvas: remote.capture.canvas,
      recordCrossOriginIframes: remote.capture.iframe,
      blockCreditCardText: remote.privacy.blockCreditCardText,
      stripQueryParams: remote.privacy.stripQueryParams,
      allowedQueryParams: remote.privacy.allowedQueryParams,
      redactUrls: compileRedactPatterns(remote.privacy.redactUrlPatterns),
    });
  } // end applyRemoteConfig

  // Tiny glob matcher — supports `**` (matches anything) and `*` (matches
  // anything not /). Enough for `/checkout/**` style patterns.
  function matchesGlob(glob: string, url: string): boolean {
    try {
      const path = new URL(url).pathname;
      const rx =
        "^" +
        glob
          .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
          .replace(/\*\*/g, "::DOUBLE::")
          .replace(/\*/g, "[^/]*")
          .replace(/::DOUBLE::/g, ".*") +
        "$";
      return new RegExp(rx).test(path);
    } catch {
      return false;
    }
  }

  // ── Page lifecycle ──────────────────────────────────────────────────────────
  // The browser order on a close or same-tab navigation is pagehide, then
  // visibilitychange:hidden, in one task, with no time for async work (gzip).
  // A tab switch or a mobile app switch fires only visibilitychange — and a
  // backgrounded mobile page may be killed later without any other event.
  //  - pagehide: re-send regular uploads still pending (redeliverPending), then
  //    ship the tail as one keepalive batch. session_end("unload") only when the
  //    page is really going away (not persisted into the back/forward cache).
  //  - visibilitychange:hidden: ship the tail without session_end (the session
  //    goes on), then, if the page is still alive, the rest through the regular
  //    gzip path.
  //  - pageshow (persisted): restoreFromBfcache().
  // No beforeunload listener: it can be cancelled (the page lives on) and it
  // keeps pages out of the back/forward cache in some browsers.

  // Ship the buffer without waiting (unload-safe): ONE keepalive batch within
  // the browser's budget, most valuable events first; what doesn't fit stays
  // buffered for the next regular flush if the page lives on. Same gates as
  // flush(), and the host's beforeSend runs on it too.
  const shipTail = (
    endReason?: SessionEndEventData["reason"],
    leaving = false,
  ) => {
    if (stopped) return;
    if (!sampled || blocked) {
      session.drain();
      // This page doesn't record, but an earlier one's leftovers still go on.
      if (leaving) session.stashForNextPage(true);
      return;
    }
    // Never create a server-side session on the way out for a tab that never
    // visibly started, or whose snapshot never arrived (and rrweb didn't fail).
    // Leaving, its events still go to the next page load of this session (a
    // redirect must not lose the landing page's session_start, URL and UTM
    // tags) — they're only sent if that page records — and so do earlier
    // pages' leftovers. A tab that never showed hands on only the latter.
    if (!started || (!snapshotReady && !rrwebFailed)) {
      if (leaving) session.stashForNextPage(!started);
      return;
    }
    if (endReason) emitSessionEnd(endReason);
    session.flushFinal(
      (envelope, hooked) => {
        // A carried batch the hook already ran on goes out as it is, if the
        // hook still lets it. Anything else: the hook gets a copy, since what
        // isn't sent stays held (a smaller retry, the buffer, the outbox).
        const next = hooked
          ? recheckBeforeSend(config.beforeSend, envelope)
          : applyBeforeSendToCopy(config.beforeSend, envelope);
        // Dropped by the hook: nothing to keep for later.
        return next ? sendBatch.sendFinal(next) : true;
      },
      // A tab switch leaves part of the budget free: the page may be closed
      // before this batch is done, and that close must still fit its own.
      (shell) => sendBatch.finalRoom(shell, !leaving),
      leaving,
    );
    // Leaving (closed, or into the back/forward cache — the usual case for a
    // same-tab navigation): what didn't fit goes to the next page load of this
    // session in this tab, or back to this page if it is restored.
    if (leaving) session.stashForNextPage();
  };

  const onPageHide = (e: PageTransitionEvent) => {
    unloading = true;
    // First the regular uploads the browser would cancel with the page: they
    // hold the older events, possibly this page's base snapshot.
    // What can't be re-sent now goes with this page's leftovers.
    session.carryUnsent(sendBatch.redeliverPending(), (e) => hookedEnvelopes.has(e));
    if (e.persisted) {
      // Into the back/forward cache: it may come back, so the session isn't over.
      inBfcache = started;
      shipTail(undefined, true);
    } else {
      shipTail("unload", true);
    }
  };

  const onVisibilityChange = () => {
    if (document.visibilityState !== "hidden") return;
    shipTail();
    if (!unloading) void flush();
  };

  const onPageShow = (e: PageTransitionEvent) => {
    if (!e.persisted) return;
    unloading = false;
    if (!inBfcache) return;
    inBfcache = false;
    restoreFromBfcache();
  };

  // The page came back from the back/forward cache. Its JS state is intact but
  // other pages of this tab ran meanwhile, so: new segment (and maybe a new
  // session, decided like a page load), a page-view event, and a fresh base
  // snapshot — without it the replay would apply this page's diffs to the DOM
  // of the page shown in between.
  const restoreFromBfcache = () => {
    // Anything buffered before the freeze goes out under the old ids first;
    // flush() reads the ids and drains synchronously before its first await.
    void flush();
    const before = session.sessionId;
    const continued = session.restoreFromBfcache();
    if (session.sessionId !== before) sendBatch.retagSession(session.sessionId);
    idle = false;
    endedSessionId = null;
    lastMeaningfulAt = Date.now(); // Back/Forward is the user acting
    // A new session opens like a fresh load: session_start, then the page view
    // (the server counts page views from navigation events).
    if (!continued) emitSessionStart();
    emit({
      ts: Date.now(),
      type: "navigation",
      data: {
        to: redactUrlForStorage(window.location.href),
        title: activeTextMasker.titleFor(document.title) || undefined,
        trigger: "load",
      } satisfies NavigationEventData,
    });
    emitViewport();
    if (captures.rrweb) {
      snapshotReady = false;
      try {
        record.takeFullSnapshot(true);
      } catch {
        rrwebFailed = true;
      }
    }
    scheduleFlush();
  };

  document.addEventListener("visibilitychange", onVisibilityChange);
  window.addEventListener("pagehide", onPageHide);
  window.addEventListener("pageshow", onPageShow);

  // Keep the session's last-activity marker fresh on genuine USER interaction —
  // deliberately NOT the SDK's own heartbeat/perf events, so an idle tab that's
  // only emitting keepalive snapshots still ages out of the resume window. These
  // are passive + capture so they never delay the page's own handlers, and the
  // write behind touch() is throttled, so this is effectively free on the hot
  // pointer/scroll path.
  const onUserActivity = () => markMeaningful();
  const activityEvents = [
    "pointerdown",
    "keydown",
    "scroll",
    "touchstart",
  ] as const;
  for (const evt of activityEvents) {
    window.addEventListener(evt, onUserActivity, {
      passive: true,
      capture: true,
    });
  }

  // Live inactivity timeout: end the session after `inactivityMs` with no
  // meaningful activity (GA's session model + the reference tracker's own
  // "stop session after inactivity timeout" TODO). Poll at a fraction of the
  // window (≤30s) — cheap, and precise enough since the window is minutes.
  // sessionInactivityMs = 0 (or huge) effectively disables it.
  if (session.inactivityMs > 0) {
    const checkEvery = Math.min(
      30_000,
      Math.max(1_000, Math.floor(session.inactivityMs / 4)),
    );
    idleTimer = window.setInterval(() => {
      if (!idle && started && Date.now() - lastMeaningfulAt >= session.inactivityMs) {
        endForIdle();
      }
    }, checkEvery);
  }

  // Kick off the visibility-gated start. If the tab is already visible, start
  // synchronously — unchanged behavior for the overwhelmingly common case. If it
  // loaded hidden (background-opened tab / prerender, which report "hidden"),
  // defer the entire start to the first time it becomes visible, then unregister,
  // so a hidden tab is never recorded and — if it's closed while still hidden —
  // no session is ever created.
  if (document.visibilityState !== "hidden") {
    startCapture();
  } else {
    const deferredStart = () => {
      if (document.visibilityState !== "hidden") {
        document.removeEventListener("visibilitychange", deferredStart);
        onFirstVisible = undefined;
        startCapture();
      }
    };
    onFirstVisible = deferredStart;
    document.addEventListener("visibilitychange", deferredStart);
  }

  const identify: ReplayController["identify"] = (idOrPayload, props) => {
    const payload: IdentifyPayload =
      typeof idOrPayload === "string"
        ? { distinctId: idOrPayload, ...(props ?? {}) }
        : { ...idOrPayload };
    sendBatch.setIdentify(payload);
    markMeaningful(); // identify is engagement — revives an idle session
    // Emit a DISCRETE, timestamped identify marker into the stream (parity with
    // the reference tracker's UserID message) so the exact moment of anon→known
    // is a first-class timeline event, not just an attribute on later batches.
    if (payload.distinctId || payload.email) {
      emit({
        ts: Date.now(),
        type: "custom",
        data: {
          kind: "identify",
          distinctId: payload.distinctId ?? payload.email,
          ...(payload.email ? { email: payload.email } : {}),
        },
      });
    }
    // Workspace policy: "always record identified users" flips a
    // previously-dropped session back into recording the moment the
    // customer calls identify(). Saves an "I had this user but no
    // session" support ticket.
    if (sampleOverrides?.alwaysRecordIdentified && payload.distinctId) {
      turnSamplingOn();
    }
    void flush();
  };

  // Host-supplied anonymous/device id — override the SDK's generated fingerprint
  // so the same person is one anonymous user across the customer's systems.
  // Persisted so it survives reloads.
  const setAnonymousId: ReplayController["setAnonymousId"] = (id) => {
    if (!id || typeof id !== "string") return;
    const trimmed = truncate(id.trim(), 200);
    if (!trimmed) return;
    setStoredFingerprint(trimmed);
    sendBatch.setFingerprint(trimmed);
  };

  // Free-form session trait, independent of user identity. Captured into the
  // stream as a custom event so it's queryable + timeline-visible.
  const setMetadata: ReplayController["setMetadata"] = (key, value) => {
    if (!key || typeof key !== "string") return;
    emit({
      ts: Date.now(),
      type: "custom",
      data: {
        kind: "session_metadata",
        key: truncate(key.trim(), 80),
        value: typeof value === "string" ? truncate(value, 500) : String(value),
      },
    });
    void flush();
  };

  // Custom event tracking. Rides along in the batch as a `custom`
  // event with `kind: "track"` so the backend can pluck names into a
  // denormalised `Session.eventNames[]` without breaking older
  // consumers that already match `kind: "rage_click" | "dead_click"`.
  const track: ReplayController["track"] = (name, properties) => {
    if (!name || typeof name !== "string") return;
    const safeName = truncate(name.trim(), 80);
    if (!safeName) return;
    markMeaningful(); // a tracked event is engagement — revives an idle session
    emit({
      ts: Date.now(),
      type: "custom",
      data: {
        kind: "track",
        name: safeName,
        // Cap properties to keep batches small. Stringify defensively
        // so we don't ship Functions / DOM nodes.
        properties: properties ? safeProps(properties) : undefined,
      },
    });
  };

  // Report a developer-caught exception as the same `error` event the automatic
  // window handlers emit, marked handled (so the dashboard classifies it as an
  // "exception" vs an uncaught "crash"). Mirrors track()'s emit path.
  const captureException: ReplayController["captureException"] = (
    error,
    opts,
  ) => {
    // Same policy as the automatic error path: if sampling-out dropped this
    // session but the workspace says "always record errors", a reported
    // exception flips recording back on — otherwise the handled error the
    // feature exists to surface would be discarded on the next flush.
    if (sampleOverrides?.alwaysRecordErrors) turnSamplingOn();
    markMeaningful(); // an explicitly-reported exception is engagement
    emit({
      ts: Date.now(),
      type: "error",
      data: errorDataFromValue(error, opts?.handled ?? true, opts?.metadata),
    });
  };

  return {
    // Getter — rotate() (inactivity return) changes the id mid-flight, so a host
    // reading `replay.sessionId` must see the CURRENT session, not the init one.
    get sessionId() {
      return session.sessionId;
    },
    flush,
    identify,
    track,
    captureException,
    setAnonymousId,
    setMetadata,
    // Deep link to THIS session in the dashboard — the private, authed
    // /recordings/<id> route (NOT a public share link). Read the live session id
    // (it rotates on inactivity), and derive the app host from apiHost.
    urlForCurrentSession: () =>
      session.sessionId
        ? `${dashboardHostFromApiHost(config.apiHost)}/recordings/${session.sessionId}`
        : null,
    // A second call while the first is still delivering waits for that run.
    stop: () =>
      (stopRun ??= (async () => {
      stopping = true;
      if (onFirstVisible) {
        document.removeEventListener("visibilitychange", onFirstVisible);
        onFirstVisible = undefined;
      }
      if (idleTimer !== undefined) window.clearInterval(idleTimer);
      stopCaptures();
      for (const evt of activityEvents) {
        window.removeEventListener(evt, onUserActivity, {
          capture: true,
        } as EventListenerOptions);
      }
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("pagehide", onPageHide);
      window.removeEventListener("pageshow", onPageShow);
      session.stopAutoFlush();
      emitSessionEnd("manual");
      // Deliver what is left, even during a backoff: carried batches, then the
      // buffer — one batch per flush. Counted once the send in flight is done:
      // if it fails, its batch is carried and goes first. A carried batch that
      // goes through sends the next one at once (flush's own `void flush()`):
      // that send is waited for too, so nothing leaves after stop() resolves.
      if (inFlightSend) await inFlightSend;
      for (let i = session.carried.length; i >= 0; i -= 1) {
        await flush({ ignoreBackoff: true });
        while (inFlightSend) await inFlightSend;
      }
      stopped = true;
    })()),
  };
}

/**
 * Coerce arbitrary properties into a JSON-safe shape before shipping
 * with a track() event. We keep:
 *   - primitives (string/number/boolean/null)
 *   - arrays of primitives
 *   - plain objects one level deep
 * Anything else (DOM nodes, functions, circular structures) is
 * dropped. Caps at 20 keys + 200 chars per value so a single noisy
 * call can't blow the batch size budget.
 */
function safeProps(p: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  let i = 0;
  for (const k of Object.keys(p)) {
    if (i >= 20) break;
    i++;
    const v = p[k];
    if (v === null || typeof v === "boolean" || typeof v === "number") {
      out[k] = v;
    } else if (typeof v === "string") {
      out[k] = truncate(v, 200);
    } else if (Array.isArray(v)) {
      out[k] = v.slice(0, 20).map((x) =>
        typeof x === "string" ? truncate(x, 200) : x,
      );
    } else if (v && typeof v === "object") {
      // Flatten one level — { from: "free", to: "pro" } is the
      // typical track() payload. Anything deeper gets toString'd.
      try {
        out[k] = JSON.parse(JSON.stringify(v));
      } catch {
        out[k] = truncate(String(v), 200);
      }
    }
  }
  return out;
}
