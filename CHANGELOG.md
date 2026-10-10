# Changelog

All notable changes to `@replayfyapp/browser` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- **Page loads in one session no longer reuse batch numbers.** A reload or a
  same-tab navigation continues the tab's session, but each page load
  restarted its batch `sequence` at 1. Servers that key batches on
  `(sessionId, sequence)` then silently dropped the later page's first batches
  (its full snapshot included) or overwrote the earlier page's. The SDK now
  keeps a tab-wide batch counter in sessionStorage (`replay:sq`) and continues
  it on every page load, including after an inactivity rotation and for a
  host-supplied `sessionId`. A tab whose session began on 0.1.16 has no counter
  yet, so its first page load after the upgrade starts at 1 again; servers need
  per-page-load (segment) batch keys to keep that load, so upgrade a
  self-hosted server before, or together with, this SDK.
- **An unusable `config.sessionId` is ignored with a warning** (not a string,
  over 2000 UTF-8 bytes, or containing control characters) instead of being
  sent: the ingest rejects such ids, so every batch would fail.
- **`beforeSend` now runs on the hide/unload batch too.** That batch used to
  skip the hook, so data a host scrubs or drops in `beforeSend` left the
  browser on every tab switch and page close. A hook that throws or returns a
  Promise now drops the batch (fail closed) instead of sending it unscrubbed.
- **Sampled-out and blocked sessions no longer upload on hide/close.** The
  unload path skipped the sampling and plan-cap checks, so every tab switch of
  a sampled-out visitor created a snapshot-less session (counted against the
  plan). `excludeUrls` also applies now when the remote config can't be
  fetched.
- **`session_end` is sent once, when the page really goes away.** Each close
  sent up to three, and every tab switch ended the session mid-visit
  (`visibility_hidden`). Hiding a tab now ships its buffered events without
  ending the session; a page entering the back/forward cache doesn't end it
  either. The `beforeunload` listener is gone (it can be cancelled, and it kept
  pages out of the back/forward cache in some browsers).
- **Pages restored from the back/forward cache are recorded correctly.** The
  restored page continued its old segment with no new base snapshot, so the
  replay applied its changes to the DOM of the page shown in between. A restore
  now starts a new segment with a page view and a fresh full snapshot (and a
  new session if the inactivity window passed).
- **Uploads in flight survive navigation.** Small batches are sent with
  `keepalive`; a regular upload still pending when the page goes away is
  re-sent once on `pagehide` (same bytes and sequence, which the server
  dedupes). The unload batch is now one request sized to the browser's 64 KiB
  keepalive/beacon allowance (the SDK keeps to 48 KiB so the page's own beacons
  still fit), measured in real UTF-8 bytes, carrying the session end, errors and
  page views first; several 55 KB chunks at once got all but the first
  rejected.
- **Rejected uploads are no longer retried forever.** A bad or revoked key
  (401), an origin outside the allow-list (403) or a workspace over its plan
  (`accepted:false`) stops recording for the rest of the page after one
  request; a malformed batch (400/413) is dropped, and three in a row stop
  recording; server errors back off (up to 60 s) instead of resending every
  flush.
- **A failed upload from before an inactivity rotation no longer lands in the
  new session** (it was requeued under the new session id), and the stored
  identity follows the new session id.
- **A reload is one page view, not two** (the resumed page emitted its own
  `navigation` event besides the navigation capture's).
- **The real SDK name and version are reported** (`@replayfyapp/browser` and
  the package version, instead of `@replay/web-sdk` / `0.1.0`).
- **Credential-style query parameters** (token, jwt, password, …) are masked in
  every batch's page URL and referrer, as they already were in events.
- A session switched back on by always-record-errors / identified-users takes a
  fresh full snapshot, so its replay doesn't wait for the next checkout.

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
