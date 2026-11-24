'use strict'

// The skin library: <home>/.claude-theme-switcher/skins/<ref>/{skin.json, scene.svg?, meta.json}.
// Everything read from disk passes validateSkin / validateScene; a broken skin
// becomes an entry with errors, never a throw.

const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const { renameWithRetry } = require('./atomic')
const { REF, colorsInput, parseSkin } = require('./skin-render')

const OWNER = /^[a-z0-9][a-z0-9-]{0,38}$/
// Windows opens a device, not a folder, for "con.anything" and the like.
const WINDOWS_DEVICE = /^(?:con|prn|aux|nul|com\d|lpt\d)$/
const SOURCES = new Set(['bundled', 'gallery', 'upload', 'local'])
const SKIN_MAX_BYTES = 200 * 1024
const SCENE_MAX_BYTES = 480 * 1024 // 120,000 chars of up to 4 UTF-8 bytes; the char limit is checked after reading

const skinsDir = stateDir => path.join(stateDir, 'skins')

// Builds a ref from a validated owner and slug; null if either is unusable.
const makeRef = (owner, slug) => {
  const lower = String(owner).toLowerCase()
  const ref = `${lower}.${slug}`

  return OWNER.test(lower) && !WINDOWS_DEVICE.test(lower) && REF.test(ref) ? ref : null
}

const readCapped = async (file, max) => {
  const stat = await fs.promises.stat(file)

  if (!stat.isFile()) {
    throw new Error(`${path.basename(file)} is not a file`)
  }
  if (stat.size > max) {
    throw new Error(`${path.basename(file)} is too large`)
  }

  return fs.promises.readFile(file, 'utf8')
}

const readOptional = async (file, max) => {
  try {
    return await readCapped(file, max)
  } catch (error) {
    if (error.code === 'ENOENT') {
      return null
    }
    throw error
  }
}

// makeColors throws on anchors it can't use and lists "Desktop won't paint"
// problems for unreadable ones; either way the skin won't draw in Claude.
const colorsProblem = (skin, makeColors) => {
  try {
    const { problems } = makeColors(colorsInput(parseSkin(skin), null))
    const fatal = (Array.isArray(problems) ? problems : []).find(p => /won't paint/i.test(String(p)))

    return fatal === undefined ? null : `colors: ${String(fatal)}`
  } catch (error) {
    return `colors: ${String(error?.message ?? error)}`
  }
}

const checkMeta = (raw, owner, rawVersion) => {
  const meta = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}

  return {
    author: typeof meta.author === 'string' && OWNER.test(meta.author) ? meta.author : owner,
    version: Number.isSafeInteger(meta.version) && meta.version > 0 ? meta.version : Number.isSafeInteger(rawVersion) && rawVersion > 0 ? rawVersion : null,
    source: SOURCES.has(meta.source) ? meta.source : owner === 'official' ? 'bundled' : 'local',
    // A remix: the gallery skin this one was made from, "<author>.<slug>".
    ...(typeof meta.basedOn === 'string' && REF.test(meta.basedOn) ? { basedOn: meta.basedOn } : {}),
  }
}

// One library entry. `deps` = { validateSkin, validateScene, makeColors }.
const readEntry = async (libDir, ref, deps) => {
  const [owner, slug] = ref.split('.')
  const dir = path.join(libDir, ref)
  const entry = { ref, owner, slug, ok: false, errors: [], skin: null, hasScene: false, meta: checkMeta(null, owner, null) }

  try {
    const text = await readCapped(path.join(dir, 'skin.json'), SKIN_MAX_BYTES)
    const raw = JSON.parse(text)
    const checked = deps.validateSkin(raw)
    const metaText = await readOptional(path.join(dir, 'meta.json'), 16 * 1024).catch(() => null)
    let metaRaw = null

    try {
      metaRaw = metaText === null ? null : JSON.parse(metaText)
    } catch {
      metaRaw = null
    }
    entry.meta = checkMeta(metaRaw, owner, raw?.version)
    if (!checked.ok) {
      entry.errors = checked.errors.slice(0, 8)

      return entry
    }
    if (checked.skin.slug !== slug) {
      entry.errors = [`slug "${checked.skin.slug}" does not match the folder name`]

      return entry
    }
    entry.skin = checked.skin
    if (checked.skin.backdrop?.scene === true) {
      const scene = await readOptional(path.join(dir, 'scene.svg'), SCENE_MAX_BYTES)
      const sceneCheck = scene === null ? { ok: false, errors: ['scene.svg is missing'] } : deps.validateScene(scene)

      if (!sceneCheck.ok) {
        entry.errors = sceneCheck.errors.slice(0, 8).map(e => `scene: ${e}`)

        return entry
      }
      entry.hasScene = true
    }
    const problem = colorsProblem(checked.skin, deps.makeColors)

    if (problem !== null) {
      entry.errors = [problem]

      return entry
    }
    entry.ok = true
  } catch (error) {
    entry.errors = [String(error?.message ?? error)]
  }

  return entry
}

