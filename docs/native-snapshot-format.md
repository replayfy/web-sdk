# Native snapshot payload format

The view-tree JSON shape emitted by iOS / Android / Flutter / React
Native SDKs. The dashboard player has **one renderer**; the SDKs
serialize their platform-native trees into this shape. Schema lives
in `src/schema.ts` (`NativeViewNode`, `NativeSnapshotEventData`).

## Design constraints

1. **Lean** — at 10k views per screen, every extra field is multiplied
   by tree size. Skip anything the player won't render.
2. **Platform-neutral** — same shape for UIView, Android View, Flutter
   Widget. Player must not branch by platform.
3. **Sparse-snapshot semantics** — these are emitted on screen
   transition or after 500ms idle, NOT every frame. The player
   interpolates tap markers between snapshots.
4. **Content-addressed assets** — image bytes go out-of-band. Snapshot
   carries `imageRef` (hash); player resolves at render time.

## Capture triggers

The SDK emits a `native_snapshot` event when ANY of these fire:

| Trigger | Detail | Player render hint |
|---|---|---|
| `screen_appeared` | New ViewController / Activity / Route became active | Eager — show immediately |
| `idle` | 500ms with no taps + no new screens | Lazy — show only if scrubbed to |
| `tap` | A tap fired on an interactive widget AND the tree changed (e.g. modal opened) | Eager |
| `manual` | Customer called `Replay.captureSnapshot()` | Eager |

## Tree-walk algorithm (per platform)

### iOS (UIKit)

```swift
func walk(_ v: UIView, parentBounds: CGRect) -> NativeViewNode? {
  guard v.isHidden == false, v.alpha > 0.01 else { return nil }
  let frame = v.convert(v.bounds, to: nil)
  // Skip nodes fully outside the screen
  guard frame.intersects(UIScreen.main.bounds) else { return nil }

  let node = NativeViewNode(
    id: pathId(v),
    type: classify(v),
    className: String(describing: type(of: v)),
    bounds: frame,
    text: extractText(v),
    imageRef: extractImageHash(v),
    backgroundColor: hexFromColor(v.backgroundColor),
    opacity: Double(v.alpha),
    occluded: occlusionRegistry.contains(v),
    ariaLabel: v.accessibilityLabel,
    children: v.subviews.compactMap { walk($0, parentBounds: frame) }
  )
  return node
}
```

### Android (View system)

```kotlin
fun walk(v: View, parentBounds: Rect): NativeViewNode? {
  if (!v.isShown || v.alpha < 0.01f) return null
  val frame = Rect().also { v.getGlobalVisibleRect(it) }
  if (frame.isEmpty) return null

  return NativeViewNode(
    id = pathId(v),
    type = classify(v),
    className = v.javaClass.simpleName,
    bounds = Bounds(frame.left, frame.top, frame.width(), frame.height()),
    text = extractText(v),
    imageRef = extractImageHash(v),
    backgroundColor = hexFromBackground(v.background),
    opacity = v.alpha.toDouble(),
    occluded = occlusionRegistry.contains(v),
    ariaLabel = v.contentDescription?.toString(),
    children = if (v is ViewGroup) {
      (0 until v.childCount).mapNotNull { walk(v.getChildAt(it), frame) }
    } else null
  )
}
```

### Flutter

Walk the `Element` tree using `visitChildElements`, classify with the
table already in `uxcam-flutter/lib/src/smart_events/uxcam_widget_classifier.dart`.

### React Native

For RN, the iOS/Android native side runs its own walk on the
UIView/View tree. RN widgets render to native views, so the native
walk works. The RN bridge adds the React component name via the
`testID` prop (or fiber-based mapping if available) as `className`.

## Classification (`type` field)

Platform-neutral buckets. Each platform maps its native widget classes
to one of these:

