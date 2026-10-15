# Replayfy for Web

> Session replay, product analytics, and error monitoring for the browser.

Replayfy records what your users actually experience — pixel-accurate session
replays, product events and funnels, and every JavaScript error — and sends it
to your Replayfy dashboard so you can see, measure, and fix what matters.

## Features

- **Session replay** — high-fidelity playback of real user sessions, including DOM changes, scrolling, input, and navigation.
- **Product analytics** — identify users and track custom events to power funnels, segments, and retention.
- **Error monitoring** — automatic capture of unhandled errors and promise rejections, plus a `captureException` API for handled errors, with parsed stack traces grouped into issues.
- **Console & network capture** — console logs and fetch/XHR requests are recorded alongside the replay for fast debugging.
- **Web performance** — Core Web Vitals (LCP, CLS, INP), long tasks, and resource timing.
- **Rage- & dead-click detection** — surfaces frustrated interactions automatically.
- **Privacy-first** — input values and email addresses in page text are masked by default, passwords never leave the browser, and selectors and URL rules redact anything else sensitive before it leaves the browser.
- **Tiny & dependency-safe** — ships as ESM/CJS for bundlers and as a single self-contained `<script>` bundle for no-build setups.

## Install

### npm (bundlers / frameworks)

```bash
npm install @replayfyapp/browser
```

### Script tag (CDN, no build step)

Drop the self-contained bundle on any page — it exposes a global `Replayfy`. The
recommended snippet loads it **asynchronously** (so it never blocks page render)
and stands up a tiny stub that queues `init`/`track`/… calls until the bundle is
ready, then replays them:

```html
<!-- Async, non-blocking loader — queues calls until the SDK is ready.
     `crossorigin` lets the browser report full error stack traces instead of a
     bare "Script error." (the CDN sends the matching Access-Control-Allow-Origin). -->
<script>
  !(function () {
    var r = (window.Replayfy = window.Replayfy || []);
    ["init", "identify", "track", "captureException", "flush", "stop"].forEach(function (m) {
      r[m] = function () { r.push([m].concat([].slice.call(arguments))); };
    });
    var s = document.createElement("script");
    s.async = true;
    s.crossOrigin = "anonymous";
    s.src = "https://cdn.replayfy.app/v1/replay.global.js";
    var f = document.getElementsByTagName("script")[0];
    f.parentNode.insertBefore(s, f);
  })();
</script>
```

Each queued call is an array `[method, ...args]`; the bundle drains that queue on
load (replaying `init()` first). Prefer this over a plain `<script src>` tag,
which blocks rendering until the bundle downloads.

## Quick start

### With a bundler

```ts
import { initReplay } from "@replayfyapp/browser";

const replay = initReplay({
  apiKey: "pk_live_123",
  apiHost: "https://us.replayfy.app",  // or your self-hosted API URL
});

replay.identify("user_123");
replay.track("checkout_started");
```

### With the script tag

```html
<!-- Async, non-blocking loader (see Install above) -->
<script>
  !(function () {
    var r = (window.Replayfy = window.Replayfy || []);
    ["init", "identify", "track", "captureException", "flush", "stop"].forEach(function (m) {
      r[m] = function () { r.push([m].concat([].slice.call(arguments))); };
    });
    var s = document.createElement("script");
    s.async = true;
    s.crossOrigin = "anonymous";
    s.src = "https://cdn.replayfy.app/v1/replay.global.js";
    var f = document.getElementsByTagName("script")[0];
    f.parentNode.insertBefore(s, f);
  })();
  Replayfy.init({
    apiKey: "pk_live_123",
    apiHost: "https://us.replayfy.app",  // or your self-hosted API URL
  });
  Replayfy.identify("user_123");
  Replayfy.track("checkout_started");
</script>
```

`init()` is idempotent — a second call returns the live session rather than
starting a second recording. After `init()`, the `Replayfy` global forwards the
same API (`identify` / `track` / `captureException` / `flush` / `stop`), so you
never have to hold onto the returned controller.

### Full example

Every capture and privacy option can be set at init — only `apiKey` and
`apiHost` are required:

