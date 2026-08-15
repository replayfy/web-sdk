/**
 * CDN / <script> entry — the browser global surface published to
 * https://cdn.replayfy.app. Bundled as a single self-contained IIFE that
 * assigns the global `Replayfy`, so a site can start recording with no build
 * step:
 *
 *   <script src="https://cdn.replayfy.app/v1/replay.global.js"></script>
 *   <script>
 *     Replayfy.init({ apiKey: "pk_live_…", apiHost: "https://us.replayfy.app" });
 *   </script>
 *
 * The convenience passthroughs (identify / track / captureException / flush /
 * stop) forward to the controller returned by init(), so callers using the
 * global never have to hold a reference. For bundler/npm consumers use the
 * package entry (`initReplay`) instead — this module only exists to shape the
 * script-tag global.
 */
import { initReplay } from "./initReplay";
import type { ReplayController, WebReplayConfig } from "./types";

// ── Async-loader queue capture ───────────────────────────────────────────────
// The recommended install snippet loads this bundle with `async` (so it never
// blocks page render) and, until it arrives, stands up a tiny stub:
// `window.Replayfy = []` whose init/identify/track/… just push `[method, …args]`
// onto the array. Grab that queue NOW, while `window.Replayfy` is still the stub
// (tsup's `globalName` re-assigns it to the real API only AFTER this module body
// returns), then replay it below once the real functions exist. A plain
// (non-async, no-stub) load finds no array here and this is a no-op.
const queuedCalls: unknown[] =
  typeof window !== "undefined" &&
  Array.isArray((window as { Replayfy?: unknown }).Replayfy)
    ? ((window as { Replayfy?: unknown }).Replayfy as unknown[]).slice()
    : [];

let controller: ReplayController | undefined;

/** Start recording. Idempotent — repeat calls return the live controller
 *  rather than opening a second session. */
function init(config: WebReplayConfig): ReplayController {
  if (!controller) controller = initReplay(config);
  return controller;
}

function active(method: string): ReplayController {
  if (!controller) {
    throw new Error(`Replayfy.${method}() called before Replayfy.init()`);
  }
  return controller;
}

// Passthroughs typed off the controller so they never drift from its API.
const identify = (...args: Parameters<ReplayController["identify"]>): void =>
  active("identify").identify(...args);
const track = (...args: Parameters<ReplayController["track"]>): void =>
  active("track").track(...args);
const captureException = (
  ...args: Parameters<ReplayController["captureException"]>
): void => active("captureException").captureException(...args);
const flush = (): Promise<void> => active("flush").flush();
const stop = (): Promise<void> => active("stop").stop();

/** The live controller, or undefined before init(). */
const getController = (): ReplayController | undefined => controller;

// Replay whatever the async-loader stub queued before this bundle arrived,
// straight against the real implementations above — no need to wait for tsup's
// `globalName` to swap `window.Replayfy` over, since these ARE the functions it
// will expose.
if (queuedCalls.length) {
  const dispatch = { init, identify, track, captureException, flush, stop } as unknown as Record<
    string,
    ((...args: unknown[]) => unknown) | undefined
  >;
  // Drain init() first, whatever order the calls were queued in, so a consumer
  // that queues e.g. track() behind a consent gate BEFORE init() doesn't
  // silently lose it (identify/track/captureException throw before init()).
  // Everything else keeps its queued order; malformed entries are skipped.
  const valid = queuedCalls.filter(
    (e): e is [string, ...unknown[]] => Array.isArray(e) && e.length > 0,
  );
  const ordered = [
    ...valid.filter((e) => e[0] === "init"),
    ...valid.filter((e) => e[0] !== "init"),
  ];
  for (const [method, ...args] of ordered) {
    try {
      // Swallow both synchronous throws AND rejected promises (flush/stop
      // return promises) so one bad queued call can neither abort the rest nor
      // surface as a page-level unhandledrejection.
      const out = dispatch[method]?.(...args);
      if (out && typeof (out as { then?: unknown }).then === "function") {
        (out as Promise<unknown>).catch(() => {});
      }
    } catch {
      /* one bad queued call shouldn't take down the others */
    }
  }
}

export {
  init,
  initReplay,
  identify,
  track,
  captureException,
  flush,
  stop,
  getController,
};
export type { ReplayController, WebReplayConfig };
