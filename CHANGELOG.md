# Changelog

All notable changes to `@replayfyapp/browser` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.13]

### Added

- **Async, non-blocking install loader.** The browser bundle now supports the
  recommended async install snippet: a small inline stub queues `init` /
  `identify` / `track` / `captureException` / `flush` / `stop` calls made before
  the bundle finishes downloading, and the bundle replays that queue (in order,
  `init` first) as soon as it arrives. This lets the script be loaded with
  `async` so it never blocks page render, while still supporting the "call
  `Replayfy.init()` immediately" pattern. Fully backward-compatible: with no stub
  queue present (the previous synchronous two-tag snippet), there is nothing to
  replay and behavior is unchanged.

### Changed

- The recommended install snippet now loads the bundle with `async` and
  `crossorigin="anonymous"`. `crossorigin` lets the browser surface a full error
  stack trace to the SDK instead of an opaque `"Script error."` for uncaught
  errors thrown from the cross-origin bundle (the CDN sends the matching
  `Access-Control-Allow-Origin` header).

## [0.1.9]

### Fixed

- The unload beacon (`navigator.sendBeacon`) now sends its body as a `text/plain`
  Blob instead of `application/json`. `application/json` is not a CORS-safelisted
  content type, so cross-origin beacons were being preflighted — and `sendBeacon`
  cannot perform a preflight, so the browser blocked them and each session's final
  tail batch was dropped. `text/plain` is safelisted, so the beacon now delivers
  without a preflight. (The ingest endpoint parses the `text/plain` body as JSON.)

## [0.1.3]

### Changed

- Relicensed under BSD-3-Clause (was MIT).

## [0.1.1]

### Changed

- Metadata-only release: tidied the published `keywords`. No API or behavior
  changes.

## [0.1.0]

Initial public release.

### Added

- Session replay for the browser with high-fidelity DOM playback.
- Product analytics: `identify` and `track` for users and custom events.
- Error monitoring: automatic capture of unhandled errors and promise
  rejections, plus `captureException` for handled errors.
- Console and network (fetch/XHR) capture on the session timeline.
- Core Web Vitals, long-task, and resource-timing capture.
- Rage- and dead-click detection.
- Privacy controls: input masking by default, text/element masking selectors,
  URL redaction, header redaction, and a `beforeSend` hook.
- Two distribution targets: ESM/CJS package for bundlers and a self-contained
  `<script>` bundle exposing the `Replayfy` global.