const listRefs = async libDir => {
  try {
    return (await fs.promises.readdir(libDir, { withFileTypes: true }))
      .filter(d => d.isDirectory() && REF.test(d.name))
      .map(d => d.name)
  } catch {
    return []
  }
}

// Official skins first, then the rest by name.
const sortEntries = entries =>
  entries.slice().sort((a, b) => {
    const ao = a.owner === 'official' ? 0 : 1
    const bo = b.owner === 'official' ? 0 : 1

    if (ao !== bo) {
      return ao - bo
    }
    const an = (a.skin?.name ?? a.ref).toLowerCase()
    const bn = (b.skin?.name ?? b.ref).toLowerCase()

    return an < bn ? -1 : an > bn ? 1 : a.ref < b.ref ? -1 : 1
  })

const listLibrary = async (libDir, deps) => sortEntries(await Promise.all((await listRefs(libDir)).map(ref => readEntry(libDir, ref, deps))))

// The validated scene text of a library skin.
const readScene = async (libDir, ref, deps) => {
  if (!REF.test(ref)) {
    throw new Error('not a skin name')
  }
  const text = await readCapped(path.join(libDir, ref, 'scene.svg'), SCENE_MAX_BYTES)
  const check = deps.validateScene(text)

  if (!check.ok) {
    throw new Error(`scene: ${check.errors[0]}`)
  }

  return text
}

// The two files the bridge reads, as text, plus the validator's verdict on
// them (shared/skin-validate.js only). Used for the Code tab.
const codeOf = (skinText, sceneText, deps) => {
  const errors = []
  let wantsScene = false

  try {
    const checked = deps.validateSkin(JSON.parse(skinText))

    if (checked.ok) {
      wantsScene = checked.skin.backdrop?.scene === true
    } else {
      errors.push(...checked.errors)
    }
  } catch (error) {
    errors.push(`skin.json: ${String(error?.message ?? error)}`)
  }
  if (wantsScene) {
    const sceneCheck = typeof sceneText === 'string' ? deps.validateScene(sceneText) : { ok: false, errors: ['scene.svg is missing'] }

    errors.push(...sceneCheck.errors.map(e => `scene: ${e}`))
  }

  return { skinJson: skinText, sceneSvg: wantsScene && typeof sceneText === 'string' ? sceneText : null, check: { ok: errors.length === 0, errors: errors.slice(0, 20) } }
}

// The raw files of a library skin, exactly as they sit on disk.
const readCode = async (libDir, ref, deps) => {
  if (!REF.test(ref)) {
    throw new Error('not a skin name')
  }
  const dir = path.join(libDir, ref)
  const skinText = await readCapped(path.join(dir, 'skin.json'), SKIN_MAX_BYTES)
  const sceneText = await readOptional(path.join(dir, 'scene.svg'), SCENE_MAX_BYTES)

  return codeOf(skinText, sceneText, deps)
}

// skin.json exactly as saveSkin writes it for this owner and meta.
const skinFileText = (skin, author, version) => `${JSON.stringify({ ...skin, author, ...(version !== null ? { version } : {}) }, null, 2)}\n`

const rand = () => crypto.randomBytes(4).toString('hex')

// Writes a skin folder in one swap: staging sibling, then rename.
const writeSkinDir = async (libDir, ref, files) => {
  if (!REF.test(ref)) {
    throw new Error('not a skin name')
  }
  const dest = path.join(libDir, ref)
  const staging = path.join(libDir, `.${ref}.staging-${rand()}`)

  await fs.promises.mkdir(staging, { recursive: true })
  try {
    for (const [name, data] of Object.entries(files)) {
      if (!['skin.json', 'scene.svg', 'meta.json'].includes(name)) {
        throw new Error(`unexpected file ${name}`)
      }
      await fs.promises.writeFile(path.join(staging, name), data)
    }
    let old = null

    if (fs.existsSync(dest)) {
      old = path.join(libDir, `.${ref}.old-${rand()}`)
      await renameWithRetry(dest, old)
    }
    try {
      await renameWithRetry(staging, dest)
    } catch (error) {
      if (old !== null) {
        await renameWithRetry(old, dest).catch(() => {})
      }
      throw error
    }
    if (old !== null) {
      // The previous copy of this skin's files, written by this app.
      await fs.promises.rm(old, { recursive: true, force: true }).catch(() => {})
    }
  } finally {
    await fs.promises.rm(staging, { recursive: true, force: true }).catch(() => {})
  }

  return dest
}

