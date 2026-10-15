# Changelog

All notable changes to `@replayfyapp/browser` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.20] - 2026-10-14

Text and input masking now follow the usual session-replay defaults. Replays
look different where they used to show private data: more `*`, and lines of
masked text can wrap differently, since `*` is not as wide as the letters it
replaces.

### Fixed

- **Private regions are private again.** Text inside a mask selector
  (`maskTextSelector`, the workspace's mask selectors, `.rr-mask`) only had its
  email addresses masked; everything else in it was sent as plain text,
  because the default email masking replaced the recorder's own masking. It is
  now replaced by `*` at the same length, spaces kept.
- **Email addresses in page text are masked.** The email mask only ever ran
  inside mask selectors, so emails anywhere else were recorded as shown. Every
  email address in page text is now masked at the same length, keeping `@` and
  the dots between domain labels (`jane.doe@example.com` →
  `********@*******.***`); the `[email]` placeholder is gone. Opt out with
  `maskTextEmails: false`.
- **The dashboard can no longer unmask inputs.** The workspace's "mask all
  inputs" setting (off by default) replaced the SDK's `maskAllInputs` default,
  so most pages recorded what users typed. The app's `maskAllInputs` (default
  `true`) now decides, and the dashboard can only force masking on: every
  input, textarea and select value is `*`-masked unless the app sets
  `maskAllInputs: false`.
- **Hidden and file inputs are no longer recorded raw.** Their values (CSRF
  tokens, prefilled emails, `C:\fakepath\` file names) skipped masking
  entirely. Hidden, file, url, color, month, week, datetime-local and image
  inputs now send no value, whatever `maskAllInputs` says.
- **A cleared field no longer shows its old value.** A prefilled field the
  user emptied was recorded with its original HTML value, unmasked.
- **Passwords send nothing.** A password field, including one a "show
  password" toggle switched to text, records an empty value: no characters and
  no length. Changes to its `value` attribute (one per keystroke in
  frameworks that keep it in sync) are not recorded, so neither is its
  typing rhythm.
- **An invalid block selector no longer freezes the replay.** The recorder
  threw on every DOM change and the replay stopped at its first snapshot. Each
  host and workspace block selector is now checked, and one the browser can't
  parse is ignored with a console warning.
- **A selector that leaves a quote, bracket or paren open counts as invalid.**
  `[data-x="a` parses on its own, but joined with the other selectors it
  swallowed them, so `[data-private]`, `.sensitive` and `.rr-mask` text was
  recorded as shown (and blocked elements were recorded) with no warning. As a
  mask selector it now makes the whole page private; as a block selector it is
  ignored. Both log a console warning.
- **CSS is never altered.** Masking inside a private region could rewrite
  `<style>` text (`url(icon@2x.png)`, `@media`) and break the replay's styling.
- **Text directly under a shadow root** follows its host: wiped under a
  private host, email-masked otherwise. Changes to it were sent raw.
- **Click labels** (rage and dead clicks, heatmaps) are masked like page text:
  wiped when the clicked element, its label or anything inside it is private,
  emails masked otherwise. A `<select>` is no longer labelled with the option
  the user chose, and a field's label no longer includes the content of a
  `<textarea>` or `<select>` inside it. Clicks before the replay starts already
  use the workspace's last-seen mask selectors, or the server's defaults.
- **URL redaction patterns hide the value, everywhere in the URL.** A
  workspace pattern such as `token=` replaced only its first match and only
  the text `token=` itself, so the value after it was still stored. Every
  match is now redacted, and a pattern ending in `=` also hides the value up
  to the next `&` or `#`. A pattern that is not a valid regular expression is
  skipped with a console warning; before, it stopped every dashboard privacy
  setting from applying on the page.
- **The workspace's URL patterns now apply.** The network capture is set up
  before the dashboard config arrives and kept only the app's `redactUrls`,
  so the workspace's patterns never reached a request URL. They now apply
  live, together with the app's (both, neither replaces the other).
- **Resource timings are redacted like request URLs.** Performance events
  named each loaded resource by its full URL, so a token the network capture
  hid (built-in keys such as `token=`, or a pattern) was still stored there.
- **The replay's page URL is scrubbed.** rrweb's meta event carried the page
  URL as is (`?token=…`); it now gets the built-in key scrub every other
  stored page URL gets.
- **The page title is masked like page text.** `session_start`, navigation
  events and every batch sent `document.title` as is, so an address in the
  title (`Inbox – jane.doe@example.com`) was recorded in full.
- **The first page view waits for the workspace's privacy rules.** When the
  dashboard settings were slower than the 300 ms start-up race on a first
  visit (no rules remembered yet), the replay's first snapshot was uploaded
  with text inside the workspace's mask selectors (`[data-private]`,
  `.sensitive`, or custom ones) readable, with the click labels and request
  URLs recorded before the settings arrived. Also in 0.1.19. Until the
  settings arrive, a page now records under the server's defaults (or the
  remembered rules) and uploads nothing, for up to 4 s. If the workspace's
  rules hide more, what was recorded is dropped and the replay starts at a
  fresh snapshot taken under them; request and resource URLs and page titles
  recorded meanwhile get the workspace's rules. A page closed before the
  settings arrive sends no replay. Without settings (offline, an error) the
  defaults stay.

