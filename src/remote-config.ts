import type { WebReplayConfig } from "./types";

/**
 * Shape of /v1/sdk/config. Mirrors the server's `SdkConfigResponse` —
 * keep in sync when you add fields on either side.
 */
export interface SdkRemoteConfig {
  workspaceId: number;
  capture: {
    console: boolean;
    network: boolean;
    networkHeaders: boolean;
    networkBodies: boolean;
    errors: boolean;
    headers: boolean; // legacy alias for networkHeaders
    canvas: boolean;
    iframe: boolean;
    performance: boolean;
    autoplayNext: boolean;
    minDurationMs: number;
    trigger: "always" | "identified" | "sample";
  };
  privacy: {
    maskAllInputs: boolean;
    maskSelectors: string[];
    maskInputTypes: string[];
    blockSelectors: string[];
    redactUrlPatterns: string[];
    blockCreditCardText: boolean;
    stripQueryParams: boolean;
    allowedQueryParams: string[];
    allowedHosts: string[];
  };
  sampling: {
    rate: number;
    alwaysRecordErrors: boolean;
    alwaysRecordIdentified: boolean;
    alwaysRecordOnUrls: string[];
  };
  retentionDays: number;
}

interface ApiOk<T> {
  ok: true;
  data: T;
}
interface ApiErr {
  ok: false;
  error: { message: string };
}

export async function fetchRemoteConfig(
  config: WebReplayConfig,
): Promise<SdkRemoteConfig | null> {
  try {
    const fetchImpl = config.fetchImpl ?? window.fetch.bind(window);
    const url = new URL("/v1/sdk/config", config.apiHost).toString();
    const r = await fetchImpl(url, {
      headers: { "x-replay-api-key": config.apiKey },
    });
    if (!r.ok) return null;
    const body = (await r.json()) as ApiOk<SdkRemoteConfig> | ApiErr;
    if (!body.ok) return null;
    return body.data;
  } catch {
    return null;
  }
}
