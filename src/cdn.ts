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