### Changed

- **Opting out keeps a floor.** With `maskAllInputs: false`, values that look
  like an email (`type="email"` or containing `@`), values with 4 or more
  digits in a row (except date inputs), values inside a private region and
  input types the workspace masks are still masked. The new `maskInputEmails`
  and `maskInputNumbers` options (default `true`) turn off the first two.
- **`maskTextNumbers` turns every digit into `0`**, keeping the length. It
  used to replace runs of 5 or more digits with up to 12 `•`.
- **Images, canvases, videos and iframes inside a private region** are
  recorded as placeholders of the same size, including inside a private
  element's shadow root and on browsers without `:is()`. A blocked or private
  iframe's document is no longer recorded, nor is anything that later changes
  or is typed or clicked inside it.
- **A textarea's default text is masked like its value.**
- **Host and dashboard selectors are combined.** The workspace's mask and
  block selectors used to replace the `maskTextSelector` / `blockSelector`
  passed to `init()` as soon as the dashboard settings arrived, so a host
  `.rpf-mask` stopped working. Both now apply.
- **An invalid mask selector masks all page text** (except CSS), with a
  console warning, instead of masking nothing. The whole page is then treated
  as private: input values are masked and media are placeholders too.
- **No longer recorded:** HTML comments, `<meta>` content (CSRF tokens and
  similar), and `href` on HTML elements other than stylesheet and font
  `<link>`s (`mailto:` and magic-link anchors replay without their target;
  canonical, alternate and icon links lose theirs). Script and `<noscript>`
  text, including SVG `<script>`, is replaced by `*`.
- **Late dashboard settings.** The last dashboard privacy settings, URL rules
  included, are kept in `localStorage` per ingest host and key, and a page
  whose settings are slower than the 300 ms start-up race records its first
  snapshot with them. They may be out of date, so that page uploads nothing
  until its settings confirm them (see Fixed). Settings that change mid-page
  still restart the recorder with a fresh snapshot.
- **rrweb is pinned to exactly `2.0.0-alpha.20`.** The `^2.0.0-alpha.18` range
  let npm consumers resolve other versions the masking was not checked
  against.

## [0.1.19]

### Fixed

- **A failed upload is retried under its own batch number.** When a batch
  failed all three attempts, its events were put back into the buffer and sent
  again with the next batch under a new `sequence`. If an attempt had reached
  the server and only the response was lost (a timeout, a proxy 504/524, a
  connection reset after the body was read), the server stored the same events
  twice under two numbers, and duplicate rrweb incrementals can break the
  replay. The failed batch is now kept whole and resent first, as it was sent:
  same segment, page and `sequence`, so the server can dedupe a copy that did
  land. Newer events go in later batches. A batch carried over from an earlier
  page load no longer loses its number when its send fails either.
- **A failed batch still waiting when the tab is hidden or closed still sends
  its errors.** At page close it goes in the unload request under its number
  if it fits, else to the next page load. If it doesn't fit, its errors,
  `track()` events and page views go in a request of their own under a new
  number, as they did in 0.1.18; the rest, its replay stream, keeps the
  failed batch's number. On a tab switch (a hidden page can be discarded with
  no further event) it goes the same way, as a copy under its number that is
  still retried, once per failed send however often the tab is switched.
