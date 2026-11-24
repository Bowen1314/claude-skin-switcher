// skin-render.js: a line-for-line JS port of the bridge's pure helpers in
// plugin/hooks/skin.ts (parseSkin, normalizeSettings, fillFor, renderScene),
// plus preview-only helpers. Loads under require() in main and tests, and as a
// plain <script> in the sandboxed renderer (window.SkinRender).
;(function (root, factory) {
  const api = factory()

  if (typeof module === 'object' && module.exports) {
    module.exports = api
  } else {
    root.SkinRender = api
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict'

  const HEX = /^#[0-9a-fA-F]{6}$/
  const ANCHORS = ['surface-0', 'surface-1', 'surface-2', 'surface-3', 'text-primary', 'text-secondary', 'text-muted']
  const ROLES = ['accent', 'danger', 'success', 'warning', 'pro']
  // Same as the bridge's REF: <owner>.<slug>, both lower-case, no path characters.
  const REF = /^[a-z0-9][a-z0-9-]{0,38}\.[a-z0-9][a-z0-9-]{0,38}$/
  // Ids the 0.1 app wrote.
  const ALIASES = { 'firefly-meadow': 'official.firefly-meadow', 'graphite-circuit': 'official.graphite-circuit' }

  const isObject = v => typeof v === 'object' && v !== null && !Array.isArray(v)
  const num = (v, min, max, fallback) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback)

  // ---------- port of plugin/hooks/skin.ts ----------

  function parseSkin(text) {
    const raw = typeof text === 'string' ? JSON.parse(text) : text

    if (!isObject(raw) || raw.format !== 1) {
      throw new Error('not a format 1 skin')
    }
    if (!isObject(raw.colors)) {
      throw new Error('colors missing')
    }
    const backdrop = isObject(raw.backdrop) ? raw.backdrop : undefined
    const glass = isObject(backdrop && backdrop.glass) ? backdrop.glass : undefined
    const variables = []

    for (const v of Array.isArray(raw.variables) ? raw.variables.slice(0, 12) : []) {
      if (!isObject(v) || typeof v.key !== 'string' || !/^[a-z][a-z0-9-]{0,23}$/.test(v.key)) {
        continue
      }
      if (v.type === 'color' && typeof v.default === 'string' && HEX.test(v.default)) {
        variables.push({ key: v.key, type: 'color', default: v.default })
      } else if (v.type === 'range' && typeof v.min === 'number' && typeof v.max === 'number' && v.min < v.max) {
        variables.push({ key: v.key, type: 'range', min: v.min, max: v.max, default: num(v.default, v.min, v.max, v.min) })
      } else if (v.type === 'toggle') {
        variables.push({ key: v.key, type: 'toggle', default: v.default !== false })
      }
    }

    return {
      name: typeof raw.name === 'string' ? raw.name.slice(0, 40) : 'Skin',
      colors: raw.colors,
      backdrop:
        backdrop && backdrop.scene === true
          ? {
              kind: 'scene',
              blur: glass && typeof glass.blur === 'number' ? glass.blur : undefined,
              opacity: glass && typeof glass.opacity === 'number' ? glass.opacity : undefined,
            }
          : backdrop && typeof backdrop.color === 'string' && HEX.test(backdrop.color)
            ? { kind: 'color', color: backdrop.color }
            : { kind: 'none' },
      style: isObject(raw.style) ? raw.style : undefined,
      variables,
    }
  }

  function normalizeSettings(raw, skin) {
    const s = isObject(raw) ? raw : {}
    const vars = isObject(s.vars) ? s.vars : {}
    const out = {}

    for (const v of skin.variables) {
      const given = vars[v.key]

      if (v.type === 'color') {
        out[v.key] = typeof given === 'string' && HEX.test(given) ? given : v.default
      } else if (v.type === 'range') {
        out[v.key] = num(given, v.min, v.max, v.default)
      } else {
        out[v.key] = typeof given === 'boolean' ? given : v.default
      }
    }
    const glassBlur = skin.backdrop.kind === 'scene' ? skin.backdrop.blur : undefined
    const glassOpacity = skin.backdrop.kind === 'scene' ? skin.backdrop.opacity : undefined

    return {
      dim: num(s.dim, 0, 0.8, 0),
      blur: num(s.blur, 0, 64, num(glassBlur, 0, 64, 16)),
      panelOpacity: num(s.panelOpacity, 0, 1, num(glassOpacity, 0, 1, 0.6)),
      motion: s.motion !== false,
      reactive: s.reactive !== false,
      fixedFill: num(s.fixedFill, 0, 1, 0.5),
      accent: typeof s.accent === 'string' && HEX.test(s.accent) ? s.accent : null,
      textSize: typeof s.textSize === 'number' ? num(s.textSize, 12, 18, 14) : null,
      bubbleRadius: typeof s.bubbleRadius === 'number' ? num(s.bubbleRadius, 0, 16, 8) : null,
      vars: out,
    }
  }

  function anchorsOf(mode) {
    const anchors = isObject(mode) && isObject(mode.anchors) ? mode.anchors : undefined

    if (anchors === undefined || typeof anchors['surface-0'] !== 'string' || typeof anchors['text-primary'] !== 'string') {
      return undefined
    }
    const picked = {}

    for (const key of ANCHORS) {
      const value = anchors[key]

      if (typeof value === 'string' && HEX.test(value)) {
        picked[key] = value
      }
    }

    return picked
  }

  // The makeColors input buildLook sends (role filter, anchor pick, `only`).
  function colorsInput(skin, settings) {
    const roles = {}
    const given = isObject(skin.colors.roles) ? skin.colors.roles : {}

    for (const key of ROLES) {
      const value = given[key]

      if (typeof value === 'string' && HEX.test(value)) {
        roles[key] = value
      }
    }
    if (settings && settings.accent !== null && settings.accent !== undefined) {
      roles.accent = settings.accent
    }
    const light = anchorsOf(skin.colors.light)
    const dark = anchorsOf(skin.colors.dark)

    if (light === undefined && dark === undefined) {
      throw new Error('colors need light or dark anchors')
    }

    return Object.assign(
      { label: skin.name, roles },
      light !== undefined ? { light: { gray: { anchors: light } } } : {},
      dark !== undefined ? { dark: { gray: { anchors: dark } } } : {},
      light === undefined ? { only: 'dark' } : dark === undefined ? { only: 'light' } : {},
    )
  }

  // The bridge floors the context percent to 5% steps before fillFor.
  const toPercent = percent => Math.max(0, Math.min(100, Math.floor((percent || 0) / 5) * 5))

  const fillFor = (settings, percent) =>
    Math.round(((settings.reactive ? (percent === undefined || percent === null ? 0 : percent) / 100 : settings.fixedFill) || 0) * 20) / 20

  const cssValue = v => (typeof v === 'boolean' ? (v ? '1' : '0') : String(v))

  function renderScene(svg, settings, fill) {
    const vars = Object.entries(settings.vars)
      .map(([key, value]) => `--v-${key}:${cssValue(value)};`)
      .join('')
    const css = `svg{--ctx:${fill};${vars}}${settings.motion ? '' : '*{animation:none!important}'}`
    let out = svg

    if (/<\/style\s*>/i.test(out)) {
      out = out.replace(/<\/style\s*>/i, `${css}</style>`)
    } else {
      out = out.replace(/<svg\b[^>]*>/i, open => `${open}<style>${css}</style>`)
    }
    out = out.replace(/data-ctx="([0-9.]+)"/g, (match, at) => (Number(at) > fill + 1e-9 ? `${match} visibility="hidden"` : match))

    if (settings.dim > 0) {
      const veil = `<rect x="-20000" y="-20000" width="40000" height="40000" fill="#000000" opacity="${settings.dim}"/>`
      const end = out.lastIndexOf('</svg>')
      out = end === -1 ? out : `${out.slice(0, end)}${veil}${out.slice(end)}`
    }

    return out
  }

  // ---------- preview-only helpers (not in the bridge) ----------

  // An SVG inside <img> follows the app's colour scheme, not the preview's
  // Dark/Light toggle, so pin the scene's own scheme queries for the preview.
  // The feature itself is replaced, so "screen and (prefers-color-scheme: …)" is pinned too.
  const forceScheme = (svg, mode) =>
    svg.replace(/\(\s*prefers-color-scheme\s*:\s*(light|dark)\s*\)/gi, (_, which) =>
      which.toLowerCase() === mode ? '(min-width:0px)' : '(min-width:1px) and (max-width:0px)',
    )

  const modesOf = skin => ['dark', 'light'].filter(m => anchorsOf(skin.colors[m]) !== undefined)

  const hexToRgb = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16))
  const mix = (a, b, t) => {
    const [ar, ag, ab] = hexToRgb(a)
    const [br, bg, bb] = hexToRgb(b)
    const c = (x, y) => Math.round(x + (y - x) * t).toString(16).padStart(2, '0')

    return `#${c(ar, br)}${c(ag, bg)}${c(ab, bb)}`
  }
  const rgba = (hex, alpha) => `rgba(${hexToRgb(hex).join(',')},${alpha})`

  // Colours for the preview's mock Claude window, from the skin's anchors.
  function mockColors(skin, settings, mode) {
    const modes = modesOf(skin)
    const use = modes.includes(mode) ? mode : modes[0]
    const a = anchorsOf(skin.colors[use])
    const s0 = a['surface-0']
    const text = a['text-primary']
    const s1 = a['surface-1'] || mix(s0, text, 0.04)
    const s2 = a['surface-2'] || mix(s1, text, 0.04)
    const muted = a['text-muted'] || a['text-secondary'] || mix(text, s0, 0.45)
    const roles = isObject(skin.colors.roles) ? skin.colors.roles : {}
    const accent = (settings && settings.accent) || (typeof roles.accent === 'string' && HEX.test(roles.accent) ? roles.accent : muted)

    return {
      mode: use,
      surface0: s0,
      surface1: s1,
      surface2: s2,
      text,
      muted,
      accent,
      border: rgba(text, 0.1),
      borderStrong: rgba(text, 0.2),
    }
  }

  const styleNum = (skin, part, key, fallback) => {
    const rule = skin.style && isObject(skin.style[part]) ? skin.style[part] : undefined

    return rule && typeof rule[key] === 'number' ? rule[key] : fallback
  }
  const isMono = (skin, part) => {
    const rule = skin.style && isObject(skin.style[part]) ? skin.style[part] : undefined

    return !!rule && Array.isArray(rule.fontFamily) && (rule.fontFamily[0] === 'mono' || rule.fontFamily[0] === 'code')
  }

  // Type and shape hints for the mock: text size and bubble radius honour the
  // person's settings first, then the skin's style, then Claude's defaults.
  const mockShape = (skin, settings) => ({
    textSize: settings.textSize !== null ? settings.textSize : styleNum(skin, 'Text', 'fontSize', 14),
    bubbleRadius: settings.bubbleRadius !== null ? settings.bubbleRadius : styleNum(skin, 'UserMessage', 'radius', 10),
    bubbleBorder: styleNum(skin, 'UserMessage', 'borderWidth', 0),
    headingMono: isMono(skin, 'Heading'),
    toolMono: true,
  })

  // The universal settings the tuning panel shows (docs/skin-format.md).
  const UNIVERSAL = {
    dim: { type: 'range', min: 0, max: 0.8, step: 0.05 },
    blur: { type: 'range', min: 0, max: 64, step: 1 },
    panelOpacity: { type: 'range', min: 0, max: 1, step: 0.01 },
    motion: { type: 'toggle' },
    reactive: { type: 'toggle' },
    fixedFill: { type: 'range', min: 0, max: 1, step: 0.05 },
    accent: { type: 'color', nullable: true },
    textSize: { type: 'range', min: 12, max: 18, step: 1, nullable: true },
    bubbleRadius: { type: 'range', min: 0, max: 16, step: 1, nullable: true },
  }

  // Only the keys a person actually set, each clamped like normalizeSettings.
  // Untouched keys stay out of selection.json so they follow the skin's defaults.
  function sparseSettings(raw, skin) {
    const s = isObject(raw) ? raw : {}
    const n = normalizeSettings(s, skin)
    const out = {}

    for (const key of Object.keys(UNIVERSAL)) {
      if (s[key] !== undefined && s[key] !== null && n[key] !== null) {
        out[key] = n[key]
      }
    }
    const given = isObject(s.vars) ? s.vars : {}
    const vars = {}

    for (const v of skin.variables) {
      if (given[v.key] !== undefined) {
        vars[v.key] = n.vars[v.key]
      }
    }
    if (Object.keys(vars).length > 0) {
      out.vars = vars
    }

    return out
  }

  return {
    HEX,
    REF,
    sparseSettings,
    ALIASES,
    parseSkin,
    normalizeSettings,
    colorsInput,
    toPercent,
    fillFor,
    renderScene,
    forceScheme,
    modesOf,
    mockColors,
    mockShape,
    UNIVERSAL,
  }
})
