export type ReplayPlatform =
  | "web"
  | "react"
  | "nextjs"
  | "react_native"
  | "android"
  | "ios";

export type ReplayEventType =
  | "session_start"
  | "session_end"
  | "full_snapshot"
  | "incremental_snapshot"
  | "input"
  | "pointer"
  | "scroll"
  | "viewport"
  | "navigation"
  | "console"
  | "network"
  | "error"
  | "performance"
  | "custom"
  // Native (iOS / Android / Flutter / RN) only. Web SDK never emits these.
  | "tap"
  | "native_snapshot";

export interface ReplayBatchEnvelope {
  projectId?: string;
  sessionId: string;
  segmentId: string;
  sequence: number;
  sentAt: number;
  sdk: ReplaySdkDescriptor;
  page: ReplayPageContext;
  events: ReplayEvent[];
}

export interface ReplaySdkDescriptor {
  name: string;
  version: string;
  platform: ReplayPlatform;
}

export interface ReplayPageContext {
  url: string;
  title?: string;
  referrer?: string;
  userAgent: string;
  viewport: ViewportDimensions;
  timezone?: string;
  language?: string;
  screen?: ViewportDimensions;
}

export interface ViewportDimensions {
  width: number;
  height: number;
}

export interface ReplayEvent<TData = unknown> {
  id: string;
  ts: number;
  offsetMs: number;
  type: ReplayEventType;
  source: ReplayPlatform;
  data: TData;
}

export interface SessionStartEventData {
  href: string;
  path: string;
  referrer: string;
}

export interface SessionEndEventData {
  reason: "manual" | "unload" | "visibility_hidden";
}

export interface SnapshotEventData {
  recorder: "rrweb";
  rrwebEvent: unknown;
}

export interface ConsoleEventData {
  level: "log" | "info" | "warn" | "error" | "debug";
  message: string;
  args: unknown[];
  stack?: string;
}

export interface NetworkEventData {
  requestId: string;
  transport: "fetch" | "xhr";
  method: string;
  url: string;
  statusCode?: number;
  startedAt: number;
  endedAt?: number;
  durationMs?: number;
  ok?: boolean;
  requestHeaders?: Record<string, string>;
  responseHeaders?: Record<string, string>;
  requestBody?: string;
  responseBody?: string;
  error?: string;
  /** navigator.connection.rtt at the time of the request. */
  connectionRtt?: number;
  /** navigator.connection.effectiveType ("4g", "3g", "slow-2g"…). */
  connectionEffectiveType?: string;
}

export interface ErrorEventData {
  message: string;
  stack?: string;
  kind: "error" | "unhandledrejection";
}

export interface NavigationEventData {
  from?: string;
  to: string;
  // On web: history-stack triggers. On native: app-routing triggers.
  trigger:
    | "pushState"
    | "replaceState"
    | "popstate"
    | "hashchange"
    | "load"
    | "screen_appeared"
    | "screen_dismissed"
    | "deep_link";
}

/**
 * One captured tap/gesture on a native (iOS/Android/Flutter/RN) screen.
 *
 * Carries the metadata the player needs to render a tap marker AND
 * the widget identity for heatmaps / funnels. `uiId` is a stable hash
 * of `route + class + value` (djb2) so taps on the same logical button
 * across millions of sessions collapse to one bucket.
 *
 * Sensitive views (any ancestor marked occluded) ship with blanked
 * `uiValue`/`uiId`/`uiClass` and `isSensitive: true` — the dashboard
 * still shows that a tap happened, just not what was on the button.
 */
export interface TapEventData {
  // Pixel bounds of the tapped widget at tap time (logical px, not raw).
  bounds: { x: number; y: number; w: number; h: number };
  // Touch coordinates within the screen (logical px). For multi-touch
  // we only capture the first pointer — gestures (swipe/pinch) come
  // through `custom` events with `kind: "gesture"`.
  point: { x: number; y: number };
  // Current screen identity (Activity name / UIViewController name /
  // Navigator route). Same value `navigation.to` would carry.
  route: string;
  // Semantic widget class: "Button" | "TextField" | "Text" | "Image"
  // | "ScrollView" | "Switch" | "Slider" | "Container" | "Unknown".
  // Platform-neutral — both Android `Button` and iOS `UIButton` map
  // to "Button" so dashboard rendering doesn't fork by platform.
  uiClass: string;
  // Semantic type bucket — used by heatmap aggregation and funnels.
  uiType:
    | "button"
    | "field"
    | "compound"
    | "text"
    | "image"
    | "container"
    | "unknown";
  // Extracted value: button label / image asset name / field hint
  // (NEVER the field's actual content — that's a privacy violation).
  uiValue: string;
  // djb2 hash of `route#uiClass#uiValue`. Drives heatmap bucketing.
  uiId: string;
  // True if any ancestor view was marked occluded — uiValue/uiId/
  // uiClass will be blanked in that case.
  isSensitive: boolean;
}

/**
 * View-tree snapshot emitted on screen transition or after a 500ms
 * idle. NOT every frame — the dashboard renders interpolated playback
 * from `tap` events plus these sparse snapshots, the same way UXCam
 * does (orders of magnitude smaller than rrweb's frame-diff stream).
 *
 * `nodes` is the rendered view tree, depth-first. Image-heavy nodes
 * carry an `imageRef` (hash); the actual bytes are uploaded
 * out-of-band via the snapshot-asset endpoint and the player resolves
 * the ref at playback time.
 */