| `type` | iOS UIKit | Android View | Flutter | React Native |
|---|---|---|---|---|
| `button` | UIButton, UIBarButtonItem | Button, ImageButton, CheckBox (as button) | ElevatedButton, TextButton, InkWell, IconButton | TouchableOpacity, Pressable |
| `field` | UITextField, UITextView (editable), UISearchBar | EditText, TextInputEditText, SearchView | TextField, TextFormField | TextInput |
| `compound` | UISwitch, UISlider, UIStepper, UISegmentedControl | Switch, SeekBar, RatingBar | Switch, Slider, Checkbox, Radio | Switch, Slider |
| `text` | UILabel | TextView | Text, RichText | Text |
| `image` | UIImageView | ImageView | Image, Icon | Image |
| `container` | UIScrollView, UIStackView, UICollectionView | ScrollView, RecyclerView, LinearLayout | Scaffold, ListView, Column, Row | ScrollView, FlatList, View |
| `unknown` | anything else | anything else | anything else | anything else |

`UIWindow` and root `ViewGroup` are also `container`.

## Value extraction (`text`)

- `text` widget: the rendered text (after any localization)
- `button` widget: the button label
- `field` widget: the **placeholder/hint**, NEVER the actual contents
- `image` widget: asset name / icon codepoint
- `compound`: current-state string ("on" / "off" / "0.5")
- `container`: empty (containers don't carry text)

If `isSensitive` is true (any ancestor is `OccludeWrapper` / has
`.privacySensitive()` / contains `replay-block`), all three of
`text`, `imageRef`, `ariaLabel` are blanked.

## ID strategy (`id` field)

Per-snapshot stable ID, encoded as a sibling-index path:

```
"0"          → root
"0/2"        → root's 3rd child
"0/2/0/1"    → deeper
```

Lets the player diff consecutive snapshots without per-node UUIDs.
Tap events carry an `id` that resolves to the tapped node within the
nearest preceding snapshot.

## Image asset handling

When the tree-walk encounters an image:

1. Compute SHA-256 of the raw pixel bytes (downsampled to a max
   1024×1024 thumbnail).
2. Check local LRU cache (max 50 entries) — if hash seen this session,
   skip upload.
3. Otherwise, queue upload to `/v1/replay/assets/{hash}`. Returns 200
   on success, 304 if already on server.
4. Embed `imageRef: "<hash>"` in the node.

Player fetches `/v1/replay/assets/{hash}` at render time, with browser
cache headers set to immutable / 1-year — these are content-addressed
so they never change.

## Size budget

Target: **<50 KB gzipped per snapshot** for a typical screen
(~200-500 visible nodes after filtering hidden / off-screen / zero-area).

Optimizations applied:
- Skip `opacity` if 1.0
- Skip `backgroundColor` if transparent
- Skip `children` if empty (don't emit `children: []`)
- Skip `occluded` if false
- Truncate `text` at 280 chars (Twitter rule)

## Versioning

Snapshot payloads include `recorder: "native"` (in
`NativeSnapshotEventData`) — distinct from rrweb's `recorder: "rrweb"`.
If we ever change the tree-node shape incompatibly, bump to
`recorder: "native-v2"` and have the player branch on it. SDK and
player can be deployed independently.

## What the dashboard player does with this

1. **Render frame at time T**:
   - Find the most recent `native_snapshot` event at or before T.
   - Walk the tree, render each node as an absolutely-positioned
     `<div>` (text), `<button>`, `<img>` with `imageRef` resolved, etc.
   - Apply `occluded: true` nodes as a noise/blur overlay.
2. **Animate taps**:
   - For each `tap` event between snapshot T and the next snapshot,
     render a transient ripple at `point.x, point.y` with optional
     highlighting of the `uiId`'d node.
3. **Scrub**: Player seeks to T by finding the right snapshot. No
   incremental-snapshot reconstruction needed in v1.

In v2 we may add `incremental_native_snapshot` for diff updates to
reduce bandwidth further, but v1 ships with full snapshots only.
