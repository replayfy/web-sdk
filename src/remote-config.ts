import type { WebReplayConfig } from "./types";

/**
 * Shape of /v1/sdk/config. Mirrors the server's `SdkConfigResponse` —
 * keep in sync when you add fields on either side.
 */
export interface SdkRemoteConfig {
  workspaceId: number;
  /** The workspace has spent its plan's session allowance — do not record or
   *  upload anything. A hard gate that beats every "always record" override. */
  shouldNotRecord?: boolean;
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
    /** Dashboard force: true masks every input value. It can only add
     *  masking; false leaves the app's own maskAllInputs (default true). */
    maskAllInputs: boolean;
    /** Combined with the host's maskTextSelector (both apply). */
    maskSelectors: string[];
    /** Input types always masked, whatever maskAllInputs says. */
    maskInputTypes: string[];
    /** Combined with the host's blockSelector; invalid entries are dropped. */
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

/** One request for the config: the config, no config for this key (a
 *  definitive answer: a 4xx other than 408/429, or an error body), or a failure
 *  worth asking again (offline, a dropped or aborted request, a timeout, 408,
 *  429, 5xx, a body that isn't JSON). */
export type RemoteConfigResult =
  | { kind: "ok"; config: SdkRemoteConfig }
  | { kind: "none" }
  | { kind: "retry" };

export async function requestRemoteConfig(
  config: WebReplayConfig,
): Promise<RemoteConfigResult> {
  try {
    const fetchImpl = config.fetchImpl ?? window.fetch.bind(window);
    const url = new URL("/v1/sdk/config", config.apiHost).toString();
    const r = await fetchImpl(url, {
      headers: { "x-replay-api-key": config.apiKey },
    });
    if (!r.ok) {
      return r.status === 408 || r.status === 429 || r.status >= 500
        ? { kind: "retry" }
        : { kind: "none" };
    }
    const body = (await r.json()) as ApiOk<SdkRemoteConfig> | ApiErr;
    if (!body.ok) return { kind: "none" };
    return { kind: "ok", config: body.data };
  } catch {
    return { kind: "retry" };
  }
}