export interface NativeSnapshotEventData {
  recorder: "native";
  // Logical-px dimensions of the captured root.
  width: number;
  height: number;
  // Device pixel ratio — needed for crisp playback on the dashboard.
  pixelRatio: number;
  // Trigger so the player can choose to render this snapshot eagerly
  // (screen transition) vs lazily (idle).
  trigger: "screen_appeared" | "idle" | "tap" | "manual";
  // Root view node.
  root: NativeViewNode;
}

/**
 * Recursive view-tree node. Identical shape across iOS UIView,
 * Android View, Flutter Widget — the SDK serializes its native tree
 * into this shape so the player has ONE renderer.
 *
 * Keep this lean — at 10k views per screen, every extra field
 * multiplies payload size.
 */
export interface NativeViewNode {
  // Stable per-snapshot id (sibling-index path). Used for
  // tap-to-node linking and for diffing consecutive snapshots in
  // future incremental support.
  id: string;
  // Same taxonomy as TapEventData.uiType.
  type:
    | "button"
    | "field"
    | "compound"
    | "text"
    | "image"
    | "container"
    | "unknown";
  // Native class name for debugging (e.g. "UIButton", "ElevatedButton",
  // "MaterialButton"). Player ignores it; tooling uses it.
  className?: string;
  // Pixel bounds relative to parent.
  bounds: { x: number; y: number; w: number; h: number };
  // Visible text content if any (already redacted for occluded nodes).
  text?: string;
  // Image asset reference — content-addressed hash. Player fetches
  // bytes from `/v1/replay/assets/{ref}` at render time.
  imageRef?: string;
  // RGBA hex if the node has a solid backgroundColor (no gradient,
  // no image). Player falls back to transparent if absent.
  backgroundColor?: string;
  // 0..1 alpha multiplier.
  opacity?: number;
  // Flag: this node (or any ancestor) is occluded. Player paints the
  // occlusion overlay over it at render time.
  occluded?: boolean;
  // Accessibility label, when present. Useful for tooltip/aria
  // playback and for blind-user session inspection.
  ariaLabel?: string;
  // Children in render order (back-to-front).
  children?: NativeViewNode[];
}

/**
 * Performance metrics — web and native both ship as `performance`
 * events. Metric NAMES differ by platform; the envelope is identical.
 *
 * Web metrics: lcp, cls, inp, fcp, ttfb, longtask, memory
 * Native metrics: cold_start_ms, time_to_first_meaningful_render_ms,
 *   tap_response_ms, first_network_ttfb_ms, frozen_frame_count,
 *   memory_rss_mb, anr_count, frame_drop_pct, thermal_state,
 *   battery_drain_pct_per_min
 *
 * Rating thresholds and capture cadence are documented in
 * docs/mobile-vitals-matrix.md.
 */
export interface PerformanceEventData {
  // Stable identifier — used as DB column key for the perf rollup.
  metric: string;
  // Numeric value in the unit below.
  value: number;
  // "ms" | "mb" | "pct" | "count" | "" (unitless e.g. CLS, thermal).
  unit: string;
  // web.dev-style threshold tier, computed at SDK side using the
  // matrix doc cutoffs so the dashboard renders consistently.
  rating?: "good" | "needs-improvement" | "poor";
  // Optional secondary tag — e.g. for ANR, which event triggered it.
  kind?: string;
}

export interface ViewportEventData {
  width: number;
  height: number;
}

export interface ReplayPrivacyConfig {
  maskAllInputs?: boolean;
  maskTextSelector?: string;
  blockSelector?: string;
  redactUrls?: Array<string | RegExp>;
  captureRequestHeaders?: boolean;
  captureResponseHeaders?: boolean;
}

export interface ReplayIngestResponse {
  accepted: boolean;
  acceptedSequence: number;
  sessionId: string;
}

export interface ReplaySessionSummary {
  sessionId: string;
  projectId?: string;
  platform: ReplayPlatform;
  sdkName: string;
  sdkVersion: string;
  startedAt: number;
  endedAt: number;
  eventCount: number;
  pageUrl: string;
  distinctId?: string;
  status?: "LIVE" | "COMPLETED";
  durationMs?: number;
}

export interface ReplaySessionDetail extends ReplaySessionSummary {
  segments: ReplaySegmentSummary[];
}

export interface ReplayProjectSummary {
  id: string;
  slug: string;
  name: string;
  retentionDays: number;
  samplingRate: number;
  createdAt: string;
  sessionsLast24h: number;
  apiKeys: ReplayApiKeySummary[];
}

export interface ReplayApiKeySummary {
  id: string;
  label: string;
  prefix: string;
  createdAt: string;
  revokedAt?: string;
  lastUsed?: string;
}

export interface ReplayProjectionLogRow {
  sessionId: string;
  projectId: string;
  sequence: number;
  eventId: string;
  eventType: ReplayEventType;
  timestamp: number;
  offsetMs: number;
  kind: "console" | "network" | "error";
  level?: string;
  message?: string;
  method?: string;
  url?: string;
  statusCode?: number;
  durationMs?: number;
  error?: string;
  stack?: string;
}

export interface ReplaySegmentSummary {
  sessionId: string;
  segmentId: string;
  sequence: number;
  eventCount: number;
  storageKey: string;
  startedAt: number;
  endedAt: number;
}
