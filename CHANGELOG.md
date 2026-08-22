# Changelog

All notable changes to `@replayfyapp/browser` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.16]

### Fixed

- **Click labels resolve to real text, never a CSS selector.** `targetLabel()`
  now derives human text — aria-label, aria-labelledby, an associated
  `<label>` / placeholder, submit value, `<select>` option, innerText, a
  descendant `<img alt>`, else a generic role word — and never returns an empty
  label or a selector. The funnel's element "Text" stops falling back to
  `body > header > …`. A `<button name="…">` now yields its visible text
  instead of the `name`. Container / body / padding clicks no longer emit a
  semantic click at all (rage/dead detection still runs on any click).

### Added

- **`urlForCurrentSession()`** on the controller — the dashboard link for the
  live session (`<app-host>/recordings/<id>`).
- **`excludeUrls`** config — a path-glob deny-list; a matching page records and
  ships nothing.

## [0.1.15]

### Fixed

- **Collision-resistant session / segment ids.** Ids were minted purely from
  `crypto.getRandomValues`, which a hostile or headless client can stub to return
  constant bytes — a crawler did exactly that and produced the _same_ `ses_` /
  `seg_` id on two different sites. The generator now also folds in a
  high-resolution timestamp, a per-page monotonic counter, and `Math.random` (a
  separate PRNG), and prefers `crypto.randomUUID` when present, so two distinct
  sessions can no longer land on the same id even with a degenerate RNG. Ids are
  now longer and remain opaque strings — no consumer change required.

## [0.1.14]

### Added

- **Live inactivity session boundary.** An open tab whose user has gone idle now
  ends its session after `sessionInactivityMs` of no _meaningful_ activity
  (default 30 min) and starts a fresh session when the user returns. "Meaningful"
  activity means genuine engagement — pointer / keyboard / scroll / touch
  interactions, real navigations, and `track` / `identify` / `captureException` —
  and pointedly _not_ background noise such as network polling, performance
  entries, console output, or DOM re-renders. This stops a tab that is merely
  left open (still making background requests) from inflating one session for
  hours. On idle it emits a `session_end` event with `reason: "inactivity"`; on
  the user's return it rotates to a new session id and emits a fresh
  `session_start` (with a new full snapshot). Governed by the existing
  `sessionInactivityMs` config — set it to `0` to disable the live idle end.

### Note

- This is a session-analytics behavior change: expect more, shorter, and more
  accurate sessions (a tab idle for hours no longer counts as one long session),
  which shifts average-session-duration and session-count metrics accordingly.

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
