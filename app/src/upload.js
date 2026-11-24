'use strict'

// Everything an upload needs before it leaves the machine: read a folder,
// check it the way the gallery will, and bake tuning into a new skin.

const fs = require('node:fs')
const path = require('node:path')

const { colorsProblem } = require('./library')
const { REF } = require('./skin-render')

const SKIN_MAX_BYTES = 200 * 1024
const SCENE_MAX_BYTES = 480 * 1024
const UPLOAD_MAX_BYTES = 300 * 1024 // server/README.md: body at most 300 KB
const SLUG = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/

const readCapped = async (file, max) => {
  const stat = await fs.promises.stat(file)

  if (!stat.isFile()) {
    throw new Error(`${path.basename(file)} is not a file`)
  }
  if (stat.size > max) {
    throw new Error(`${path.basename(file)} is larger than ${Math.round(max / 1024)} KB`)
  }

  return fs.promises.readFile(file, 'utf8')
}

// A declared remix in the folder's meta.json (as the app writes it), or null.
const readBasedOn = async dir => {
  try {
    const meta = JSON.parse(await readCapped(path.join(dir, 'meta.json'), 16 * 1024))
    const v = meta?.basedOn

    return typeof v === 'string' && REF.test(v) ? v : null
  } catch {
    return null
  }
}

// { ok, skin (parsed, unvalidated), scene (string|null), basedOn (string|null), errors }
const importFolder = async dir => {
  let skin

  try {
    skin = JSON.parse(await readCapped(path.join(dir, 'skin.json'), SKIN_MAX_BYTES))
  } catch (error) {
    const message = error?.code === 'ENOENT' ? 'The folder has no skin.json' : `skin.json: ${error instanceof SyntaxError ? 'not valid JSON' : error.message}`

    return { ok: false, skin: null, scene: null, errors: [message] }
  }
  let scene = null

  try {
    scene = await readCapped(path.join(dir, 'scene.svg'), SCENE_MAX_BYTES)
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      return { ok: false, skin, scene: null, errors: [`scene.svg: ${error.message}`] }
    }
  }

  return { ok: true, skin, scene, basedOn: await readBasedOn(dir), errors: [] }
}

// The same checks the gallery runs, plus makeColors. { ok, errors, payload }
const prepareUpload = ({ skin, scene, deps }) => {
  const checked = deps.validateSkin(skin)

  if (!checked.ok) {
    return { ok: false, errors: checked.errors.slice(0, 12), payload: null }
  }
  const errors = []
  const wantsScene = checked.skin.backdrop?.scene === true

  if (wantsScene) {
    if (typeof scene !== 'string' || scene === '') {
      errors.push('This skin draws a scene (backdrop.scene is true) but has no scene.svg.')
    } else {
      const sceneCheck = deps.validateScene(scene)

      if (!sceneCheck.ok) {
        errors.push(...sceneCheck.errors.slice(0, 8).map(e => `scene: ${e}`))
      }
    }
  }
  const colors = colorsProblem(checked.skin, deps.makeColors)

  if (colors !== null) {
    errors.push(colors)
  }
  if (errors.length > 0) {
    return { ok: false, errors, payload: null }
  }
  // The server ignores author/version; leave them out. A scene is refused unless backdrop.scene is true.
  const { author, version, ...body } = checked.skin
  const payload = wantsScene ? { skin: body, scene } : { skin: body }
  const bytes = Buffer.byteLength(JSON.stringify(payload))

  if (bytes > UPLOAD_MAX_BYTES) {
    return { ok: false, errors: [`The upload is ${Math.round(bytes / 1024)} KB; the gallery takes at most 300 KB.`], payload: null }
  }

  return { ok: true, errors: [], payload }
}

const snap = (value, v) => {
  const steps = Math.round((value - v.min) / v.step)
  const out = Math.min(v.max, Math.max(v.min, v.min + steps * v.step))

  return Number(out.toFixed(6))
}

// A copy of a validated skin whose variable defaults are the current values.
// Universal settings (dim, blur, ...) stay per-user and are not baked in.
const bakeTuning = (skin, vars, { slug, name }) => {
  if (typeof slug !== 'string' || !SLUG.test(slug)) {
    throw new Error('The new name must be 3 to 40 of a-z, 0-9 and inner hyphens')
  }
  const copy = structuredClone(skin)

  delete copy.author
  delete copy.version
  copy.slug = slug
  if (typeof name === 'string' && name.trim() !== '') {
    copy.name = name.trim().slice(0, 40)
  }
  for (const v of Array.isArray(copy.variables) ? copy.variables : []) {
    const value = vars?.[v.key]

    if (v.type === 'color' && typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value)) {
      v.default = value.toLowerCase()
    } else if (v.type === 'range' && typeof value === 'number' && Number.isFinite(value)) {
      v.default = snap(value, v)
    } else if (v.type === 'toggle' && typeof value === 'boolean') {
      v.default = value
    }
  }

  return copy
}

// A slug that is free in the given set, derived from a base.
const freeSlug = (base, taken) => {
  const stem = String(base).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'skin'
  const ok = s => SLUG.test(s) && !taken.has(s)

  for (let i = 2; i < 100; i++) {
    const candidate = `${stem}-${i}`

    if (ok(candidate)) {
      return candidate
    }
  }

  return `${stem}-${Date.now().toString(36)}`.slice(0, 40)
}

module.exports = { importFolder, prepareUpload, bakeTuning, freeSlug, UPLOAD_MAX_BYTES }