- **What is sent never goes through `beforeSend` twice.** An upload still
  unfinished when the page went away was resent by the next page load through
  the hook again, on what the hook had already returned, so a hook that isn't
  idempotent (one that hashes a value, for example) changed it under a number
  the server might already hold. That batch, and now a retried one, goes out
  as the hook returned it; the hook is still called, on a copy, and can drop
  it by returning `null` (consent withdrawn, for example). A batch sent by a
  page with no hook still goes through the next page's hook. The hide/unload
  batch now hands the hook a copy too: a hook that edits events in place was
  applied again to the same events when that batch was retried smaller, or
  when it was refused and its events were sent later.
- **`stop()` waits for everything it sends.** If an upload failed while
  `stop()` was delivering what was left (a batch carried over from an earlier
  page load, or a failed batch waiting for its retry), `stop()` could resolve
  with the session end unsent, or send it after resolving.
- **The 20,000-event cap covers waiting batches too.** During a long outage it
  counts the batches waiting to be sent (a failed one, an earlier page load's
  leftovers) together with the buffer and drops the newest events beyond it.
  The oldest batch, which holds the base snapshot, is kept whole, and a batch
  already sent once is never cut (it is dropped whole), so a resend under its
  number is always the same batch.

### Changed

- The package declares the MIT license, matching its `LICENSE` file (it said
  BSD-3-Clause).

## [0.1.18]

### Fixed

- **Page loads in one session no longer reuse batch numbers.** A reload or a
  same-tab navigation continues the tab's session, but each page load
  restarted its batch `sequence` at 1. Servers that key batches on
  `(sessionId, sequence)` then silently dropped the later page's first batches
  (its full snapshot included) or overwrote the earlier page's. The SDK now
  keeps a tab-wide batch counter in sessionStorage (`replay:sq`) and continues
  it on every page load, including after an inactivity rotation and for a
  host-supplied `sessionId`. A tab whose session began on 0.1.17 or earlier
  has no counter yet, so its first page load after the upgrade starts at 1
  again and can still collide there, once per tab; every later load is kept.
- **An unusable `config.sessionId` is ignored with a warning** (not a string,
  over 2000 UTF-8 bytes, or containing control characters) instead of being
  sent: the server can't store such ids, so every batch would fail.
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
  dedupes); one too big for that goes to the next page load of the session,
  still under its sequence. The unload batch is now one request sized to the
  browser's 64 KiB keepalive/beacon allowance (the SDK keeps to 48 KiB so the
  page's own beacons still fit), measured in real UTF-8 bytes, carrying the
  session end, errors and page views first; several 55 KB chunks at once got
  all but the first rejected.
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
- **Short visits are no longer cut off on the device.** The SDK held every
  batch after the first until the workspace's minimum session duration had
  passed, and threw the held events away when the page closed sooner (errors
  included). The server already judges short sessions when they settle,
  keeping the identified ones and those that caught an error, so it now gets
  every event and decides.
- **What doesn't fit the unload budget on a same-tab navigation goes to the
  next page load** of the session instead of being lost, sent under the page
  it was recorded on (entry page, referrer and UTM tags intact). A tab switch
  leaves part of the budget free, so a close right after it still sends its
  `session_end`.
- **`stop()` stops everything.** A tab that loaded hidden, or a remote config
  arriving late, no longer starts recording again after `stop()`, and a second
  call waits for the first.
- **A stuck upload no longer blocks the rest:** one with no answer after 30 s
  (longer for a big body, so a slow connection still gets it through) is
  cancelled and retried.
- A session switched back on by always-record-errors / identified-users takes a
  fresh full snapshot, so its replay doesn't wait for the next checkout.

## [0.1.17]

### Fixed

- **Text is never cut through an emoji.** Click labels were capped with a plain
  `slice(0, 100)`; when an emoji straddled the cut, half of it (a lone UTF-16
  surrogate) went out with the batch and the ingest stores rejected the whole
  batch over that one character. A new `truncate()` helper cuts on whole
  characters and is used for click labels, CSS paths, network request and
  response bodies (fetch, XHR, beacon), `track()` names and properties,
  `setMetadata()` keys and values, and `setAnonymousId()`.
- The CSS-escape fallback (used where `CSS.escape` is unavailable) escapes a
  whole emoji instead of inserting a backslash between its two halves.

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
