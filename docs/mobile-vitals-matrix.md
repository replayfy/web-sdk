# Mobile vitals parity matrix

Mobile sessions ride on the same `performance` event type as web. The
envelope is identical (`{ metric, value, unit, rating, kind? }`); only
the metric names and capture paths change per platform.

This doc is the source of truth for:
1. **SDK code** — which platform API produces each metric, how often
   to sample, what unit to ship.
2. **Dashboard rendering** — which threshold cutoffs to color values,
   which metrics to surface on Dashboard / Insights / PerfPanel.
3. **Backend perf rollup** — which columns to add to `Session` and
   `WorkspacePerfDaily` for the new mobile metrics.

## Web vitals (unchanged, ship today)

| Metric | Unit | Good | Needs improvement | Poor | Source |
|---|---|---|---|---|---|
| `lcp` | ms | <2500 | <4000 | ≥4000 | `web-vitals` library |
| `cls` | unitless | <0.1 | <0.25 | ≥0.25 | `web-vitals` library |
| `inp` | ms | <200 | <500 | ≥500 | `web-vitals` library |
| `fcp` | ms | <1800 | <3000 | ≥3000 | `web-vitals` library |
| `ttfb` | ms | <800 | <1800 | ≥1800 | `web-vitals` library |
| `longtask` | ms | <50 | <200 | ≥200 | `PerformanceObserver('longtask')` |
| `memory` | mb | <100 | <250 | ≥250 | `performance.memory.usedJSHeapSize` |

## Native vitals (new — iOS + Android)

### Loading / startup

| Metric | Unit | Good | NI | Poor | iOS source | Android source |
|---|---|---|---|---|---|---|
| `cold_start_ms` | ms | <1500 | <2500 | ≥2500 | `kCFAbsoluteTimeIntervalSince1970` from process start → first `CADisplayLink` tick after first VC `viewDidAppear` | `Process.startUptimeMillis` → first `Choreographer` frame after first Activity `onResume` |
| `time_to_first_meaningful_render_ms` | ms | <1500 | <3000 | ≥3000 | First non-launch-screen `CADisplayLink` tick where rendered view area >50% of screen | First `Choreographer.FrameCallback` after `onDraw` covers >50% screen |
| `first_network_ttfb_ms` | ms | <800 | <1800 | ≥1800 | `URLSessionTaskMetrics.transactionMetrics[0].responseStart - requestStart` | OkHttp `Interceptor.proceed()` start-to-first-byte |

### Responsiveness / jank

| Metric | Unit | Good | NI | Poor | iOS source | Android source |
|---|---|---|---|---|---|---|
| `tap_response_ms` | ms | <100 | <300 | ≥300 | touch-down timestamp → next `CADisplayLink` tick where the touched view's frame changed | `MotionEvent.ACTION_DOWN` time → next `Choreographer` frame |
| `frame_drop_pct` | pct | <5 | <15 | ≥15 | rolling 1s window: dropped frames / target frames (60 or 120) via `CADisplayLink.duration` ratio | `Choreographer.FrameCallback` deltas / target frame interval |
| `frozen_frame_count` | count | 0 | <3 | ≥3 | Frames where `CADisplayLink` interval >700ms | `Choreographer` callback intervals >700ms |
| `anr_count` | count | 0 | <1 | ≥1 | n/a (iOS doesn't have ANR concept) | Watchdog thread + sentinel ping. Main thread unresponsive >5s |

### Resource

| Metric | Unit | Good | NI | Poor | iOS source | Android source |
|---|---|---|---|---|---|---|
| `memory_rss_mb` | mb | <150 | <300 | ≥300 | `mach_task_basic_info.resident_size` / 1MB | `Debug.MemoryInfo.getTotalPss()` / 1024 |
| `thermal_state` | unitless | 0 | 1 | ≥2 | `ProcessInfo.thermalState` (0=nominal, 1=fair, 2=serious, 3=critical) | `PowerManager.getCurrentThermalStatus()` (0-5; map 3-5 to "poor") |
| `battery_drain_pct_per_min` | pct | <0.5 | <1.0 | ≥1.0 | `UIDevice.batteryLevel` deltas over 60s | `BatteryManager.BATTERY_PROPERTY_CAPACITY` deltas |

### What we DON'T capture on native

- **CLS** (cumulative layout shift) — native layouts don't shift the
  way web ones do. The closest equivalent is `frame_drop_pct` during
  layout passes, already captured.
- **LCP** as a single distinct event — native rendering is incremental.
  We use `time_to_first_meaningful_render_ms` as the closest analog.

## Capture cadence

| Metric | Capture trigger | Emit policy |
|---|---|---|
| `cold_start_ms` | Process start → first paint | Once per session, at session start |
| `time_to_first_meaningful_render_ms` | Per screen | Once per screen-appeared |
| `tap_response_ms` | Per tap | One per tap, batched |
| `first_network_ttfb_ms` | First network request of session | Once per session |
| `frame_drop_pct` | Sliding 10s window | Every 10s, but only if non-zero |
| `frozen_frame_count` | Per frame | Counter ships at session end + every 30s if changed |
| `anr_count` | Watchdog timeout | Immediate, with sampling cap of 5/session |
| `memory_rss_mb` | Periodic poll | Every 30s |
| `thermal_state` | OS notification | On change only |
| `battery_drain_pct_per_min` | Periodic poll | Every 60s |

## Rating computation

The SDK computes `rating` client-side using this matrix's cutoffs so
the dashboard never needs to know per-metric thresholds. If the SDK
ships an unknown `metric` name, the dashboard renders the value
plainly with no rating tier — backwards-compatible with metrics added
post-deploy.

## Backend `Session` columns (proposed)

Mirror the existing web-vitals columns (`worstLcp`, `worstCls`, etc.)
with native equivalents. One column per metric to keep `SELECT`
queries trivial. WorkspacePerfDaily rollup follows the same pattern.

```
coldStartMs                  Int?
firstMeaningfulRenderMs      Int?
worstTapResponseMs           Int?
firstNetworkTtfbMs           Int?
worstFrameDropPct            Int?      // value × 100, integer
frozenFrameCount             Int       @default(0)
anrCount                     Int       @default(0)
worstMemoryRssMb             Int?
worstThermalState            Int?
batteryDrainPctPerMin        Int?      // value × 100, integer
```

Naming convention: `worst*` for max-of-session metrics, raw value for
once-per-session metrics. Matches the existing `worstLcp` pattern.
