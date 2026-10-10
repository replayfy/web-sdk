// Injected at build time by tsup (`define`, from package.json), so every batch
// reports the real package and version. A bundle built without the define (an
// ad-hoc test build) falls back to "0.0.0-dev" instead of throwing.
declare const __REPLAY_SDK_VERSION__: string | undefined;

export const SDK_NAME = "@replayfyapp/browser";
export const SDK_VERSION: string =
  typeof __REPLAY_SDK_VERSION__ === "string" ? __REPLAY_SDK_VERSION__ : "0.0.0-dev";
