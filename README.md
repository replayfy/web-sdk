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
- **Privacy-first** — inputs are masked by default, with selectors and URL rules to redact anything sensitive before it leaves the browser.
- **Tiny & dependency-safe** — ships as ESM/CJS for bundlers and as a single self-contained `<script>` bundle for no-build setups.

## Install

### npm (bundlers / frameworks)

```bash
npm install @replayfyapp/browser
```

### Script tag (CDN, no build step)

Drop the self-contained bundle on any page — it exposes a global `Replayfy`:

```html
<script src="https://cdn.replayfy.app/v1/replay.global.js"></script>
```

## Quick start

### With a bundler

```ts
import { initReplay } from "@replayfyapp/browser";

const replay = initReplay({
  apiKey: "pk_live_123",
  apiHost: "https://us.replayfy.app",
});

replay.identify("user_123");
replay.track("checkout_started");
```

### With the script tag

```html
<script src="https://cdn.replayfy.app/v1/replay.global.js"></script>
<script>
  Replayfy.init({
    apiKey: "pk_live_123",
    apiHost: "https://us.replayfy.app",
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
  apiHost: "https://us.replayfy.app",

  // capture (all default to true except captureHeaders)
  captureConsole: true, // console.* output on the timeline
  captureNetwork: true, // fetch / XHR requests
  captureErrors: true, // unhandled errors + promise rejections
  captureHeaders: false, // request/response headers (off by default)

  // privacy
  maskAllInputs: true, // mask every <input> value (default)
  maskTextSelector: ".rpf-mask", // mask the text of these elements
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
| `apiHost` | `string` | — | **Required.** Replayfy ingest host, e.g. `https://us.replayfy.app`. |
| `projectId` | `string` | — | Optional project identifier, useful when one key spans environments. |
| `distinctId` | `string` | — | Identify the user at startup (equivalent to calling `identify` immediately). |
| `revId` | `string` | — | Build / release id of the deployed app, so you can scope replays and funnels to one release. |
| `sessionId` | `string` | auto | Override the generated session id (advanced; normally left unset). |
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
| `maskAllInputs` | `boolean` | `true` | Mask the value of every `<input>` in the replay. |
| `maskTextSelector` | `string` | — | CSS selector for text nodes to mask in the replay. |
| `blockSelector` | `string` | — | CSS selector for elements to fully block (rendered as a placeholder). |
| `redactUrls` | `Array<string \| RegExp>` | — | Patterns whose matches are stripped from captured URLs. |
| `sdk` | `object` | — | Override SDK descriptor fields (name/version) reported with each batch. |
| `beforeSend` | `(event) => event \| null` | — | Inspect or mutate each batch before it's sent; return `null` to drop it. |
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

## Privacy & masking

Replayfy is designed to keep sensitive data in the browser. By default, every
input value is masked. Tune redaction with these options:

- **`maskAllInputs`** (default `true`) — masks the value of every input field in the replay.
- **`maskTextSelector`** — a CSS selector for text nodes to mask (e.g. `.pii, .account-number`).
- **`blockSelector`** — a CSS selector for elements to block entirely; they render as a placeholder in playback.
- **`redactUrls`** — string/`RegExp` patterns stripped from captured URLs, so tokens and ids never leave the page.
- **`captureHeaders`** (default `false`) — headers are only captured when explicitly enabled.
- **`redactHeaderNames`** — additional header names whose values are masked, on top of the always-on built-in deny-list.
- **`maxBodyBytes`** — caps how much of a request/response body is ever captured.

### Mask a specific input or element

Every `<input>` is masked by default. To hide anything else — a text node, a
whole widget, a specific field — add a class (or use any CSS selector) and point
the mask/block selectors at it. The real values never leave the browser:

```html
<!-- inputs are masked automatically -->
<input type="text" name="ssn" />

<!-- mask the TEXT of an element: shown as ●●●● in playback -->
<span class="rpf-mask">4111 1111 1111 1111</span>

<!-- BLOCK an element entirely: rendered as a placeholder box -->
<div class="rpf-block"><!-- third-party chat widget --></div>
```

```ts
initReplay({
  apiKey: "pk_live_123",
  apiHost: "https://us.replayfy.app",
  maskAllInputs: true, // default — every <input> value is masked
  maskTextSelector: ".rpf-mask", // mask the text content of matching elements
  blockSelector: ".rpf-block", // replace matching elements with a placeholder
});
```

For full control, `beforeSend` receives each batch before it leaves the browser,
so you can drop or scrub anything programmatically.

## Dashboard configuration

Privacy, capture, and sampling settings you configure in your Replayfy
**dashboard are fetched at startup and take precedence over the values you pass
to `init()`**. This lets you tighten masking, turn console or network capture on
or off, adjust sampling, or pause recording for a workspace — without shipping a
new build of your app. Treat the options above as your defaults; when a setting
is configured in the dashboard, the dashboard wins.

## Links

- Docs: https://docs.replayfy.app/platforms/web
- Dashboard: https://app.replayfy.app
