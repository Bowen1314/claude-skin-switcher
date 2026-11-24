# Skin format, version 1

A skin is **data only**: one `skin.json` and, optionally, one `scene.svg`. No code runs from a skin. Skins live on disk at

```
<home>/.claude-theme-switcher/skins/<ref>/skin.json
<home>/.claude-theme-switcher/skins/<ref>/scene.svg     (optional)
```

`<home>` is `HOME` on macOS and `USERPROFILE` on Windows. `<ref>` is `<owner>.<slug>`: `official.firefly-meadow` for the built-ins, `<handle>.<slug>` for gallery skins (the handle is the public name a gallery account claims: lower-case, 3–32 characters). `default` is reserved: it means "no skin, the app's own look".

## skin.json

```jsonc
{
  "format": 1,
  "slug": "graphite-circuit",            // ^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$
  "name": "Graphite Circuit",            // 1–40 chars
  "description": "Graphite and one signal cyan…", // 0–140 chars
  "author": "official",                  // set by the gallery from the uploader's handle; ignored on upload
  "version": 3,                          // integer, set by the gallery (1, 2, …); ignored on upload
  "tags": ["dark", "minimal"],           // 0–5 tags, each ^[a-z0-9-]{1,20}$

  "colors": {
    "roles": { "accent": "#35b8c9", "danger": "#e0524a", "success": "#4fb37a", "warning": "#d9a033", "pro": "#8b7cf0" },
    "light": { "anchors": { "surface-0": "#eceef1", "text-primary": "#15181d", "...": "..." } },
    "dark":  { "anchors": { "surface-0": "#0e1013", "text-primary": "#e6e9ee", "...": "..." } }
  },

  "backdrop": { "scene": true, "glass": { "blur": 10, "opacity": 0.72 } },

  "style": { "Heading": { "fontFamily": ["mono"] }, "UserMessage": { "radius": 3 } },

  "variables": [
    { "key": "signal", "label": "Signal color", "type": "color", "default": "#3ec6d8" },
    { "key": "grid",   "label": "Grid strength", "type": "range", "min": 0, "max": 1, "step": 0.05, "default": 0.6 },
    { "key": "traces", "label": "Traces", "type": "toggle", "default": true }
  ]
}
```

### colors (required)

The input of the design system's `makeColors` (the bridge runs it; see `plugin/hooks/make-colors.js`):

- `roles`: any of `accent`, `danger`, `success`, `warning`, `pro`; each `#rrggbb`.
- `light` / `dark`: at least one. Each has `anchors` with `surface-0` and `text-primary` required, and optionally `surface-1`, `surface-2`, `surface-3`, `text-secondary`, `text-muted`; each `#rrggbb`. In both modes `surface-0` is the darkest surface and each later one is as light or lighter. In light mode `surface-2` and `surface-3` must match if both are given.
- A skin with only one of `light` / `dark` is drawn in that mode only.

### backdrop (optional)

One of:

- `{ "scene": true, "glass"?: { "blur"?: 0–64, "opacity"?: 0–1 } }`: the skin ships `scene.svg`.
- `{ "color": "#rrggbb" }`: a flat ground.
- absent: no backdrop.

### style (optional)

A subset of Claude's `ThemeStyle`, applied as given (Claude validates ranges and refuses out-of-range values; the bridge then retries without `style`):

- Parts: `Text`, `Heading`, `UserMessage`, `AssistantMessage`, `ToolUse`. A part's value is one rule object (no lists in v1).
- Type keys: `color`, `fontFamily` (`["sans"|"serif"|"mono"|"code"|"cursive"]`), `fontSize` 11–28, `fontWeight` (`regular|medium|semibold|bold`), `italic`, `letterSpacing` −1–4, `lineHeight` 12–48 (≥ fontSize).
- Box keys (not on `Text`/`Heading`): `backgroundColor`, `borderColor`, `borderWidth` 0–8, `radius` 0–64, `padding`, `paddingX`, `paddingY` 0–48, `shadow` (`"none"` or `{ x, y, blur, color }`).
- Colors in `style` are `#rrggbb`, `#rrggbbaa`, or one of the theme names `surface-0`…`surface-3`, `border`, `border-strong`, `border-stronger`, `fill-accent`, `text-accent`, `bg-accent`, `border-accent`.
- `ToolUse` takes only `color`, `fontFamily` and box keys.

