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
import { createBatchSender, type IdentifyPayload } from "./transport";
import { createSessionRuntime } from "./runtime";
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
import { getBrowserFingerprint, setStoredFingerprint } from "./fingerprint";
import { redactUrlForStorage } from "./utils";
import type { ReplayController, WebReplayConfig } from "./types";

interface CaptureSlot {
  stop: () => void;
}

export function initReplay(config: WebReplayConfig): ReplayController {
  if (typeof window === "undefined" || typeof document === "undefined") {
    throw new Error("initReplay must run in a browser context");
  }

  const session = createSessionRuntime(config);
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

  if (config.distinctId)
    sendBatch.setIdentify({ distinctId: config.distinctId });


  const emit = <TData>(
    event: Omit<ReplayEvent<TData>, "id" | "offsetMs" | "source">,
  ) => {
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
      title: document.title || undefined,
    };
    emit({ ts: Date.now(), type: "session_start", data });
  };

  const emitSnapshot = (rrwebEvent: eventWithTime) => {
    const data: SnapshotEventData = { recorder: "rrweb", rrwebEvent };
    emit({
      ts: rrwebEvent.timestamp,
      type: rrwebEvent.type === 2 ? "full_snapshot" : "incremental_snapshot",
      data,
    });
  };

  const emitViewport = () => {
    const data: ViewportEventData = {
      width: window.innerWidth,
      height: window.innerHeight,
    };
    emit({ ts: Date.now(), type: "viewport", data });
  };

  const emitSessionEnd = (reason: SessionEndEventData["reason"]) => {
    emit({ ts: Date.now(), type: "session_end", data: { reason } });
  };

  const flush = async () => {
    if (!sampled || blocked) {
      session.drain();
      return;
    }
    const events = session.drain();
    if (events.length === 0) return;
    const envelope: ReplayBatchEnvelope = {
      projectId: config.projectId,
      sessionId: session.sessionId,
      segmentId: session.segmentId,
      sequence: session.nextSequence(),
      sentAt: Date.now(),
      sdk: session.sdk,
      page: session.pageContext(),
      events,
    };
    const nextEnvelope = config.beforeSend
      ? (config.beforeSend({ envelope })?.envelope ?? null)
      : envelope;
    if (!nextEnvelope) return;
    try {
      await sendBatch(nextEnvelope);
    } catch {
      // Send ultimately failed (network down, ingest outage, server error). Put
      // the events back so the NEXT flush retries them rather than dropping the
      // batch — dropping the first batch loses the rrweb FullSnapshot and makes
      // the whole recording unplayable ("no replay frames"). Bounded in
      // requeue(), so a sustained outage can't grow the buffer without limit.
      session.requeue(events);
    }
  };

  const scheduleFlush = () => {
    void flush();
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
  void urlRedactionPolicy; // read by createNetworkCapture (closure)

  // Sampling overrides — populated when /v1/sdk/config arrives. Referenced
  // inside error + identify handlers so they can flip a dropped session
  // back into recording.
  let sampleOverrides: {
    alwaysRecordErrors: boolean;
    alwaysRecordIdentified: boolean;
  } | null = null;
  let minDurationMs = 0;
  void minDurationMs;

  const installCaptures = (effective: {
    console: boolean;
    network: boolean;
    errors: boolean;
    /** Web vitals + long tasks + memory. Defaults to ON locally,
     *  but the workspace can flip it off via Settings → Recording. */
    performance?: boolean;
    captureHeaders: boolean;
    captureBodies?: boolean;
    maskAllInputs?: boolean;
    /** rrweb maskInputOptions — e.g. { password: true, email: true } */
    maskInputOptions?: Record<string, boolean>;
    maskTextSelector?: string;
    blockSelector?: string;
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
        ),
      );
      syncCapture("errors", effective.errors, () =>
        createErrorCapture((d: ErrorEventData) => {
          if (!blocked && !sampled && sampleOverrides?.alwaysRecordErrors) sampled = true;
          emit({ ts: Date.now(), type: "error", data: d });
        }),
      );
      syncCapture("navigation", true, () =>
        createNavigationCapture((d: NavigationEventData) =>
          emit({ ts: Date.now(), type: "navigation", data: d }),
        ),
      );
      syncCapture("viewport", true, () =>
        createViewportCapture(() => {
          emitViewport();
          scheduleFlush();
        }),
      );
      syncCapture("rageDead", true, () =>
        createRageDeadClickCapture((d) =>
          emit({ ts: Date.now(), type: "custom", data: d }),
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
    const nextPrivacy = {
      maskAllInputs: effective.maskAllInputs ?? config.maskAllInputs ?? true, // safe default
      maskTextSelector: effective.maskTextSelector ?? config.maskTextSelector,
      blockSelector: effective.blockSelector ?? config.blockSelector,
      recordCanvas: effective.recordCanvas ?? false,
      recordCrossOriginIframes: effective.recordCrossOriginIframes ?? false,
      // Serialise input-type masks so the change-detection below can use a
      // simple string equality check.
      maskInputOptionsKey: Object.keys(
        effective.maskInputOptions ?? { password: true },
      )
        .sort()
        .join(","),
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
      if (typeof nextPrivacy.maskAllInputs === "boolean")
        rrwebOpts.maskAllInputs = nextPrivacy.maskAllInputs;
      if (nextPrivacy.maskTextSelector)
        rrwebOpts.maskTextSelector = nextPrivacy.maskTextSelector;
      if (nextPrivacy.blockSelector)
        rrwebOpts.blockSelector = nextPrivacy.blockSelector;
      if (nextPrivacy.recordCanvas) rrwebOpts.recordCanvas = true;
      if (nextPrivacy.recordCrossOriginIframes)
        rrwebOpts.recordCrossOriginIframes = true;
      // Always-on input-type masks (password by default, plus anything the
      // workspace's mask rules implied via `input[type="X"]` selectors).
      // This wins even when maskAllInputs is false.
      if (
        effective.maskInputOptions &&
        Object.keys(effective.maskInputOptions).length > 0
      ) {
        rrwebOpts.maskInputOptions = effective.maskInputOptions;
      } else {
        rrwebOpts.maskInputOptions = { password: true };
      }
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
      ),
    );
    syncCapture("errors", effective.errors, () =>
      createErrorCapture((d: ErrorEventData) => {
        // If sampling-out dropped this session, but the workspace policy
        // says "always record errors", flip sampled back on the moment an
        // error fires. The current event + any in the buffer will ship
        // on the next flush.
        if (!blocked && !sampled && sampleOverrides?.alwaysRecordErrors) {
          sampled = true;
        }
        emit({ ts: Date.now(), type: "error", data: d });
      }),
    );
    syncCapture("navigation", true, () =>
      createNavigationCapture((d: NavigationEventData) =>
        emit({ ts: Date.now(), type: "navigation", data: d }),
      ),
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
      createRageDeadClickCapture((d) =>
        emit({ ts: Date.now(), type: "custom", data: d }),
      ),
    );
    // Performance signals — LCP/CLS/FID via PerformanceObserver,
    // long tasks for jank, and periodic heap-size snapshots. Each
    // metric is wrapped as a `kind: "perf"` rrweb-style event; the
    // persistence service treats the `type: "performance"` channel
    // exactly like custom rage-click events.
    syncCapture("performance", effective.performance !== false, () =>
      createPerformanceCapture((d) =>
        emit({ ts: d.ts ?? Date.now(), type: "performance", data: d }),
      ),
    );
  };

  // A fresh session opens with session_start (sets the entry page). A RESUMED
  // session — a reload or same-tab back/forward within the inactivity window —
  // instead records the reload as a page navigation, so the original entry page
  // is preserved and the reload shows on the timeline as a page transition
  // rather than a second "session start".
  if (session.resumed) {
    emit({
      ts: Date.now(),
      type: "navigation",
      data: {
        to: window.location.href,
        trigger: "load",
      } satisfies NavigationEventData,
    });
  } else {
    emitSessionStart();
  }
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
    maskAllInputs: config.maskAllInputs ?? true,
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
      installCaptures({
        console: config.captureConsole !== false,
        network: config.captureNetwork !== false,
        errors: config.captureErrors !== false,
        performance: true,
        captureHeaders: config.captureHeaders ?? false,
        maskAllInputs: config.maskAllInputs ?? true,
      });
      const lateRemote = await remotePromise.catch(() => null);
      if (lateRemote) applyRemoteConfig(lateRemote);
      return;
    }
    applyRemoteConfig(remote);
  });

  function applyRemoteConfig(
    remote: NonNullable<Awaited<ReturnType<typeof fetchRemoteConfig>>>,
  ) {
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
    // maskSelectors/blockSelectors arrive as arrays of CSS selectors;
    // rrweb takes a single comma-joined string for each.
    const maskTextSelector =
      (remote.privacy.maskSelectors ?? []).join(", ") || undefined;
    const blockSelector =
      (remote.privacy.blockSelectors ?? []).join(", ") || undefined;

    // Build rrweb's maskInputOptions from the server-derived input-type
    // list. `password` is always included even when the customer disables
    // maskAllInputs — that's the security floor.
    const maskInputOptions: Record<string, boolean> = {};
    for (const t of remote.privacy.maskInputTypes ?? ["password"]) {
      maskInputOptions[t] = true;
    }

    installCaptures({
      console: remote.capture.console,
      network: remote.capture.network,
      errors: remote.capture.errors,
      performance: remote.capture.performance,
      captureHeaders: remote.capture.networkHeaders ?? remote.capture.headers,
      captureBodies: remote.capture.networkBodies,
      maskAllInputs: remote.privacy.maskAllInputs,
      maskInputOptions,
      maskTextSelector,
      blockSelector,
      recordCanvas: remote.capture.canvas,
      recordCrossOriginIframes: remote.capture.iframe,
      blockCreditCardText: remote.privacy.blockCreditCardText,
      stripQueryParams: remote.privacy.stripQueryParams,
      allowedQueryParams: remote.privacy.allowedQueryParams,
      redactUrls: remote.privacy.redactUrlPatterns.map(
        (p) => new RegExp(p, "i"),
      ),
    });

    // Remember the rules so identify()-triggered re-evaluation can flip
    // sampling on later when alwaysRecordIdentified=true.
    sampleOverrides = {
      alwaysRecordErrors: remote.sampling.alwaysRecordErrors,
      alwaysRecordIdentified: remote.sampling.alwaysRecordIdentified,
    };
    minDurationMs = remote.capture.minDurationMs ?? 0;
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

  // (sampleOverrides + minDurationMs declared earlier — see above)

  session.startAutoFlush(flush);

  // Deliver the tail reliably as the page goes away. visibilitychange:hidden is
  // the signal that fires FIRST on a tab close (and the only one guaranteed when
  // a mobile tab is backgrounded / on bfcache), so the closing frames are
  // usually shipped while the page is still alive; pagehide + beforeunload mop
  // up anything left. Each call drains the buffer, so the later ones are no-ops
  // when an earlier one already sent — no duplicate batches.
  const finalFlush = (reason: SessionEndEventData["reason"]) => {
    emitSessionEnd(reason);
    session.flushFinal(sendBatch.sendFinal);
  };
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") finalFlush("visibility_hidden");
  });
  window.addEventListener("pagehide", () => finalFlush("unload"));
  window.addEventListener("beforeunload", () => finalFlush("unload"));

  // Keep the session's last-activity marker fresh on genuine USER interaction —
  // deliberately NOT the SDK's own heartbeat/perf events, so an idle tab that's
  // only emitting keepalive snapshots still ages out of the resume window. These
  // are passive + capture so they never delay the page's own handlers, and the
  // write behind touch() is throttled, so this is effectively free on the hot
  // pointer/scroll path.
  const onUserActivity = () => session.touch();
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

  const identify: ReplayController["identify"] = (idOrPayload, props) => {
    const payload: IdentifyPayload =
      typeof idOrPayload === "string"
        ? { distinctId: idOrPayload, ...(props ?? {}) }
        : { ...idOrPayload };
    sendBatch.setIdentify(payload);
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
    if (
      !blocked &&
      !sampled &&
      sampleOverrides?.alwaysRecordIdentified &&
      payload.distinctId
    ) {
      sampled = true;
    }
    void flush();
  };

  // Host-supplied anonymous/device id — override the SDK's generated fingerprint
  // so the same person is one anonymous user across the customer's systems.
  // Persisted so it survives reloads.
  const setAnonymousId: ReplayController["setAnonymousId"] = (id) => {
    if (!id || typeof id !== "string") return;
    const trimmed = id.trim().slice(0, 200);
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
        key: key.trim().slice(0, 80),
        value: typeof value === "string" ? value.slice(0, 500) : String(value),
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
    const safeName = name.trim().slice(0, 80);
    if (!safeName) return;
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
    if (!blocked && !sampled && sampleOverrides?.alwaysRecordErrors) {
      sampled = true;
    }
    emit({
      ts: Date.now(),
      type: "error",
      data: errorDataFromValue(error, opts?.handled ?? true, opts?.metadata),
    });
  };

  return {
    sessionId: session.sessionId,
    flush,
    identify,
    track,
    captureException,
    setAnonymousId,
    setMetadata,
    stop: async () => {
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
      for (const evt of activityEvents) {
        window.removeEventListener(evt, onUserActivity, {
          capture: true,
        } as EventListenerOptions);
      }
      session.stopAutoFlush();
      emitSessionEnd("manual");
      await flush();
    },
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
      out[k] = v.slice(0, 200);
    } else if (Array.isArray(v)) {
      out[k] = v.slice(0, 20).map((x) =>
        typeof x === "string" ? x.slice(0, 200) : x,
      );
    } else if (v && typeof v === "object") {
      // Flatten one level — { from: "free", to: "pro" } is the
      // typical track() payload. Anything deeper gets toString'd.
      try {
        out[k] = JSON.parse(JSON.stringify(v));
      } catch {
        out[k] = String(v).slice(0, 200);
      }
    }
  }
  return out;
}
