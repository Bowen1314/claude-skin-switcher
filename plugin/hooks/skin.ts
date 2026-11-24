// Pure helpers: read a skin (data only), apply the person's settings, and
// rewrite its scene. See docs/skin-format.md.
import type { ThemeBackdrop, ThemeSetArgs } from 'claude-code'

import { makeColors } from './make-colors.js'

const HEX = /^#[0-9a-fA-F]{6}$/
const ANCHORS = ['surface-0', 'surface-1', 'surface-2', 'surface-3', 'text-primary', 'text-secondary', 'text-muted'] as const
const ROLES = ['accent', 'danger', 'success', 'warning', 'pro'] as const

type Json = Record<string, unknown>
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)
const num = (v: unknown, min: number, max: number, fallback: number) =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback

export type Variable =
  | { key: string; type: 'color'; default: string }
  | { key: string; type: 'range'; min: number; max: number; default: number }
  | { key: string; type: 'toggle'; default: boolean }

export type Skin = {
  name: string
  colors: Json
  backdrop: { kind: 'scene'; blur?: number; opacity?: number } | { kind: 'color'; color: string } | { kind: 'none' }
  style: Json | undefined
  variables: Variable[]
}

export type Settings = {
  dim: number
  blur: number
  panelOpacity: number
  motion: boolean
  reactive: boolean
  fixedFill: number
  accent: string | null
  textSize: number | null
  bubbleRadius: number | null
  vars: Record<string, string | number | boolean>
}

/** Reads skin.json's text into the parts the bridge uses; throws with a short reason. */
export function parseSkin(text: string): Skin {
  const raw: unknown = JSON.parse(text)

  if (!isObject(raw) || raw.format !== 1) {
    throw new Error('not a format 1 skin')
  }
  if (!isObject(raw.colors)) {
    throw new Error('colors missing')
  }
  const backdrop = isObject(raw.backdrop) ? raw.backdrop : undefined
  const glass = isObject(backdrop?.glass) ? backdrop.glass : undefined
  const variables: Variable[] = []

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
      backdrop?.scene === true
        ? { kind: 'scene', blur: typeof glass?.blur === 'number' ? glass.blur : undefined, opacity: typeof glass?.opacity === 'number' ? glass.opacity : undefined }
        : typeof backdrop?.color === 'string' && HEX.test(backdrop.color)
          ? { kind: 'color', color: backdrop.color }
          : { kind: 'none' },
    style: isObject(raw.style) ? raw.style : undefined,
    variables,
  }
}

/** The person's settings for a skin, every value checked and defaulted. */
export function normalizeSettings(raw: unknown, skin: Skin): Settings {
  const s = isObject(raw) ? raw : {}
  const vars = isObject(s.vars) ? s.vars : {}
  const out: Settings['vars'] = {}

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

function anchorsOf(mode: unknown) {
  const anchors = isObject(mode) && isObject(mode.anchors) ? mode.anchors : undefined

  if (anchors === undefined || typeof anchors['surface-0'] !== 'string' || typeof anchors['text-primary'] !== 'string') {
    return undefined
  }
  const picked: Record<string, string> = {}

  for (const key of ANCHORS) {
    const value = anchors[key]

    if (typeof value === 'string' && HEX.test(value)) {
      picked[key] = value
    }
  }

  return picked as { 'surface-0': string; 'text-primary': string }
}

/** The look to send `$.theme.set`, plus the same without `style` for builds that refuse it. */
export function buildLook(skin: Skin, settings: Settings, scene: string) {
  const roles: Record<string, string> = {}
  const given = isObject(skin.colors.roles) ? skin.colors.roles : {}

  for (const key of ROLES) {
    const value = given[key]

    if (typeof value === 'string' && HEX.test(value)) {
      roles[key] = value
    }
  }
  if (settings.accent !== null) {
    roles.accent = settings.accent
  }
  const light = anchorsOf(skin.colors.light)
  const dark = anchorsOf(skin.colors.dark)

  if (light === undefined && dark === undefined) {
    throw new Error('colors need light or dark anchors')
  }
  const { theme } = makeColors({
    label: skin.name,
    roles,
    ...(light !== undefined ? { light: { gray: { anchors: light } } } : {}),
    ...(dark !== undefined ? { dark: { gray: { anchors: dark } } } : {}),
    ...(light === undefined ? { only: 'dark' as const } : dark === undefined ? { only: 'light' as const } : {}),
  })

  const backdrop: ThemeBackdrop | undefined =
    skin.backdrop.kind === 'scene'
      ? { scene, glass: { blur: settings.blur, opacity: settings.panelOpacity } }
      : skin.backdrop.kind === 'color'
        ? { color: skin.backdrop.color as `#${string}` }
        : undefined

  const style: Json = { ...(skin.style ?? {}) }

  if (settings.textSize !== null) {
    const text = isObject(style.Text) ? style.Text : {}
    style.Text = { ...text, fontSize: settings.textSize, lineHeight: Math.round(settings.textSize * 1.55) }
  }
  if (settings.bubbleRadius !== null) {
    const bubble = isObject(style.UserMessage) ? style.UserMessage : {}
    style.UserMessage = { ...bubble, radius: settings.bubbleRadius }
  }
  const plain = { colors: theme, ...(backdrop !== undefined ? { backdrop } : {}) }
  const hasStyle = Object.keys(style).length > 0
  // Typed loosely: builds before `style` existed don't know the field and refuse it.
  const withStyle = { ...plain, ...(hasStyle ? { style } : {}) }
  const look: ThemeSetArgs = withStyle
  const fallback: ThemeSetArgs = plain

  return { look, fallback, hasStyle }
}

/** A scene key Claude accepts (letters, digits, _ and -; at most 64), one per skin. */
export function sceneKey(ref: string) {
  let hash = 5381

  for (let i = 0; i < ref.length; i++) {
    hash = ((hash * 33) ^ ref.charCodeAt(i)) >>> 0
  }

  return `tsw_${hash.toString(36)}_${ref.replace(/[^a-z0-9-]/g, '_').slice(0, 40)}`
}

/** The fill a scene is drawn at, in 0.05 steps from 0 to 1. */
export const fillFor = (settings: Settings, percent: number | undefined) =>
  Math.round(((settings.reactive ? (percent ?? 0) / 100 : settings.fixedFill) || 0) * 20) / 20

const cssValue = (v: string | number | boolean) => (typeof v === 'boolean' ? (v ? '1' : '0') : String(v))

/** The scene as Claude should draw it: variables, fill, motion and dim written in. */
export function renderScene(svg: string, settings: Settings, fill: number) {
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
  out = out.replace(/data-ctx="([0-9.]+)"/g, (match, at: string) =>
    Number(at) > fill + 1e-9 ? `${match} visibility="hidden"` : match,
  )

  if (settings.dim > 0) {
    const veil = `<rect x="-20000" y="-20000" width="40000" height="40000" fill="#000000" opacity="${settings.dim}"/>`
    const end = out.lastIndexOf('</svg>')
    out = end === -1 ? out : `${out.slice(0, end)}${veil}${out.slice(end)}`
  }

  return out
}