### variables (optional, 0–12)

Knobs the app shows for this skin. Each has a unique `key` (`^[a-z][a-z0-9-]{0,23}$`), a `label` (1–32 chars) and a `type`:

| type | fields | CSS value in the scene |
| --- | --- | --- |
| `color` | `default` `#rrggbb` | the color, e.g. `#3ec6d8` |
| `range` | `min`, `max`, `step`, `default` (numbers, min < max) | the number, e.g. `0.6` |
| `toggle` | `default` boolean | `1` or `0` |

## scene.svg (optional)

An animated SVG, at most **120,000 characters**, with a `viewBox`; use `preserveAspectRatio="xMidYMid slice"` so it fills any window. Keep the middle and the bottom quiet: messages sit in the middle, the message box at the foot.

Allowed: shapes, paths, groups, gradients, patterns, `<style>` with CSS animations, `@media (prefers-color-scheme: light)` for a light version.
Refused (by the gallery, the app, and Claude itself): `<script>`, `<image>`, `<foreignObject>`, `<iframe>`, `<use>` pointing outside the file, any `on…=` attribute, `href`/`xlink:href` other than `#fragment`, `url(` other than `url(#id)`, `@import`, `@font-face`, `<!DOCTYPE`, `<!ENTITY`, `CDATA`, `<?` processing instructions, embedded data URIs. Comments must be plain words (no `<`, `--`, `href`, `(` or `@` inside).

Motion should be slow: nothing may flash more than three times a second.

Structure: well-formed XML with exact-case SVG element names (no `<marker>`); every attribute written `name="value"` (quoted, no `<` or `>` inside, none twice); `<style>` closed and text only; `xmlns` / `xmlns:xlink` only on the root, with the SVG / XLink namespaces; no other namespaced attributes besides `xlink:href`, `xml:space` and `xml:lang`; each `id` once; no reference cycles through `href` or `url(#…)`; nothing after `</svg>`; an element with `data-ctx` must not set `visibility` (the bridge does).

CSS (in `<style>`, `style=""` and attribute values): only `@keyframes`, `@media` and `@supports`; only these functions: `url(#id)`, `var`, `calc`, `min`, `max`, `clamp`, `abs`, `round`, `sin`, `cos`, `rgb(a)`, `hsl(a)`, `hwb`, `lab`, `lch`, `oklab`, `oklch`, `color`, `color-mix`, `light-dark`, `translate(X|Y)`, `scale(X|Y)`, `rotate`, `skew(X|Y)`, `matrix`, `cubic-bezier`, `steps`, `linear`, `path`, `polygon`, `circle`, `ellipse`, `inset`, the filter functions below, and the selectors `:not`, `:is`, `:where`, `:nth-(last-)child`, `:nth-(last-)of-type`. CSS comments are ignored when checking.

SMIL may animate only: `opacity`, `fill`, `fill-opacity`, `stroke`, `stroke-opacity`, `stroke-width`, `stroke-dasharray`, `stroke-dashoffset`, `stop-color`, `stop-opacity`, `flood-color`, `flood-opacity`, `color`, `visibility`, `display`, `transform`, `gradientTransform`, `patternTransform`, `offset`, `pathLength`, `startOffset`, `x`, `y`, `x1`, `y1`, `x2`, `y2`, `cx`, `cy`, `r`, `rx`, `ry`, `fx`, `fy`, `fr`, `width`, `height`, `d`, `points`, `font-size`, `letter-spacing`, `word-spacing`.

### Resource limits

So a scene can't stall the app or Claude's renderer:

| limit | value | the official skins |
|---|---|---|
| elements (start tags, including `<svg>`) | at most 2,000 | 452 (Firefly Meadow), 328 (Graphite Circuit) |
| nesting depth (`<svg>` is 1) | at most 24 | 5, 3 |
| elements drawn once every `<use>`, and every reference to a `<mask>`, `<pattern>` or `<clipPath>`, is expanded | at most 4,000 | 452, 332 |
| filter primitives (`<fe…>` elements plus CSS filter functions) | at most 32 | 0, 0 |
| filtered elements, counted the same way | at most 32 | 0, 0 |
| `feGaussianBlur` / `feDropShadow` `stdDeviation`; lengths in CSS `blur()` / `drop-shadow()` (px only) | at most 50 | – |
| `feTurbulence` `numOctaves` | whole number, at most 4 | – |
| `feMorphology` `radius` | at most 20 | – |
| `feConvolveMatrix` `order` | whole number, at most 5 | – |
| animation duration: CSS `animation-duration`, the duration in `animation`, SMIL `dur`, `max`, `repeatDur` | at least 0.5 s | 3.2 s, 5.1 s |
| `viewBox` | positive width and height, every number within ±100,000 | `0 0 1600 1000` |

