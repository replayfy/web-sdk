import type {
  ReplayBatchEnvelope,
  ReplayPrivacyConfig,
  ReplaySdkDescriptor,
} from "./schema";
import type { IdentifyPayload } from "./transport";

export interface WebReplayConfig extends ReplayPrivacyConfig {
  apiKey: string;
  apiHost: string;
  projectId?: string;
  distinctId?: string;
  /** Build / revision id of the deployed app, surfaced as a funnel +
   *  session-search filter so you can scope analysis to one release. */
  revId?: string;
  sessionId?: string;
  /** How long a tab can go WITHOUT user interaction before a reload starts a
   *  fresh session instead of continuing the current one. Defaults to 30 min
   *  (the session-analytics norm). This is the client-side session boundary —
   *  our ingest appends batches by sessionId without validating continuation,
   *  so the SDK is what decides when one session ends and the next begins. */
  sessionInactivityMs?: number;
  flushIntervalMs?: number;
  maxBufferSize?: number;
  captureConsole?: boolean;
  captureNetwork?: boolean;
  captureErrors?: boolean;
  captureHeaders?: boolean;
  /** Extra header names (beyond the always-on built-in deny-list) whose
   *  values are masked before events leave the browser. */
  redactHeaderNames?: string[];
  maxBodyBytes?: number;
  /** Rewrite or drop a captured request/response body before it leaves the
   *  browser — return a sanitized string, or null to drop the body entirely.
   *  Zero overhead when unset. Runs in addition to server-side redaction. */
  sanitizeBody?: (info: {
    url: string;
    direction: "request" | "response";
    body: string;
  }) => string | null | undefined;
  /** Capture per-resource timing (images, scripts, css, fonts) via the
   *  Resource Timing API. Default on. This is the highest-volume perf
   *  channel — raise `resourceMinDurationMs` to trim it at scale. */
  captureResourceTimings?: boolean;
  /** Skip resource-timing entries faster than this many ms. Default 0
   *  (capture all, matching the reference). Set e.g. 50 to record only
   *  resources slow enough to matter and cut event volume sharply. */
  resourceMinDurationMs?: number;
  sdk?: Partial<ReplaySdkDescriptor>;
  beforeSend?: (event: WebReplayEventContext) => WebReplayEventContext | null;
  fetchImpl?: typeof fetch;
  /** Don't start recording at all when the browser sends Do-Not-Track
   *  (navigator.doNotTrack === "1"). Off by default; opt in for strict privacy. */
  respectDoNotTrack?: boolean;
  /** Record <canvas> contents. Off by default (bandwidth); can also be enabled
   *  from remote config, but this lets a self-hosted/local caller force it. */
  recordCanvas?: boolean;
  /** Record nested CROSS-origin iframes (requires the SDK in the child frame).
   *  Off by default; host override for the remote-config flag. */
  recordCrossOriginIframes?: boolean;
  /** Mask email addresses inside visible text nodes in the replay. On by default
   *  (privacy floor); set false to keep raw text. */
  maskTextEmails?: boolean;
  /** Also mask long digit runs (≥5) in visible text (card/PII-looking numbers).
   *  Off by default (avoids masking order ids / counts). */
  maskTextNumbers?: boolean;
}

export interface WebReplayEventContext {
  envelope: ReplayBatchEnvelope;
}

export interface ReplayController {
  sessionId: string;
  stop: () => Promise<void>;
  flush: () => Promise<void>;
  identify: (
    distinctIdOrPayload: string | IdentifyPayload,
    props?: Omit<IdentifyPayload, "distinctId">,
  ) => void;
  /**
   * Fire a custom event. Drives the "Event" step kind in funnels and
   * any future event-based filters. `properties` is optional metadata
   * — small enough to ride along in the next batch.
   *
   * Example:
   *   replay.track("checkout_started");
   *   replay.track("plan_upgraded", { from: "free", to: "pro" });
   *
   * Event names should be stable identifiers (snake_case or
   * camelCase, no spaces) so they're searchable in funnels.
   */
  track: (name: string, properties?: Record<string, unknown>) => void;
  /**
   * Report a developer-caught exception on the session timeline. Emits the same
   * error event the automatic window handlers emit — so a handled error is
   * first-class in the dashboard's issues — parsed identically (name / message /
   * stack / frames). `opts.handled` defaults to true; pass false to record it as
   * an unhandled/fatal error.
   *
   * Example:
   *   try { risky(); } catch (e) { replay.captureException(e); }
   */
  captureException: (
    error: unknown,
    opts?: { handled?: boolean; metadata?: Record<string, unknown> },
  ) => void;
  /**
   * Supply your OWN anonymous/device id (e.g. an app-side visitor id) to override
   * the SDK's generated one, so the same person is one anonymous user across your
   * systems. Persists across reloads. Call before or early in the session.
   */
  setAnonymousId: (id: string) => void;
  /**
   * Attach an arbitrary session-level trait (key/value), independent of user
   * identity — e.g. `replay.setMetadata("plan", "pro")`. Survives reloads within
   * the tab and ships with every batch. Unlike identify()'s customProps it needs
   * no distinctId.
   */
  setMetadata: (key: string, value: string) => void;
}

export type { IdentifyPayload };