```ts
const replay = initReplay({
  apiKey: "pk_live_123",
  apiHost: "https://us.replayfy.app",  // or your self-hosted API URL

  // capture (all default to true except captureHeaders)
  captureConsole: true, // console.* output on the timeline
  captureNetwork: true, // fetch / XHR requests
  captureErrors: true, // unhandled errors + promise rejections
  captureHeaders: false, // request/response headers (off by default)

  // privacy
  maskAllInputs: true, // mask every <input> value (default)
  maskTextSelector: ".rpf-mask", // private regions: text, inputs and media masked
  blockSelector: ".rpf-block", // fully block these elements
  redactUrls: [/\/reset-password\/[^/]+/], // strip tokens from captured URLs
});
```

## Configuration

Pass these options to `initReplay(config)` (npm) or `Replayfy.init(config)` (CDN).
Only `apiKey` and `apiHost` are required.

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `apiKey` | `string` | — | **Required.** Your project's publishable API key. |
| `apiHost` | `string` | — | **Required.** Replayfy ingest host, e.g. `https://us.replayfy.app` (or your self-hosted API URL). |
| `projectId` | `string` | — | Optional project identifier, useful when one key spans environments. |
| `distinctId` | `string` | — | Identify the user at startup (equivalent to calling `identify` immediately). |
| `revId` | `string` | — | Build / release id of the deployed app, so you can scope replays and funnels to one release. |
| `sessionId` | `string` | auto | Override the generated session id (advanced; normally left unset). Must be a string of at most 2000 UTF-8 bytes with no control characters; anything else is ignored with a console warning and a generated id is used. |
| `flushIntervalMs` | `number` | `3000` | How often, in milliseconds, buffered events are sent. |
| `maxBufferSize` | `number` | — | Maximum number of events to hold in memory between flushes. |
| `captureConsole` | `boolean` | `true` | Record `console.*` output on the session timeline. |
| `captureNetwork` | `boolean` | `true` | Record fetch/XHR requests (method, URL, status, timing). |
| `captureErrors` | `boolean` | `true` | Capture unhandled errors and promise rejections. |
| `captureHeaders` | `boolean` | `false` | Include request/response headers on captured network events. |
| `redactHeaderNames` | `string[]` | — | Extra header names (beyond the built-in deny-list) whose values are masked before sending. |
| `maxBodyBytes` | `number` | `8192` | Maximum captured request/response body size, in bytes. |
| `captureResourceTimings` | `boolean` | `true` | Capture per-resource timing (images, scripts, CSS, fonts). |
| `resourceMinDurationMs` | `number` | `0` | Skip resource-timing entries faster than this many milliseconds to trim volume. |
| `maskAllInputs` | `boolean` | `true` | Mask the value of every input, textarea and select in the replay (`*` per character). Password fields never send a value or a length, whatever this says, and neither do hidden, file, url, color, month, week, datetime-local and image inputs. The dashboard can force masking on; it never turns it off. |
| `maskTextSelector` | `string` | — | CSS selector for private regions: their text is replaced by `*` at the same length, their input values are masked, and their images, canvases, videos and iframes are recorded as placeholders. Combined with the dashboard's mask selectors. An invalid selector makes the whole page private (all text, inputs and media masked), with a console warning. |
| `blockSelector` | `string` | — | CSS selector for elements to fully block (rendered as a placeholder). Combined with the dashboard's block selectors; an invalid selector is ignored, with a console warning. |
| `maskTextEmails` | `boolean` | `true` | Mask email addresses in all page text at the same length, keeping `@` and the dots between domain labels (`jane.doe@example.com` → `********@*******.***`). |
| `maskTextNumbers` | `boolean` | `false` | Turn every digit in page text into `0`. |
| `maskInputEmails` | `boolean` | `true` | With `maskAllInputs: false`, still mask input values that look like an email (`type="email"`, or containing `@`). |
| `maskInputNumbers` | `boolean` | `true` | With `maskAllInputs: false`, still mask input values with 4 or more digits in a row (card, phone and account numbers), except date inputs. |
| `redactUrls` | `Array<string \| RegExp>` | — | Patterns whose matches are stripped from captured URLs. |
| `excludeUrls` | `string[]` | — | Path globs (`*` = anything but `/`, `**` = anything), e.g. `["/settings/billing", "/admin/**"]`, that opt a page out of recording. On a matching page the SDK records and ships nothing — a per-page opt-out that beats any always-record override and the sample rate. |
| `sdk` | `object` | — | Override SDK descriptor fields (name/version) reported with each batch. |
| `beforeSend` | `(event) => event \| null` | — | Inspect or mutate each batch before it's sent, including the one sent when the tab is hidden or the page unloads. Must be synchronous. Return `null` (or a batch with no events) to drop it; if it throws or returns a Promise, the batch is dropped too, so nothing unscrubbed leaves the browser. What is sent never goes through it twice: a batch retried after a failed upload is resent as the hook first returned it, under the same sequence (the hook is called again, on a copy, only to let it drop the batch by returning `null`). |
| `fetchImpl` | `typeof fetch` | `window.fetch` | Custom `fetch` implementation (advanced/testing). |