References that multiply work go on elements, so they can be counted: in `<style>`, `url(#id)` may point at gradients only, and `filter` may not be set there. Filters go on elements (`filter="url(#f)"` or `style="filter:…"`); `filter` values take only `url(#id)`, the CSS filter functions (`blur`, `drop-shadow`, `brightness`, `contrast`, `grayscale`, `hue-rotate`, `invert`, `opacity`, `saturate`, `sepia`) and colors, no `var()` or `calc()`. `backdrop-filter` and `primitiveUnits="objectBoundingBox"` are refused. Animation durations must be written out (no `var()` or `calc()`; the `animation` shorthand holds only names, numbers and times); delays are free. `<marker>` is not allowed (it repeats at every vertex), nor `href` and `xlink:href` on one element. Around a `#fragment` only ASCII spaces count. The minimum duration does not by itself stop flashing; keep to the three-flashes rule above. The numbers are `SKIN_LIMITS.scene…` in `shared/skin-validate.js`; `sceneStats(text)` returns a scene's counts.

### What the bridge injects

Before drawing, the bridge rewrites the scene:

1. At the end of the first `<style>` (one is added if there is none), so it wins over the skin's own defaults:
   `svg{--ctx:<0..1>;--v-<key>:<value>;…}` — the context window's fill (in 0.05 steps) and each variable's current value. Use them as `var(--v-signal)`, `calc(var(--v-grid) * 0.4)`, `opacity: var(--v-traces)`, and declare each variable's default yourself (`svg{--v-signal:#3ec6d8}`) so the scene also draws on its own.
2. Every element carrying `data-ctx="<0..1>"` whose threshold is above the current fill gets `visibility="hidden"`. Mark the extra fireflies, lit nodes or stars a skin adds as the context fills: `<g data-ctx="0.35">…</g>`.
3. With motion turned off: `*{animation:none!important}`.
4. With a dim above 0: a final full-size black `<rect>` at that opacity.

## Universal settings

Every skin gets these, kept per skin in `selection.json`:

| key | range | default | effect |
| --- | --- | --- | --- |
| `dim` | 0–0.8 | 0 | black veil over the backdrop |
| `blur` | 0–64 | skin's `glass.blur` or 16 | frosted-panel blur |
| `panelOpacity` | 0–1 | skin's `glass.opacity` or 0.6 | frosted-panel opacity |
| `motion` | bool | true | scene animation on or off |
| `reactive` | bool | true | follow the context fill |
| `fixedFill` | 0–1 | 0.5 | the fill used when `reactive` is off |
| `accent` | `#rrggbb` or null | null | replaces `colors.roles.accent` |
| `textSize` | 12–18 or null | null | `style.Text.fontSize` (line height = round(size × 1.55)) |
| `bubbleRadius` | 0–16 or null | null | `style.UserMessage.radius` |

## selection.json

Written by the app (atomically: temp file, then rename), read by the bridge every 1.5 s when its mtime changes:

```json
{
  "theme": "official.graphite-circuit",
  "settings": {
    "official.graphite-circuit": {
      "dim": 0.2, "blur": 10, "panelOpacity": 0.72, "motion": true, "reactive": true,
      "fixedFill": 0.5, "accent": null, "textSize": null, "bubbleRadius": null,
      "vars": { "signal": "#3ec6d8", "grid": 0.6, "traces": true }
    }
  }
}
```

`theme` is a `<ref>` or `default`. Unknown or out-of-range settings fall back to the defaults. After the app saves or updates a skin's files it rewrites `selection.json` so the bridge reloads it.

## bridge.json

The bridge's heartbeat beside `selection.json`, written at session start and every 60 s:
`{ "version": "0.2.0", "platform": "macos", "lastSeen": <epoch ms>, "applied": "<ref>" | null, "error": "<last error>" | null }`.