// Deletes one library skin folder. Refuses official skins (syncOfficial would
// bring them back), anything that is not a plain ref, and any path that does not
// resolve to a direct child of the skins folder.
const removeSkinDir = async (libDir, ref) => {
  if (typeof ref !== 'string' || !REF.test(ref) || ref.includes('..') || ref.includes('/') || ref.includes('\\')) {
    throw new Error(`Not a skin name: ${String(ref)}`)
  }
  if (ref.split('.')[0] === 'official') {
    throw new Error('Built-in skins cannot be deleted')
  }
  const base = path.resolve(libDir)
  const dir = path.resolve(base, ref)

  if (path.dirname(dir) !== base || path.basename(dir) !== ref) {
    throw new Error(`Not inside the skins folder: ${ref}`)
  }
  const stat = await fs.promises.lstat(dir)

  if (!stat.isDirectory()) {
    throw new Error(`${ref} is not a skin folder`)
  }
  await fs.promises.rm(dir, { recursive: true, force: false })
}

// Validates and saves a skin under <owner>.<slug>. Returns { ok, ref, errors }.
const saveSkin = async ({ libDir, owner, skin, scene, meta, deps }) => {
  const checked = deps.validateSkin(skin)

  if (!checked.ok) {
    return { ok: false, errors: checked.errors }
  }
  const ref = makeRef(owner, checked.skin.slug)

  if (ref === null) {
    return { ok: false, errors: [`"${owner}" is not a usable owner`] }
  }
  const wantsScene = checked.skin.backdrop?.scene === true
  const files = {}

  if (wantsScene) {
    if (typeof scene !== 'string') {
      return { ok: false, errors: ['scene.svg is required when backdrop.scene is true'] }
    }
    const sceneCheck = deps.validateScene(scene)

    if (!sceneCheck.ok) {
      return { ok: false, errors: sceneCheck.errors.map(e => `scene: ${e}`) }
    }
    files['scene.svg'] = scene
  }
  const problem = colorsProblem(checked.skin, deps.makeColors)

  if (problem !== null) {
    return { ok: false, errors: [problem] }
  }
  // The author is always the ref's owner, whatever the caller's meta says.
  const m = { ...checkMeta(meta, owner.toLowerCase(), null), author: owner.toLowerCase() }
  files['skin.json'] = skinFileText(checked.skin, m.author, m.version)
  files['meta.json'] = `${JSON.stringify({ ...m, savedAt: Date.now() }, null, 2)}\n`
  await writeSkinDir(libDir, ref, files)

  return { ok: true, ref, errors: [] }
}

// Copies each bundled official skin into the library byte for byte when it is
// missing or differs. Returns the refs that changed.
const syncOfficial = async ({ bundledDir, libDir, deps }) => {
  const changed = []
  let names = []

  try {
    names = (await fs.promises.readdir(bundledDir, { withFileTypes: true })).filter(d => d.isDirectory() && /^official\./.test(d.name) && REF.test(d.name)).map(d => d.name)
  } catch {
    return changed
  }
  for (const ref of names) {
    try {
      const src = path.join(bundledDir, ref)
      const skinText = await readCapped(path.join(src, 'skin.json'), SKIN_MAX_BYTES)
      const sceneText = await readOptional(path.join(src, 'scene.svg'), SCENE_MAX_BYTES)
      const raw = JSON.parse(skinText)

      if (!deps.validateSkin(raw).ok || (sceneText !== null && !deps.validateScene(sceneText).ok)) {
        continue
      }
      const dest = path.join(libDir, ref)
      const haveSkin = await readOptional(path.join(dest, 'skin.json'), SKIN_MAX_BYTES).catch(() => null)
      const haveScene = await readOptional(path.join(dest, 'scene.svg'), SCENE_MAX_BYTES).catch(() => null)

      if (haveSkin === skinText && haveScene === sceneText) {
        continue
      }
      // The gallery lists official skins too; a newer copy saved from there wins.
      const version = Number.isSafeInteger(raw.version) && raw.version > 0 ? raw.version : null
      const haveMeta = await readOptional(path.join(dest, 'meta.json'), 16 * 1024).catch(() => null)
      let haveVersion = null

      try {
        haveVersion = haveMeta === null ? null : JSON.parse(haveMeta).version
      } catch {
        haveVersion = null
      }
      if (haveSkin !== null && Number.isSafeInteger(haveVersion) && version !== null && haveVersion > version) {
        continue
      }
      const files = { 'skin.json': skinText }

      if (sceneText !== null) {
        files['scene.svg'] = sceneText
      }
      files['meta.json'] = `${JSON.stringify({ author: 'official', version, source: 'bundled', savedAt: Date.now() }, null, 2)}\n`
      await fs.promises.mkdir(libDir, { recursive: true })
      await writeSkinDir(libDir, ref, files)
      changed.push(ref)
    } catch {
      // A bundled skin that can't be read is skipped; the library keeps its copy.
    }
  }

  return changed
}

module.exports = { OWNER, skinsDir, makeRef, readEntry, listLibrary, readScene, readCode, codeOf, skinFileText, checkMeta, writeSkinDir, saveSkin, syncOfficial, colorsProblem, removeSkinDir }