## API

`initReplay()` returns a controller with the methods below. When using the CDN
global, the same methods are available as `Replayfy.identify(...)`,
`Replayfy.track(...)`, etc., after `Replayfy.init(...)`.

### `identify(distinctId, props?)`

Associate the current session with a user. Accepts a distinct id plus optional
traits, or a single payload object.

```ts
replay.identify("user_123", { email: "ada@example.com", plan: "pro" });

// or a single object
replay.identify({ distinctId: "user_123", name: "Ada Lovelace" });
```

Set `picture` (or its alias `avatar`) to a public `https` image URL to give
the user an avatar in the dashboard (shown on the recording header and Users
list). It can be a top-level trait or nested under `customProps`; non-URL
values are ignored.

```ts
replay.identify("user_123", {
  email: "ada@example.com",
  picture: "https://cdn.example.com/u/123.png",
});
```

### `track(name, properties?)`

Record a custom product event. Event names should be stable identifiers
(`snake_case` or `camelCase`, no spaces) so they're searchable in funnels.

```ts
replay.track("checkout_started");
replay.track("plan_upgraded", { from: "free", to: "pro" });
```

### `captureException(error, opts?)`

Report a developer-caught exception on the session timeline. It becomes a
first-class issue in the dashboard, with its name, message, and parsed stack.
`opts.handled` defaults to `true`; pass `false` to record it as a fatal error.

```ts
try {
  risky();
} catch (e) {
  replay.captureException(e);
}
```

### `flush()`

Send any buffered events immediately. Returns a `Promise`.

```ts
await replay.flush();
```

### `stop()`

Stop all capture, end the session, and flush the final batch. Returns a
`Promise`.

```ts
await replay.stop();
```

### `sessionId`

The current session's id (string), handy for correlating with your own logs.

```ts
console.log(replay.sessionId);
```

### `urlForCurrentSession()`

A deep link to the current session in the dashboard —
`<app-host>/recordings/<sessionId>`, with the app host derived from `apiHost`.
Returns `null` before a session has started. This is the private, authenticated
dashboard view (not a public share link), so it exposes nothing to anyone
without workspace access.

```ts
const url = replay.urlForCurrentSession();
// → "https://app.replayfy.app/recordings/ses_123" (or null before start)
```

## Privacy & masking

Replayfy is designed to keep sensitive data in the browser. By default, every
input value is masked, password fields send no value and no length, and email
addresses in page text (and in the page title sent with each batch) are
masked. Tune redaction with these options:

