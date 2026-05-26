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
  | "custom";

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
  trigger: "pushState" | "replaceState" | "popstate" | "hashchange" | "load";
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
