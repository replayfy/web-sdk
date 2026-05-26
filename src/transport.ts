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

export function createBatchSender(config: WebReplayConfig): BatchSender {
  const endpoint = new URL("/v1/replay/batch", config.apiHost).toString();
  const fetchImpl = config.fetchImpl ?? window.fetch.bind(window);
  let currentIdentify: IdentifyPayload | undefined;

  let currentFingerprint: string | undefined;
  const send: BatchSender = async (
    envelope: ReplayBatchEnvelope,
    useBeacon = false,
  ): Promise<void> => {
    const body = JSON.stringify({
      envelope,
      identify: currentIdentify,
      fingerprint: currentFingerprint,
    });

    if (useBeacon && "sendBeacon" in navigator) {
      // sendBeacon ignores custom headers; include the API key in a query param fallback.
      const url = `${endpoint}?${new URLSearchParams({ k: config.apiKey }).toString()}`;
      navigator.sendBeacon(url, new Blob([body], { type: "application/json" }));
      return;
    }

    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-replay-api-key": config.apiKey,
      },
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
