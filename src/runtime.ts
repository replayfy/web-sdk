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
  sdk: ReplaySdkDescriptor;
  makeEventId: () => string;
  push: (event: ReplayEvent) => void;
  drain: () => ReplayEvent[];
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

export function createSessionRuntime(config: WebReplayConfig): SessionRuntime {
  const startedAt = Date.now();
  const sessionId = config.sessionId ?? shortId("ses_");
  const segmentId = shortId("seg_");
  const buffer: ReplayEvent[] = [];
  let sequence = 0;
  let timer: number | undefined;

  const sdk: ReplaySdkDescriptor = {
    name: config.sdk?.name ?? "@replay/web-sdk",
    version: config.sdk?.version ?? "0.1.0",
    platform: config.sdk?.platform ?? "web",
  };

  return {
    sessionId,
    segmentId,
    startedAt,
    sdk,
    makeEventId: () => globalThis.crypto.randomUUID(),
    push: (event) => {
      buffer.push(event);
    },
    drain: () => buffer.splice(0, buffer.length),
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
