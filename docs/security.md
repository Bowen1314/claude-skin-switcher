# Security design

The gallery lets strangers share skins, and those skins end up drawn inside your Claude app. This page explains why a skin can't run code on your computer, what is checked and where, and what a skin can still do.

## A skin is data, not a program

A skin is two files:

- `skin.json`: colors, fonts, sizes, message style, and the knobs it exposes. The app and the plugin read it as JSON; nothing in it is ever run.
- `scene.svg` (optional): the animated backdrop, as a plain SVG drawing.

There is no place in a skin for JavaScript, a shell command, a plugin hook, or a file path. The bridge plugin, the only part that talks to Claude, is fixed code from this repository. A skin only gives it values to fill in.

## What `scene.svg` may contain

The SVG is checked against an allowlist, not a blocklist: anything not on the list is refused.

- **Elements**: shapes, text, groups, gradients, patterns, clip paths, masks, filters, and SMIL animation (`animate`, `animateTransform`, `animateMotion`, `set`). No `<script>`, `<image>`, `<foreignObject>`, `<iframe>`, or anything outside SVG.
- **Links**: `href` may only point inside the same file (`#id`). No `http:`, `data:`, `javascript:` or file URLs, no `xml:base`.
- **Styles**: a fixed set of CSS functions (colors, `var()`, `calc()`, transforms, filters, `url(#id)`). No `@import`, `@font-face`, `image()`, `image-set()`, `element()`, `paint()`, `expression()`, or CSS escapes.
- **Events**: no `on…` attributes. SMIL may animate only an allowlist of presentation attributes, never `href`, `style`, `class` or filter settings.
- **Well-formed XML only**: a strict single-pass parser refuses unclosed tags, duplicate attributes, foreign namespaces, `DOCTYPE`, `ENTITY`, `CDATA`, numeric character references and control characters.
- **Size and cost**: at most 120,000 characters, 2,000 elements, nesting depth 24, and 4,000 drawn elements after expanding `<use>`, masks and patterns (reference cycles are refused). Filters are capped at 32 primitives and 32 filtered elements, blur at 50 px, `numOctaves` at 4. Animations can't run faster than 0.5 s per cycle. A backdrop can't freeze the app by being huge, recursive or too fast.
- **Text fields**: names, descriptions and labels can't contain invisible or direction-changing characters.

[skin-format.md](skin-format.md) has the full rules.

## Four places that check

The gallery server and the app run the same validator (`shared/skin-validate.js`), and two more layers sit behind them, so no single layer has to be perfect:

| Where | When | What it does |
|---|---|---|
| **Gallery server** | on upload | runs the full validator; a failing upload is refused with the list of problems and nothing is stored |
| **The app** | on download, on folder import, before upload, and whenever it reads a skin from disk | runs the full validator; a failing skin is not saved, not listed and can't be applied, and the app shows why |
| **Bridge plugin** | every time it loads a skin | reads `skin.json` strictly: unknown fields are dropped, numbers are clamped to their ranges, colors must be `#rrggbb` |
| **Claude** | when the plugin hands over the theme and backdrop | Claude's own theme engine refuses backdrops with embedded pictures, fonts or links, and holds still a scene that flashes or is too heavy |

The gallery also serves `scene.svg` with `Content-Security-Policy: default-src 'none'` and `X-Content-Type-Options: nosniff`, so even opening it directly in a browser can't load or run anything.

## See it yourself

Every skin in the app, local or in the gallery, has a **Code** tab. It shows the exact `skin.json` and `scene.svg` as plain text, never rendered, along with the validator's result. What you read there is byte for byte what the plugin receives.

## What a skin can still do

A valid skin can still be unpleasant: low-contrast colors, a busy backdrop, or text drawn into the SVG. It can't read your files, see your conversations, make network requests, or change what Claude does. If a gallery skin is offensive or misleading, use **Report** in the app; skins reported from three different networks are hidden until reviewed.

## Your account

- Sign-in uses Google with the `openid` scope only. The gallery never receives your email, name or photo.
- The app keeps only Google's refresh token, encrypted with your system's keychain (Electron `safeStorage`). Signing out deletes it.
- The gallery stores a salted one-way hash of your Google account id, never the id itself, and never your IP address. See [gallery-and-privacy.md](gallery-and-privacy.md).

## Reporting a vulnerability

If you find a way to get a skin past the checks, or any other security problem, please open a [GitHub security advisory](https://github.com/Bowen1314/claude-skin-switcher/security/advisories/new) instead of a public issue.