- **`maskAllInputs`** (default `true`) — masks the value of every input field in the replay. With `false`, values are recorded as typed, except passwords, values inside a private region, and (unless `maskInputEmails` / `maskInputNumbers` are set to `false`) email-like values and values with 4 or more digits in a row. Hidden, file, url, color, month, week, datetime-local and image inputs never send a value, whatever this says.
- **`maskTextSelector`** — a CSS selector for private regions (e.g. `.pii, .account-number`). Their text is replaced by `*` at the same length, their input values are masked, and their images, canvases, videos and iframes render as placeholders.
- **`blockSelector`** — a CSS selector for elements to block entirely; they render as a placeholder in playback, and a click on them carries no label text.
- **`maskTextEmails`** (default `true`) — masks email addresses in all page text at the same length; `@` and the dots stay, so the replay still reads as an address.
- **`maskTextNumbers`** (default `false`) — turns every digit in page text into `0`.
- **`redactUrls`** — string/`RegExp` patterns stripped from captured network request and resource URLs, so tokens and ids never leave the page. Combined with the workspace's URL patterns (both apply). Page URLs always get the built-in sensitive-key scrub (`token`, `code`, `password`…).
- **`captureHeaders`** (default `false`) — headers are only captured when explicitly enabled.
- **`redactHeaderNames`** — additional header names whose values are masked, on top of the always-on built-in deny-list.
- **`maxBodyBytes`** — caps how much of a request/response body is ever captured. Bodies are only captured when the dashboard's "Capture request / response bodies" setting is on (off by default).

CSS text is never altered, script and `<noscript>` text is never sent readable,
and HTML comments, `<meta>` content and link targets (`href` on HTML elements
other than stylesheet and font `<link>`s, such as `mailto:` and magic-link
anchors) are not recorded. Nothing inside a blocked or private iframe is
recorded. A selector the browser can't parse is never passed to the recorder:
an invalid mask selector makes the whole page private, and an invalid block
selector is ignored; both log a console warning.

### Mask a specific input or element

Every `<input>` is masked by default. To hide anything else — a text node, a
whole widget, a specific field — add a class (or use any CSS selector) and point
the mask/block selectors at it. The real values never leave the browser:

```html
<!-- inputs are masked automatically -->
<input type="text" name="ssn" />

<!-- a private region: its text shows as **** **** **** **** in playback -->
<span class="rpf-mask">4111 1111 1111 1111</span>

<!-- BLOCK an element entirely: rendered as a placeholder box -->
<div class="rpf-block"><!-- third-party chat widget --></div>
```

```ts
initReplay({
  apiKey: "pk_live_123",
  apiHost: "https://us.replayfy.app",  // or your self-hosted API URL
  maskAllInputs: true, // default — every <input> value is masked
  maskTextSelector: ".rpf-mask", // mask the text, inputs and media of matching elements
  blockSelector: ".rpf-block", // replace matching elements with a placeholder
});
```

For full control, `beforeSend` receives each batch before it leaves the browser,
so you can drop or scrub anything programmatically.

## Dashboard configuration

Capture and sampling settings you configure in your Replayfy **dashboard are
fetched at startup and take precedence over the values you pass to `init()`**.
This lets you turn console or network capture on or off, adjust sampling, or
pause recording for a workspace — without shipping a new build of your app.

Privacy settings are combined, so the dashboard can only add masking:

- The dashboard's "mask all inputs" forces input masking on. It never turns off
  masking your code asked for.
- The dashboard's mask and block selectors apply together with
  `maskTextSelector` / `blockSelector`; neither replaces the other.
- A page uploads nothing until the dashboard's privacy settings have arrived,
  for up to 4 seconds (a failed request for them is retried meanwhile). On a
  fast connection they arrive before the first upload would go, so nothing
  waits. Recording starts at once, under the last settings seen in this
  browser or, on a first visit, the dashboard's defaults (`[data-private]`
  and `.sensitive` masked, `.no-replay` blocked, no request bodies). If the
  settings that arrive hide more, what was recorded before them is discarded
  and the replay starts from a fresh snapshot; events of a capture they turn
  off (network, console, performance) are discarded too. A page closed,
  stopped or put in the back/forward cache during that wait hands what it
  recorded to the next page of the session in the same tab (or to itself,
  when it comes back), which sends it once it has the settings (its replay
  only if they hide nothing more); if no page follows, it is never sent. When
  the settings can't be fetched, the last settings seen in this browser apply
  or, on a first visit, the dashboard's defaults.

## Links

- Docs: https://docs.replayfy.app/platforms/web
- Dashboard: https://app.replayfy.app
