# Changelog

All notable changes to `@replayfyapp/browser` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
