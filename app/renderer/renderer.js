'use strict'

// Everything shown here is text (textContent) or a blob: image built from an
// already validated SVG. No innerHTML, no network: main does all of that.

const api = window.switcher
const R = window.SkinRender
// Unapplied tuning per skin; selection.settings holds what was applied.
const drafts = window.Drafts.createDrafts(R.sparseSettings)
const $ = id => document.getElementById(id)

const POLL_MS = 5000
const CONFIRM_MS = 3000
// The preview always draws the scene at this context fill (a representative middle).
const PREVIEW_FILL_PCT = 40
const systemDark = window.matchMedia('(prefers-color-scheme: dark)')

// Claude's own look for the "Claude default" row (approximate).
const DEFAULT_SKIN = {
  format: 1,
  slug: 'default',
  name: 'Claude',
  colors: {
    roles: { accent: '#d97757' },
    dark: { anchors: { 'surface-0': '#262624', 'surface-1': '#30302e', 'text-primary': '#f5f4ef', 'text-muted': '#a6a39a' } },
    light: { anchors: { 'surface-0': '#faf9f5', 'surface-1': '#f0eee6', 'text-primary': '#1f1e1d', 'text-muted': '#73726c' } },
  },
}

let S = {}
let library = [] // entries from main
let selection = { theme: null, settings: {} }
let view = 'skin' // skin | gallery | upload | settings
let subject = null // what the skin view shows
let tab = 'overview'
let mode = systemDark.matches ? 'dark' : 'light'
let modeChosen = false
let status = { state: 'checking' }
let busy = false
let confirmTimer = null
let isShot = false
let appVersion = ''
let platform = ''
let language = 'system' // the Settings choice: system | en | zh
let autoUpdate = true
let update = { status: 'idle', latest: null, progress: null, error: null }
let checkedByClick = false // "You're up to date" only after a click
const thumbs = new Map() // ref -> blob url
const openGroups = new Set(['backdrop', 'vars'])

const fill = (text, vars) => text.replace(/\{(\w+)\}/g, (_, k) => (vars[k] === undefined ? `{${k}}` : String(vars[k])))
const downloadsText = n => fill(n === 1 ? S.downloadsOne : S.downloadsN, { n })
const cleanError = error => String(error?.message ?? error).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
const el = (tag, className, text) => {
  const node = document.createElement(tag)

  if (className) {
    node.className = className
  }
  if (text !== undefined && text !== null) {
    node.textContent = text
  }

  return node
}
const button = (className, text, onClick) => {
  const b = el('button', className, text)

  b.type = 'button'
  if (onClick) {
    b.addEventListener('click', onClick)
  }

  return b
}
const entryByRef = ref => library.find(e => e.ref === ref)
const nextFrame = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))

const showConfirm = text => {
  const c = $('confirm')

  c.textContent = text
  c.classList.add('show')
  clearTimeout(confirmTimer)
  confirmTimer = setTimeout(() => c.classList.remove('show'), CONFIRM_MS)
}

// ---------- scene images ----------

let sceneUrl = null
let sceneSvg = null
let scenePending = null
let sceneLoaded = Promise.resolve()

const svgUrl = svg => URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }))

const setScene = svg => {
  const img = $('scene')

  if (svg === null) {
    img.hidden = true
    img.removeAttribute('src')
    if (sceneUrl) {
      URL.revokeObjectURL(sceneUrl)
    }
    sceneUrl = null
    sceneSvg = null
    sceneLoaded = Promise.resolve()

    return
  }
  if (svg === sceneSvg) {
    return
  }
  // At most one rebuild per frame while a slider is being dragged.
  const first = scenePending === null

  scenePending = svg
  if (!first) {
    return
  }
  sceneLoaded = new Promise(resolve => {
    requestAnimationFrame(() => {
      const next = scenePending
      const old = sceneUrl

      scenePending = null
      sceneSvg = next
      sceneUrl = svgUrl(next)
      img.onload = img.onerror = () => {
        if (old) {
          URL.revokeObjectURL(old)
        }
        resolve()
      }
      img.src = sceneUrl
      img.hidden = false
    })
  })
}

const thumbFor = async entry => {
  if (!entry.ok || !entry.hasScene || thumbs.has(entry.ref)) {
    return
  }
  try {
    const scene = await api.scene(entry.ref)
    const skin = R.parseSkin(entry.skin)
    const settings = { ...R.normalizeSettings(selection.settings[entry.ref], skin), motion: false }
    const svg = R.forceScheme(R.renderScene(scene, settings, 0.5), systemDark.matches ? 'dark' : 'light')

    thumbs.set(entry.ref, svgUrl(svg))
  } catch {
    // the row keeps its colour swatch
  }
}

// ---------- sidebar ----------

const libraryRows = () => [...library.map(e => ({ ref: e.ref, entry: e })), { ref: 'default', entry: null }]

const buildRow = ({ ref, entry }) => {
  const row = el('button', 'row')

  row.type = 'button'
  row.dataset.ref = ref
  row.setAttribute('role', 'option')
  const thumb = el('span', 'thumb')

  if (entry === null) {
    const c = R.mockColors(DEFAULT_SKIN, null, systemDark.matches ? 'dark' : 'light')

    thumb.style.backgroundColor = c.surface0
    thumb.append(el('span', 'thumb-dot'))
    thumb.lastChild.style.backgroundColor = c.accent
  } else if (!entry.ok) {
    thumb.classList.add('thumb-broken')
    thumb.textContent = '!'
  } else if (thumbs.has(ref)) {
    const img = el('img')

    img.src = thumbs.get(ref)
    img.alt = ''
    img.draggable = false
    thumb.append(img)
  } else {
    const c = R.mockColors(entry.skin, null, systemDark.matches ? 'dark' : 'light')

    thumb.style.backgroundColor = c.surface0
    thumb.append(el('span', 'thumb-dot'))
    thumb.lastChild.style.backgroundColor = c.accent
  }
  const text = el('span', 'row-text')

  text.append(el('span', 'row-name', entry === null ? S.claudeDefault : entry.ok ? entry.skin.name : ref))
  if (entry !== null && !entry.ok) {
    text.append(el('span', 'row-sub warn', S.brokenRow))
  }
  const badge = el('span', 'badge', S.active)
  const dot = el('span', 'draft-dot')

  badge.hidden = true
  dot.hidden = true
  dot.title = S.draftDot
  row.append(thumb, text, dot, badge)
  row.addEventListener('click', () => showLibrary(ref))

  return row
}

const renderLibraryList = () => {
  $('lib-list').replaceChildren(...libraryRows().map(buildRow))
  renderRows()
}

const renderRows = () => {
  const current = view === 'skin' && subject?.kind !== 'gallery' ? subject?.ref : null

  for (const row of document.querySelectorAll('#lib-list .row')) {
    const on = row.dataset.ref === current

    row.setAttribute('aria-selected', on ? 'true' : 'false')
    row.tabIndex = on ? 0 : -1
    row.querySelector('.badge').hidden = row.dataset.ref !== selection.theme
    row.querySelector('.draft-dot').hidden = !drafts.has(row.dataset.ref)
  }
  for (const row of document.querySelectorAll('.nav-row')) {
    const on = row.dataset.view === view || (row.dataset.view === 'gallery' && view === 'skin' && subject?.kind === 'gallery')

    row.setAttribute('aria-selected', on ? 'true' : 'false')
  }
}

const onListKey = event => {
  const refs = libraryRows().map(r => r.ref)
  const i = refs.indexOf(subject?.ref)

  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault()
    const next = refs[(i + (event.key === 'ArrowDown' ? 1 : -1) + refs.length) % refs.length]

    showLibrary(next)
    document.querySelector(`#lib-list .row[data-ref="${CSS.escape(next)}"]`)?.focus()
  } else if (event.key === 'Enter') {
    event.preventDefault()
    apply()
  }
}

// ---------- bridge ----------

const statusText = s =>
  ({ connected: S.statusConnected, installed: S.statusInstalled, 'not-installed': S.statusNotInstalled })[s.state] ?? S.statusChecking

const renderStatus = () => {
  $('bridge-dot').dataset.state = status.state
  $('bridge-text').textContent = statusText(status)
  $('bridge-sub').textContent = [status.version ? `v${status.version}` : null, status.platform].filter(Boolean).join(' · ') || S.pluginUnknown
  $('bridge-error').hidden = !status.error
  $('bridge-error').textContent = status.error ? fill(S.bridgeError, { error: status.error }) : ''
  const b = $('install')

  b.hidden = status.state === 'checking' && !busy
  b.disabled = busy
  b.classList.toggle('busy', busy)
  $('install-label').textContent = busy ? S.installing : status.state === 'not-installed' ? S.install : S.reinstall
  // The sidebar's only hint that Install lives in Settings (never while still
  // checking), or that a new version is ready to install.
  const bridgeAttention = !busy && (status.state === 'not-installed' || Boolean(status.error))
  const updateAttention = update.status === 'available' && Boolean(update.latest)
  const hint = [bridgeAttention ? S.settingsAttention : null, updateAttention ? fill(S.updateAvailable, { v: update.latest }) : null].filter(Boolean).join(' · ')

  $('settings-dot').hidden = hint === ''
  $('settings-dot').title = hint
  $('nav-settings').setAttribute('aria-label', hint ? `${S.settingsNav} · ${hint}` : S.settingsNav)
}

const showInstallResult = result => {
  const ok = result.ok === true

  $('install-ok').hidden = !ok
  $('install-details').hidden = ok
  if (ok) {
    const okSettings = result.backup ? S.installOkSettings : S.installOkSettingsNew

    $('install-ok').textContent = result.method === 'settings' ? fill(okSettings, { file: result.settingsFileShown }) : S.installOkCli

    return
  }
  let text = S.installFailCli

  if (result.error) {
    text = fill(S.installError, { error: result.error })
  } else if (result.method === 'settings') {
    text = fill(result.reason === 'invalid-json' ? S.installFailInvalid : S.installFailShape, { file: result.settingsFileShown })
  }
  $('install-summary').textContent = S.installFailed
  $('install-text').textContent = text
  const manual = Array.isArray(result.manual) ? result.manual.join('\n') : ''

  $('manual-text').hidden = manual === ''
  $('manual-text').textContent = manual
  $('manual-copy').hidden = manual === ''
  $('manual-copy').textContent = S.copy
  $('install-log').hidden = !result.log
  $('install-log').textContent = result.log ?? ''
}

const install = async () => {
  if (busy) {
    return
  }
  busy = true
  $('install-ok').hidden = true
  $('install-details').hidden = true
  renderStatus()
  try {
    showInstallResult(await api.install())
  } catch (error) {
    showInstallResult({ ok: false, error: cleanError(error) })
  } finally {
    busy = false
    status = await api.status().catch(() => status)
    renderStatus()
  }
}

// ---------- views ----------

const setView = next => {
  view = next
  for (const v of ['skin', 'gallery', 'upload', 'settings']) {
    $(`view-${v}`).hidden = v !== next
  }
  renderRows()
}

// subject: { kind: 'library'|'default'|'gallery', ref, skin, parsed, scene, entry?, detail? }
const showLibrary = async ref => {
  const entry = ref === 'default' ? null : entryByRef(ref)

  if (ref !== 'default' && entry === undefined) {
    return
  }
  const s = { kind: entry === null ? 'default' : 'library', ref, entry, skin: entry === null ? DEFAULT_SKIN : entry.skin, scene: null }

  subject = s
  hideAsk()
  setView('skin')
  if (entry && entry.ok && entry.hasScene) {
    try {
      s.scene = await api.scene(ref)
    } catch {
      s.scene = null
    }
  }
  if (subject === s) {
    renderSkin()
  }
}

const settingsFor = () => {
  if (!subject || subject.kind === 'default' || (subject.entry && !subject.entry.ok)) {
    return null
  }
  const raw = subject.kind === 'gallery' ? {} : drafts.current(subject.ref, selection.settings)

  return R.normalizeSettings(raw, R.parseSkin(subject.skin))
}

const renderSkin = () => {
  const s = subject
  const broken = s.entry !== null && s.entry !== undefined && !s.entry.ok
  const gallery = s.kind === 'gallery'

  $('back').hidden = !gallery
  $('back').textContent = `‹ ${S.back}`
  $('skin-name').textContent = s.kind === 'default' ? S.claudeDefault : broken ? s.ref : s.skin.name
  const remix = gallery ? remixOfItem(s.detail.basedOn ? s.detail : s.item) : null
  const desc = s.kind === 'default' ? S.claudeDefaultDesc : broken ? S.brokenTitle : gallery ? [fill(S.byAuthor, { author: s.detail.author }), `v${s.detail.version}`, s.item ? downloadsText(s.item.downloads) : null, remix].filter(Boolean).join(' · ') : (s.skin.description ?? '')

  $('skin-desc').textContent = desc
  $('skin-desc').title = desc
  $('tabs').hidden = broken || s.kind === 'default'
  $('skin-body').hidden = broken
  $('broken').hidden = !broken
  $('report').hidden = !gallery
  $('delete').hidden = !(s.kind === 'library' && deletable(s.entry))
  $('delete').textContent = S.deleteSkin
  $('discard').hidden = true
  if (s.kind === 'default' || broken) {
    tab = 'overview'
  }
  if (broken) {
    $('broken-text').textContent = fill(S.brokenText, { dir: `…/skins/${s.ref}` })
    $('broken-list').replaceChildren(...s.entry.errors.map(e => el('li', null, e)))
  }
  renderTabs()
  renderHead()
  if (!broken) {
    renderPreview()
    renderDetails()
    renderTune()
  }
}

const renderTabs = () => {
  for (const b of document.querySelectorAll('#tabs [role="tab"]')) {
    b.setAttribute('aria-selected', b.dataset.tab === tab ? 'true' : 'false')
  }
  $('pane-overview').hidden = tab !== 'overview'
  $('pane-tune').hidden = tab !== 'tune'
  $('pane-code').hidden = tab !== 'code'
  $('skin-body').classList.toggle('code-mode', tab === 'code')
  if (tab === 'code') {
    renderCode()
  }
}

// ---------- code tab ----------

// The raw files, shown as text only (textContent in <pre><code>), never rendered.
const showCodeFile = (which, text) => {
  $(`code-${which}`).textContent = text ?? ''
  $(`code-${which}-count`).textContent = text === null || text === undefined ? '' : fill(S.codeChars, { n: text.length.toLocaleString() })
  $(`code-${which}-copy`).hidden = text === null || text === undefined
  $(`code-${which}-copy`).textContent = S.copy
}

const renderCode = async () => {
  const s = subject

  if (s === null || s.kind === 'default') {
    return
  }
  if (s.codeLoad === undefined) {
    // Gallery details carry their files from main; library files are read on demand.
    s.codeLoad = s.kind === 'gallery' ? Promise.resolve(s.detail?.code ?? { error: 'no files' }) : api.code(s.ref).catch(error => ({ error: cleanError(error) }))
    $('code-check').textContent = S.codeLoading
    $('code-check').className = 'code-check'
  }
  const code = await s.codeLoad

  if (subject !== s || tab !== 'code') {
    return
  }
  const ok = code.check?.ok === true
  const errors = code.error ? [] : (code.check?.errors ?? [])

  $('code-check').textContent = code.error ? fill(S.codeError, { error: code.error }) : ok ? S.codeChecksOk : S.codeChecksBad
  $('code-check').className = `code-check ${ok ? 'ok' : 'bad'}`
  $('code-errors').hidden = errors.length === 0
  $('code-errors').replaceChildren(...errors.map(e => el('li', null, e)))
  $('code-note').textContent = s.kind === 'gallery' ? S.codeNoteGallery : S.codeNote
  showCodeFile('skin', code.skinJson ?? null)
  const scene = typeof code.sceneSvg === 'string' ? code.sceneSvg : null

  showCodeFile('scene', scene)
  $('code-scene-pre').hidden = scene === null
  $('code-no-scene').hidden = scene !== null || Boolean(code.error)
  $('code-no-scene').textContent = S.codeNoScene
}

const copyCode = async which => {
  const b = $(`code-${which}-copy`)

  try {
    await navigator.clipboard.writeText($(`code-${which}`).textContent)
    b.textContent = S.copied
    setTimeout(() => {
      b.textContent = S.copy
    }, CONFIRM_MS)
  } catch {
    window.getSelection().selectAllChildren($(`code-${which}`))
  }
}

const renderHead = () => {
  const s = subject
  const apply = $('apply')
  const modes = s.entry && !s.entry.ok ? [] : R.modesOf(s.skin)

  for (const b of document.querySelectorAll('#view-skin .segmented button')) {
    b.setAttribute('aria-checked', b.dataset.mode === mode ? 'true' : 'false')
    b.disabled = modes.length > 0 && !modes.includes(b.dataset.mode)
  }
  if (s.kind === 'gallery') {
    const saved = s.detail.savedVersion
    const upToDate = saved !== null && saved >= s.detail.version

    apply.textContent = s.saving ? S.saving : upToDate ? `${S.savedBadge} ✓` : saved !== null ? fill(S.updateTo, { v: s.detail.version }) : S.saveToLibrary
    apply.disabled = upToDate || s.saving === true
    $('report').textContent = s.reported ? S.reported : S.report
    $('report').disabled = s.reported === true

    return
  }
  const broken = Boolean(s.entry && !s.entry.ok)
  const state = drafts.button(s.ref, selection.theme)

  apply.textContent = state === 'applied' ? S.applied : state === 'apply-changes' ? S.applyChanges : S.apply
  apply.disabled = state === 'applied' || broken || s.applying === true
  $('discard').hidden = state !== 'apply-changes'
}

const setVars = (node, vars) => {
  for (const [k, v] of Object.entries(vars)) {
    node.style.setProperty(k, v)
  }
}

const renderPreview = () => {
  const s = subject
  const settings = settingsFor()
  const c = R.mockColors(s.skin, settings, mode)
  const shape = R.mockShape(s.skin, settings ?? { textSize: null, bubbleRadius: null })
  const preview = $('preview')
  const hasScene = typeof s.scene === 'string'

  setVars(preview, {
    '--t-surface0': c.surface0,
    '--t-surface1': c.surface1,
    '--t-surface2': c.surface2,
    '--t-text': c.text,
    '--t-muted': c.muted,
    '--t-accent': c.accent,
    '--t-border': c.border,
    '--t-bubble-bg': c.surface2,
    '--t-bubble-radius': `${Math.round(shape.bubbleRadius * 0.85)}px`,
    '--t-bubble-border': shape.bubbleBorder > 0 ? `1px solid ${c.borderStrong}` : '0',
    '--t-text-size': `${(shape.textSize * 0.85).toFixed(1)}px`,
    '--t-panel': hasScene && settings ? `${Math.round(settings.panelOpacity * 100)}%` : '100%',
    '--t-blur': hasScene && settings ? `${(settings.blur * 0.5).toFixed(1)}px` : '0px',
  })
  preview.dataset.mono = shape.headingMono ? 'true' : 'false'
  preview.dataset.scene = hasScene ? 'true' : 'false'

  if (!hasScene || settings === null) {
    setScene(null)

    return
  }
  const f = R.fillFor(settings, R.toPercent(PREVIEW_FILL_PCT))

  setScene(R.forceScheme(R.renderScene(s.scene, settings, f), c.mode))
}

const chip = color => {
  const c = el('span', 'chip')
  const sw = el('span', 'chip-color')

  sw.style.backgroundColor = color
  c.append(sw, el('span', 'chip-hex', color))

  return c
}

const renderDetails = () => {
  const s = subject
  const dl = $('details')
  const settings = settingsFor()
  const add = (key, value, mono) => {
    const dd = el('dd', mono ? 'mono' : null)

    if (typeof value === 'string') {
      dd.textContent = value
    } else {
      dd.append(...value)
    }
    dl.append(el('dt', null, key), dd)
  }

  dl.replaceChildren()
  const c = R.mockColors(s.skin, settings, mode)

  add(S.keyPalette, [c.surface0, c.surface1, c.text, c.accent].map(chip))
  if (s.kind === 'default') {
    add(S.keyBackdrop, S.backdropNone)
    add(S.keyModes, S.modesBoth)

    return
  }
  const modes = R.modesOf(s.skin)

  // From the scene text itself (library and gallery alike); "Scene" until it has loaded.
  const backdropText = {
    'animated-reactive': S.backdropAnimated,
    animated: S.backdropAnimatedOnly,
    'still-reactive': S.backdropStillReactive,
    still: S.backdropStill,
    scene: S.backdropScene,
    solid: S.backdropSolid,
    none: S.backdropNone,
  }

  add(S.keyBackdrop, backdropText[window.Backdrop.describeBackdrop(s.skin, s.scene)])
  add(S.keyModes, modes.length === 2 ? S.modesBoth : modes[0] === 'dark' ? S.modesDark : S.modesLight)
  add(S.keyType, R.mockShape(s.skin, settings).headingMono ? S.typeMono : S.typeDefault)
  const vars = s.skin.variables ?? []

  add(S.keyKnobs, vars.length ? vars.map(v => v.label).join(', ') : S.knobsNone)
  if (s.kind === 'gallery') {
    add(S.keyAuthor, s.detail.author)
    add(S.keyVersion, `v${s.detail.version}`)
    if (s.item) {
      add(S.keyDownloads, String(s.item.downloads))
      if (s.item.tags.length) {
        add(S.keyTags, s.item.tags.join(', '))
      }
      if (s.item.updatedAt) {
        add(S.keyUpdated, new Date(s.item.updatedAt).toLocaleDateString())
      }
    }
  } else {
    const meta = s.entry.meta

    add(S.keyAuthor, meta.author ?? s.entry.owner)
    add(S.keyVersion, `v${meta.version ?? 1}`)
    add(S.keySource, { bundled: S.sourceBundled, gallery: S.sourceGallery, upload: S.sourceUpload, local: S.sourceLocal }[meta.source] ?? '—')
    if (meta.basedOn) {
      const original = entryByRef(meta.basedOn)

      add(S.keyRemix, remixText({ ref: meta.basedOn, name: original?.ok ? original.skin.name : null }))
    }
  }
  add('Ref', s.ref, true)
}

// ---------- tuning ----------

const fmt = (key, value) => {
  if (key === 'blur' || key === 'textSize' || key === 'bubbleRadius') {
    return `${value}px`
  }
  if (key === 'panelOpacity' || key === 'dim' || key === 'fixedFill') {
    return `${Math.round(value * 100)}%`
  }

  return String(Number(value.toFixed(3)))
}

// Tuning edits only the draft: the preview follows at once, nothing is written
// until Apply / Apply changes.
const changeSetting = (path, value) => {
  const s = subject

  if (s.kind !== 'library') {
    return
  }
  const raw = structuredClone(drafts.current(s.ref, selection.settings))

  if (path[0] === 'vars') {
    raw.vars = { ...(raw.vars ?? {}), [path[1]]: value }
  } else if (value === null) {
    delete raw[path[0]]
  } else {
    raw[path[0]] = value
  }
  drafts.set(s.ref, raw, R.parseSkin(s.skin), selection.settings)
  renderPreview()
  renderHead()
  renderRows()
  $('reset').disabled = Object.keys(R.sparseSettings(raw, R.parseSkin(s.skin))).length === 0
}

const rangeControl = (spec, value, path, label, disabled, onDraw) => {
  const wrap = el('div', 'ctl')
  const input = el('input')
  const out = el('span', 'num', fmt(path.at(-1), value))

  Object.assign(input, { type: 'range', min: spec.min, max: spec.max, step: spec.step, value: String(value), disabled })
  input.setAttribute('aria-label', label)
  input.addEventListener('input', () => {
    const v = Number(input.value)

    out.textContent = fmt(path.at(-1), v)
    changeSetting(path, v)
    onDraw?.()
  })
  wrap.append(input, out)

  return wrap
}

const switchControl = (value, path, label, disabled, after) => {
  const b = button('switch')

  b.setAttribute('role', 'switch')
  b.setAttribute('aria-checked', value ? 'true' : 'false')
  b.setAttribute('aria-label', label)
  b.disabled = disabled
  b.append(el('span', 'knob'))
  b.addEventListener('click', () => {
    const next = b.getAttribute('aria-checked') !== 'true'

    b.setAttribute('aria-checked', next ? 'true' : 'false')
    changeSetting(path, next)
    after?.()
  })
  const wrap = el('div', 'ctl')

  wrap.append(b)

  return wrap
}

// Skin palette for the picker's swatches: roles, then this mode's anchors, then the other's.
const paletteOf = skin => {
  const c = skin?.colors ?? {}
  const other = mode === 'dark' ? 'light' : 'dark'
  const values = [...Object.values(c.roles ?? {}), ...Object.values(c[mode]?.anchors ?? {}), ...Object.values(c[other]?.anchors ?? {})]

  return values.filter(v => typeof v === 'string').map(v => v.slice(0, 7))
}

// A swatch + hex button that opens the in-app picker (no <input type=color>).
const colorControl = (value, shown, path, label, disabled, nullable) => {
  const wrap = el('div', 'ctl')
  const trigger = button('color-btn')
  const chip = el('span', 'color-chip')
  const hex = el('span', 'num mono', shown)
  let def = null

  chip.style.backgroundColor = shown
  trigger.append(chip, hex)
  trigger.disabled = disabled
  trigger.dataset.key = path.join('.')
  trigger.setAttribute('aria-label', `${label}: ${shown}`)
  trigger.setAttribute('aria-haspopup', 'dialog')
  trigger.setAttribute('aria-expanded', 'false')
  trigger.addEventListener('click', () => {
    if (window.ColorPicker.isOpenFor(trigger)) {
      window.ColorPicker.close()

      return
    }
    window.ColorPicker.open({
      anchor: trigger,
      value: hex.textContent,
      label,
      palette: paletteOf(subject?.skin),
      strings: S,
      onInput: v => {
        hex.textContent = v
        chip.style.backgroundColor = v
        trigger.setAttribute('aria-label', `${label}: ${v}`)
        changeSetting(path, v)
        if (def) {
          def.setAttribute('aria-pressed', 'false')
          def.disabled = disabled
        }
      },
    })
  })
  wrap.append(trigger)
  if (nullable) {
    def = defaultChip(value === null, disabled, () => {
      changeSetting(path, null)
      renderTune()
    })
    wrap.append(def)
  }

  return wrap
}

const defaultChip = (on, disabled, onClick) => {
  const b = button('def-chip', S.skinDefault, onClick)

  b.setAttribute('aria-pressed', on ? 'true' : 'false')
  b.disabled = disabled || on

  return b
}

const nullableRange = (spec, value, fallback, path, label, disabled) => {
  const wrap = rangeControl(spec, value ?? fallback, path, label, disabled)
  const chipBtn = defaultChip(value === null, disabled, () => {
    changeSetting(path, null)
    renderTune()
  })

  wrap.querySelector('input').addEventListener('input', () => {
    chipBtn.setAttribute('aria-pressed', 'false')
    chipBtn.disabled = disabled
  })
  wrap.append(chipBtn)

  return wrap
}

const group = (id, title, rows) => {
  const g = el('section', 'tgroup')
  const head = button('tgroup-head')
  const open = openGroups.has(id)

  head.setAttribute('aria-expanded', open ? 'true' : 'false')
  head.append(el('span', 'chev', '›'), el('span', null, title))
  head.addEventListener('click', () => {
    if (openGroups.has(id)) {
      openGroups.delete(id)
    } else {
      openGroups.add(id)
    }
    renderTune()
  })
  const body = el('div', 'tgroup-body')

  body.hidden = !open
  for (const [label, control, extra] of rows) {
    const row = el('div', `trow${extra ? ` ${extra}` : ''}`)

    row.append(el('span', 'tlabel', label), control)
    body.append(row)
  }
  g.append(head, body)

  return g
}

const renderTune = () => {
  const s = subject
  const box = $('tune-groups')

  window.ColorPicker.close()

  box.replaceChildren()
  const settings = settingsFor()

  if (settings === null) {
    return
  }
  const ro = s.kind !== 'library'
  const U = R.UNIVERSAL
  const hasScene = typeof s.scene === 'string'
  const shapeDefaults = R.mockShape(s.skin, { textSize: null, bubbleRadius: null })
  const skinAccent = R.mockColors(s.skin, { accent: null }, mode).accent

  $('tune-note').textContent = ro ? S.tuneReadOnly : hasScene ? S.tuneNote : `${S.noScene} ${S.tuneNote}`
  const backdrop = [
    [S.setDim, rangeControl(U.dim, settings.dim, ['dim'], S.setDim, ro || !hasScene)],
    [S.setMotion, switchControl(settings.motion, ['motion'], S.setMotion, ro || !hasScene)],
    [S.setReactive, switchControl(settings.reactive, ['reactive'], S.setReactive, ro || !hasScene, () => renderTune())],
  ]

  if (!settings.reactive) {
    backdrop.push([S.setFixedFill, rangeControl(U.fixedFill, settings.fixedFill, ['fixedFill'], S.setFixedFill, ro || !hasScene)])
  }
  box.append(group('backdrop', S.groupBackdrop, backdrop))
  box.append(
    group('panels', S.groupPanels, [
      [S.setBlur, rangeControl(U.blur, settings.blur, ['blur'], S.setBlur, ro || !hasScene)],
      [S.setPanelOpacity, rangeControl(U.panelOpacity, settings.panelOpacity, ['panelOpacity'], S.setPanelOpacity, ro || !hasScene)],
      [S.setAccent, colorControl(settings.accent, settings.accent ?? skinAccent, ['accent'], S.setAccent, ro, true), 'wide'],
    ]),
  )
  box.append(
    group('type', S.groupType, [
      [S.setTextSize, nullableRange(U.textSize, settings.textSize, shapeDefaults.textSize, ['textSize'], S.setTextSize, ro), 'wide'],
      [S.setBubbleRadius, nullableRange(U.bubbleRadius, settings.bubbleRadius, shapeDefaults.bubbleRadius, ['bubbleRadius'], S.setBubbleRadius, ro), 'wide'],
    ]),
  )
  const vars = R.parseSkin(s.skin).variables
  const labels = Object.fromEntries((s.skin.variables ?? []).map(v => [v.key, v.label]))
  // parseSkin (like the bridge) drops `step`; the validated skin keeps it.
  const steps = Object.fromEntries((s.skin.variables ?? []).map(v => [v.key, typeof v.step === 'number' && v.step > 0 ? v.step : (v.max - v.min) / 100]))

  if (vars.length > 0) {
    box.append(
      group(
        'vars',
        S.groupVars,
        vars.map(v => {
          const label = labels[v.key] ?? v.key
          const value = settings.vars[v.key]
          const path = ['vars', v.key]
          const control =
            v.type === 'color'
              ? colorControl(value, value, path, label, ro, false)
              : v.type === 'range'
                ? rangeControl({ ...v, step: steps[v.key] }, value, path, label, ro)
                : switchControl(value, path, label, ro)

          return [label, control]
        }),
      ),
    )
  }
  $('reset').hidden = ro
  $('save-new').hidden = ro
  $('reset').disabled = Object.keys(R.sparseSettings(drafts.current(s.ref, selection.settings), R.parseSkin(s.skin))).length === 0
  if (ro) {
    $('new-form').hidden = true
  }
}

// Reset and Discard change the draft only.
const resetTuning = () => {
  drafts.reset(subject.ref, R.parseSkin(subject.skin), selection.settings)
  afterDraftChange()
}

const discardDraft = () => {
  drafts.discard(subject.ref)
  afterDraftChange()
}

const afterDraftChange = () => {
  renderPreview()
  renderTune()
  renderHead()
  renderRows()
}

const openNewForm = () => {
  const base = subject.entry.slug

  $('new-form').hidden = false
  $('new-name').value = `${subject.skin.name} (mine)`.slice(0, 40)
  $('new-slug').value = `${base}-mine`.slice(0, 40)
  $('new-error').hidden = true
  $('new-name').focus()
}

const saveNew = async event => {
  event.preventDefault()
  const ref = subject.ref
  const vars = settingsFor().vars
  const r = await api.saveTuned(ref, { name: $('new-name').value, slug: $('new-slug').value.trim(), vars }).catch(error => ({ ok: false, errors: [cleanError(error)] }))

  if (!r.ok) {
    $('new-error').hidden = false
    $('new-error').textContent = r.errors.join(' ')

    return
  }
  $('new-form').hidden = true
  library = await api.library()
  await Promise.all(library.map(thumbFor))
  renderLibraryList()
  await showLibrary(r.ref)
  showConfirm(fill(S.savedAs, { ref: r.ref }))
}

// ---------- apply / save / report ----------

const apply = async () => {
  const s = subject

  if (view !== 'skin' || !s) {
    return
  }
  if (s.kind === 'gallery') {
    s.saving = true
    renderHead()
    try {
      const r = await api.gallerySave(s.detail.author, s.detail.skin.slug)

      if (!r.ok) {
        throw new Error(r.errors.join(' '))
      }
      s.detail.savedVersion = s.detail.version
      library = await api.library()
      await Promise.all(library.map(thumbFor))
      renderLibraryList()
      showConfirm(fill(S.savedOk, { ref: r.ref }))
      markGallerySaved()
    } catch (error) {
      showConfirm(fill(S.saveFailed, { error: cleanError(error) }))
    } finally {
      s.saving = false
      if (subject === s) {
        renderHead()
      }
    }

    return
  }
  if (drafts.button(s.ref, selection.theme) === 'applied' || (s.entry && !s.entry.ok) || s.applying) {
    return
  }
  s.applying = true
  try {
    // Theme and this skin's draft go to main together; main checks and writes them.
    const r = await api.select(s.ref, s.kind === 'default' ? null : drafts.current(s.ref, selection.settings))

    selection.theme = s.ref
    if (r.sparse && Object.keys(r.sparse).length > 0) {
      selection.settings[s.ref] = r.sparse
    } else if (s.kind !== 'default') {
      delete selection.settings[s.ref]
    }
    drafts.discard(s.ref)
    showConfirm(S.appliedNote)
  } catch (error) {
    showConfirm(fill(S.saveFailed, { error: cleanError(error) }))
  } finally {
    s.applying = false
    if (subject === s) {
      renderHead()
      renderTune()
    }
    renderRows()
  }
}

let askAction = null

const ask = (text, yes, action, title = null) => {
  if (title) {
    $('ask-text').replaceChildren(el('strong', 'ask-title', title), ` ${text}`)
  } else {
    $('ask-text').textContent = text
  }
  $('ask-yes').textContent = yes
  $('ask-no').textContent = S.cancel
  $('ask').hidden = false
  askAction = action
}

const hideAsk = () => {
  $('ask').hidden = true
  askAction = null
}

// ---------- delete from the library ----------

// Gallery downloads and skins made or uploaded here; never official / Claude default.
const deletable = entry => Boolean(entry) && entry.owner !== 'official' && entry.meta?.source !== 'bundled'

const skinLabel = entry => (entry?.ok ? entry.skin.name : entry?.ref ?? '')

const confirmDelete = ref => {
  const entry = entryByRef(ref)

  if (!deletable(entry)) {
    return
  }
  const body = entry.meta?.source === 'local' ? S.deleteBodyLocal : S.deleteBody

  ask(body, S.deleteSkin, () => deleteSkin(ref), fill(S.deleteTitle, { name: skinLabel(entry) }))
  $('ask-no').focus()
}

const deleteSkin = async ref => {
  const entry = entryByRef(ref)
  const name = skinLabel(entry)
  let r

  try {
    r = await api.deleteSkin(ref)
  } catch (error) {
    showConfirm(fill(S.deleteFailed, { error: cleanError(error) }))

    return
  }
  drafts.discard(ref)
  delete selection.settings[ref]
  if (r.switchedToDefault) {
    selection.theme = 'default'
  }
  library = await api.library()
  thumbs.delete(ref)
  await Promise.all(library.map(thumbFor))
  renderLibraryList()
  renderUploadLibrary()
  if (view === 'skin' && subject?.ref === ref) {
    await showLibrary('default')
  }
  showConfirm([fill(S.deletedSkin, { name }), r.switchedToDefault ? S.deletedDefault : null].filter(Boolean).join(' · '))
}

// Right-click menu on library rows: one item, Delete…
let rowMenu = null

const closeRowMenu = (refocus = false) => {
  if (rowMenu === null) {
    return
  }
  const { root, row, outside } = rowMenu

  rowMenu = null
  document.removeEventListener('pointerdown', outside, true)
  root.remove()
  if (refocus) {
    row.focus()
  }
}

const openRowMenu = (row, x, y) => {
  closeRowMenu()
  const ref = row.dataset.ref
  const entry = entryByRef(ref)
  const root = el('div', 'popover menu')
  const item = button('menu-item danger-item', S.deleteMenu, () => {
    closeRowMenu()
    showLibrary(ref).then(() => confirmDelete(ref))
  })

  root.setAttribute('role', 'menu')
  root.setAttribute('aria-label', fill(S.rowMenu, { name: skinLabel(entry) }))
  item.setAttribute('role', 'menuitem')
  root.append(item)
  root.addEventListener('keydown', e => {
    if (e.key === 'Escape' || e.key === 'Tab') {
      e.preventDefault()
      closeRowMenu(true)
    }
  })
  const outside = e => {
    if (!root.contains(e.target)) {
      closeRowMenu()
    }
  }

  document.addEventListener('pointerdown', outside, true)
  document.body.append(root)
  const w = root.offsetWidth
  const h = root.offsetHeight

  root.style.left = `${Math.max(8, Math.min(x, window.innerWidth - w - 8))}px`
  root.style.top = `${Math.max(8, Math.min(y, window.innerHeight - h - 8))}px`
  rowMenu = { root, row, outside }
  item.focus()
}

const onRowContextMenu = event => {
  const row = event.target.closest('#lib-list .row')

  if (!row || !deletable(entryByRef(row.dataset.ref))) {
    return
  }
  event.preventDefault()
  // Keyboard (context-menu key / Shift+F10) has no pointer position: use the row.
  const r = row.getBoundingClientRect()
  const fromKeyboard = event.clientX === 0 && event.clientY === 0

  openRowMenu(row, fromKeyboard ? r.left + 24 : event.clientX, fromKeyboard ? r.bottom : event.clientY)
}

const report = () => {
  const s = subject

  ask(S.reportAsk, S.reportYes, async () => {
    try {
      await api.galleryReport(s.detail.author, s.detail.skin.slug)
      s.reported = true
      showConfirm(S.reported)
    } catch (error) {
      showConfirm(cleanError(error))
    }
    if (subject === s) {
      renderHead()
    }
  })
}

// ---------- gallery ----------

const G = { items: [], cursor: null, sort: 'new', q: '', tag: '', loading: false, error: null, loaded: false, tags: new Set() }
let gallerySeq = 0

const savedState = item => {
  const e = entryByRef(item.ref)

  if (!e || !e.ok) {
    return null
  }

  return (e.meta.version ?? 1) >= item.version ? 'saved' : 'update'
}

const miniPreview = item => {
  const p = item.preview[mode] ?? item.preview.dark ?? item.preview.light
  const box = el('div', 'mini')

  if (!p) {
    return box
  }
  setVars(box, { '--m-s0': p.surface0, '--m-s1': p.surface1, '--m-text': p.text, '--m-muted': p.muted, '--m-accent': p.accent })
  const side = el('div', 'mini-side')
  const main = el('div', 'mini-main')

  side.append(el('i', 'mb w70'), el('i', 'mb w50'), el('i', 'mb w60'))
  main.append(el('i', 'mt w90'), el('i', 'mt w70'), el('i', 'macc'), el('i', 'mbub'))
  box.append(side, main)
  // The list only says a scene exists, not what it does: "Scene" until the detail loads it.
  if (item.hasScene) {
    box.append(el('span', 'mini-tag', S.backdropScene))
  }

  return box
}

// "Remix of <name> by <author>" for a declared remix, else null. Text only.
const remixText = basedOn => {
  if (!basedOn?.ref) {
    return null
  }
  const [author, slug] = basedOn.ref.split('.')

  return fill(S.remixOf, { name: basedOn.name || slug, author })
}
const remixOfItem = item => (item?.basedOn ? remixText({ ref: item.basedOn, name: item.basedOnName }) : null)

const buildTile = item => {
  const tile = button('tile')

  tile.dataset.ref = item.ref
  const meta = el('div', 'tile-meta')
  const name = el('div', 'tile-name')

  name.append(el('span', 'tile-title', item.name))
  const state = savedState(item)

  if (state) {
    name.append(el('span', `badge ${state === 'update' ? 'badge-accent' : ''}`, state === 'update' ? fill(S.updateTo, { v: item.version }) : S.savedBadge))
  }
  meta.append(name, el('div', 'tile-sub', `${item.author} · ${downloadsText(item.downloads)}`))
  const remix = remixOfItem(item)

  if (remix) {
    meta.append(el('div', 'tile-sub', remix))
  }
  tile.append(miniPreview(item), meta)
  tile.title = item.description
  tile.addEventListener('click', () => openDetail(item))

  return tile
}

const renderGrid = () => {
  $('grid').replaceChildren(...G.items.map(buildTile))
  const st = $('grid-state')

  st.hidden = !(G.loading || G.error || (G.loaded && G.items.length === 0))
  st.textContent = G.loading ? S.loading : G.error ? fill(S.galleryError, { error: G.error }) : S.galleryEmpty
  st.classList.toggle('error-text', Boolean(G.error))
  $('grid-retry').hidden = !G.error
  $('load-more').hidden = G.loading || G.error !== null || G.cursor === null
  for (const b of document.querySelectorAll('#view-gallery .segmented button')) {
    b.setAttribute('aria-checked', b.dataset.sort === G.sort ? 'true' : 'false')
  }
  const select = $('tag')

  select.setOptions([{ value: '', label: S.allTags }, ...[...G.tags].sort().map(t => ({ value: t, label: t }))])
  select.value = G.tag
}

const markGallerySaved = () => {
  if (G.loaded) {
    renderGrid()
  }
}

const loadGallery = async (more = false) => {
  const seq = ++gallerySeq

  if (!more) {
    G.items = []
    G.cursor = null
  }
  G.loading = true
  G.error = null
  renderGrid()
  try {
    const r = await api.galleryList({ sort: G.sort, q: G.q, tag: G.tag, cursor: more ? G.cursor : '' })

    if (seq !== gallerySeq) {
      return
    }
    G.items = more ? [...G.items, ...r.items] : r.items
    G.cursor = r.nextCursor
    for (const item of r.items) {
      item.tags.forEach(t => G.tags.add(t))
    }
  } catch (error) {
    if (seq === gallerySeq) {
      G.error = cleanError(error)
    }
  } finally {
    if (seq === gallerySeq) {
      G.loading = false
      G.loaded = true
      renderGrid()
    }
  }
}

const showGallery = async () => {
  setView('gallery')
  if (!G.loaded && !G.loading) {
    await loadGallery()
  } else {
    renderGrid()
  }
}

const openDetail = async item => {
  const s = { kind: 'gallery', ref: item.ref, item, entry: null, skin: null, scene: null, detail: null }

  try {
    const detail = await api.galleryDetail(item.author, item.slug)

    s.detail = detail
    s.skin = detail.skin
    s.scene = detail.scene
  } catch (error) {
    G.error = cleanError(error)
    renderGrid()

    return
  }
  subject = s
  tab = 'overview'
  hideAsk()
  setView('skin')
  renderSkin()
}

// ---------- upload ----------

const U = { auth: { configured: false, signedIn: false, handle: null }, flow: null, name: { value: '', error: null, busy: false }, check: null, mine: null, mineError: null, sending: false, result: null }
// Same pattern the gallery enforces for public names.
const HANDLE = /^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])$/

const googleButton = () => {
  const b = button('ghost flat google-btn', '', startSignIn)
  const mark = el('span', 'g-mark', 'G')

  mark.setAttribute('aria-hidden', 'true')
  b.append(mark, el('span', null, S.signIn))

  return b
}

// Gallery errors that are about the account, in plain words; anything else passes through.
const serverError = message => /sign-in not configured/.test(message) ? S.serverNoSignIn : /banned/.test(message) ? S.banned : /signing keys/.test(message) ? S.googleKeysDown : /invalid token|wrong (issuer|audience)|token expired|issued in the future|unknown signing key|Authorization: Bearer/.test(message) ? S.tokenRejected : message
const nameError = message => /handle taken/.test(message) ? S.nameTaken : /handle reserved/.test(message) ? S.nameReserved : /handle locked/.test(message) ? S.nameLocked : /handle changes per 24 hours/.test(message) ? S.nameRate : /3 to 32|not a valid handle/i.test(message) ? S.nameBad : serverError(message)

const chooseNameRow = () => {
  const wrap = el('div', 'stack choose-name')
  const label = el('label', 'field-label', S.chooseName)
  const input = el('input', 'mono')
  const go = button('primary small', U.name.busy ? S.claiming : S.claimName, () => claimName())
  const err = el('span', 'error-text small-text')

  input.id = 'up-handle'
  label.htmlFor = 'up-handle'
  input.type = 'text'
  input.maxLength = 32
  input.autocomplete = 'off'
  input.spellcheck = false
  input.placeholder = 'your-name'
  input.value = U.name.value
  err.setAttribute('aria-live', 'polite')
  const sync = () => {
    const v = U.name.value
    const bad = v !== '' && !HANDLE.test(v)

    err.textContent = U.name.error ?? (bad ? S.nameBad : '')
    err.hidden = err.textContent === ''
    input.setAttribute('aria-invalid', String(bad || U.name.error !== null))
    go.disabled = U.name.busy || !HANDLE.test(v)
  }

  input.addEventListener('input', () => {
    U.name.value = input.value.trim().toLowerCase()
    U.name.error = null
    sync()
  })
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !go.disabled) {
      claimName()
    }
  })
  const row = el('div', 'inline')

  row.append(input, go)
  wrap.append(label, row, err, el('span', 'muted-text small-text', S.chooseNameHelp))
  sync()

  return wrap
}

const renderAccount = () => {
  const dd = $('up-account')
  const hadFocus = document.activeElement?.id === 'up-handle'

  dd.replaceChildren()
  if (!U.auth.configured) {
    dd.append(el('span', 'notice', S.notConfigured))

    return
  }
  if (U.flow?.waiting) {
    const row = el('div', 'inline')

    row.append(el('span', 'muted-text', S.waiting), button('tiny-link', S.cancel, cancelSignIn))
    dd.append(row)

    return
  }
  if (U.auth.signedIn) {
    const row = el('div', 'inline')

    row.append(el('span', null, U.auth.handle ? fill(S.signedInAs, { handle: U.auth.handle }) : S.signedInNoName), button('ghost flat', S.signOut, signOut))
    dd.append(row)
    if (U.auth.error) {
      dd.append(el('span', 'error-text', serverError(U.auth.error)))
    }
    // Only ask for a name when the gallery actually said there is none.
    if (!U.auth.handle && !U.auth.error) {
      dd.append(chooseNameRow())
      if (hadFocus) {
        $('up-handle').focus()
      }
    }
    if (U.auth.persisted === false) {
      dd.append(el('span', 'muted-text small-text', S.sessionOnly))
    }

    return
  }
  const err = U.flow?.error ?? (U.auth.error ? serverError(U.auth.error) : null)

  if (err) {
    dd.append(el('span', 'error-text', err))
  }
  dd.append(googleButton(), el('span', 'muted-text small-text privacy-note', S.privacyNote))
}

const renderChecks = () => {
  const list = $('up-checks')

  list.replaceChildren()
  $('up-source').textContent = U.check ? `${U.check.label}${U.check.name ? ` · ${U.check.name}` : ''}` : S.noSource
  if (U.check) {
    if (U.check.ok) {
      list.append(el('li', 'ok', S.checksOk))
    } else {
      U.check.errors.forEach(e => list.append(el('li', null, e)))
    }
  }
  const send = $('up-send')

  send.textContent = U.sending ? S.uploading : S.upload
  send.disabled = U.sending || !U.auth.configured || !U.auth.signedIn || !U.auth.handle || !U.check?.ok
  $('up-result').textContent = U.result ?? (U.auth.configured && U.check?.ok ? (!U.auth.signedIn ? S.signInFirst : !U.auth.handle ? S.nameFirst : '') : '')
}

const renderMine = () => {
  const show = U.auth.configured && U.auth.signedIn && Boolean(U.auth.handle)

  $('up-mine-key').hidden = !show
  $('up-mine').hidden = !show
  const dd = $('up-mine')

  dd.replaceChildren()
  if (!show) {
    return
  }
  if (U.mineError) {
    dd.append(el('span', 'error-text', fill(S.mineError, { error: U.mineError })))

    return
  }
  if (U.mine === null) {
    dd.append(el('span', 'muted-text', S.loading))

    return
  }
  if (U.mine.length === 0) {
    dd.append(el('span', 'muted-text', S.mineEmpty))

    return
  }
  const table = el('div', 'mine')

  for (const item of U.mine) {
    const row = el('div', 'mine-row')
    const name = el('div', 'mine-name')

    name.append(el('span', null, item.name), el('span', 'mono muted-text', item.ref))
    const meta = el('span', 'muted-text', `v${item.version} · ${downloadsText(item.downloads)}`)
    const flag = el('span', 'badge badge-warn', fill(S.hiddenN, { n: item.reports }))

    flag.hidden = !item.hidden
    const del = button('tiny-link danger-link', S.del)

    del.addEventListener('click', () => {
      row.replaceChildren(el('span', 'ask-inline', fill(S.delAsk, { ref: item.ref })), button('ghost danger', S.delYes, () => deleteMine(item)), button('tiny-link', S.cancel, renderMine))
    })
    row.append(name, meta, flag, del)
    table.append(row)
  }
  dd.append(table)
}

const renderUpload = () => {
  renderAccount()
  renderChecks()
  renderMine()
  renderUploadLibrary()
}

// Only skins the person made (service.js isUploadable): gallery downloads and
// built-in skins never appear.
const uploadable = e => e.ok && (e.meta?.source === 'local' || e.meta?.source === 'upload')

// The "From library…" dropdown on Upload.
const renderUploadLibrary = () => {
  const select = $('up-library')
  const keep = select.value
  const mine = library.filter(uploadable)

  select.setOptions([{ value: '', label: S.fromLibrary }, ...mine.map(e => ({ value: e.ref, label: `${e.skin.name} (${e.ref})` }))])
  select.value = mine.some(e => e.ref === keep) ? keep : ''
}

const loadMine = async () => {
  if (!U.auth.signedIn || !U.auth.handle) {
    return
  }
  U.mine = null
  U.mineError = null
  renderMine()
  try {
    U.mine = (await api.mySkins()).skins
  } catch (error) {
    U.mineError = serverError(cleanError(error))
  }
  renderMine()
}

const showUpload = async () => {
  setView('upload')
  renderUpload()
  try {
    U.auth = await api.authState()
  } catch {
    // keep the last state
  }
  renderUpload()
  // With the public name known, main folds skins left next to their upload (once).
  refreshLibrary(true)
  await loadMine()
}

const authError = error => error === 'access_denied' ? S.authDenied : error === 'timeout' ? S.authExpired : error === 'browser' ? S.authBrowser : fill(S.authFailed, { error })

const startSignIn = async () => {
  const flow = { waiting: true }

  try {
    U.flow = flow
    renderAccount()
    const started = await api.authStart()

    if (started.error) {
      U.flow = started.error === 'not-configured' ? null : { error: authError(started.error) }
      renderUpload()

      return
    }
    const r = await api.authWait()

    if (U.flow !== flow) {
      return
    }
    U.flow = null
    if (r.error) {
      if (r.error !== 'cancelled') {
        U.flow = { error: authError(r.error) }
      }
    } else {
      U.auth = r
      U.name = { value: '', error: null, busy: false }
    }
    renderUpload()
    await loadMine()
  } catch (error) {
    if (U.flow === flow) {
      U.flow = { error: fill(S.authFailed, { error: cleanError(error) }) }
      renderAccount()
    }
  }
}

const cancelSignIn = async () => {
  U.flow = null
  await api.authCancel().catch(() => {})
  renderAccount()
}

const claimName = async () => {
  if (U.name.busy || !HANDLE.test(U.name.value)) {
    return
  }
  U.name.busy = true
  U.name.error = null
  renderAccount()
  try {
    U.auth = { ...U.auth, ...(await api.claimHandle(U.name.value)) }
    U.name = { value: '', error: null, busy: false }
    renderUpload()
    await loadMine()
  } catch (error) {
    U.name.busy = false
    U.name.error = nameError(cleanError(error))
    renderUpload()
  }
}

const signOut = async () => {
  U.flow = null
  U.auth = await api.signOut().catch(() => ({ ...U.auth, signedIn: false, handle: null }))
  U.mine = null
  U.name = { value: '', error: null, busy: false }
  renderUpload()
  renderSettingsAccount()
}

// ---------- settings ----------

// Only reflects the sign-in state; the sign-in and public-name flow stay on Upload.
const renderSettingsAccount = () => {
  const b = $('set-account-btn')

  if (U.auth.signedIn) {
    $('set-account').textContent = U.auth.handle ? fill(S.signedInAs, { handle: U.auth.handle }) : S.signedInNoName
    b.textContent = S.signOut
  } else {
    $('set-account').textContent = S.notSignedIn
    b.textContent = S.goToUpload
  }
}

const renderLanguage = () => {
  const select = $('set-language')

  select.setOptions([
    { value: 'system', label: S.langSystem },
    { value: 'en', label: S.langEnglish },
    { value: 'zh', label: S.langChinese },
  ])
  select.value = language
}

const setLanguage = async () => {
  const choice = $('set-language').value

  try {
    applyLanguage(await api.setLanguage(choice))
  } catch {
    $('set-language').value = language
  }
}

const renderAutoUpdate = () => {
  $('auto-update').setAttribute('aria-checked', autoUpdate ? 'true' : 'false')
}

const toggleAutoUpdate = async () => {
  autoUpdate = !autoUpdate
  renderAutoUpdate()
  try {
    autoUpdate = (await api.setAutoUpdate(autoUpdate)).autoUpdate
  } catch {
    autoUpdate = !autoUpdate
  }
  renderAutoUpdate()
}

const updateErrorText = e => {
  if (!e || e.during !== 'update') {
    return ''
  }

  return e.code === 'move' ? S.updateMoveApp : e.code === 'verify' ? S.updateVerifyFailed : fill(S.updateFailed, { error: e.message })
}

// Version row (Check for updates) and, when there is one, the new-version row.
const renderUpdate = () => {
  const u = update
  const checking = u.status === 'checking'
  const working = u.status === 'downloading' || u.status === 'installing'
  const check = $('update-check')
  const checkError = u.error?.during === 'check'

  check.disabled = checking || working
  check.classList.toggle('busy', checking)
  $('update-check-label').textContent = checking ? S.checkingUpdates : S.checkUpdates
  $('update-check-note').textContent = checkError ? fill(S.checkFailed, { error: u.error.message }) : u.status === 'up-to-date' && checkedByClick ? S.upToDate : ''
  $('update-check-note').classList.toggle('error-text', checkError)
  const show = Boolean(u.latest) && (u.status === 'available' || working)

  $('set-update-key').hidden = !show
  $('set-update').hidden = !show
  if (!show) {
    return
  }
  const pct = Math.round((u.progress ?? 0) * 100)

  $('update-text').textContent =
    u.status === 'downloading' ? fill(S.updateDownloading, { v: u.latest, pct }) : u.status === 'installing' ? fill(S.updateInstalling, { v: u.latest }) : fill(S.updateAvailable, { v: u.latest })
  $('update-go').hidden = working
  $('update-notes').hidden = working
  $('update-cancel').hidden = u.status !== 'downloading'
  $('update-bar').hidden = u.status !== 'downloading'
  $('update-bar-fill').style.width = `${pct}%`
  const error = updateErrorText(u.error)

  $('update-error').hidden = error === ''
  $('update-error').textContent = error
  const hint = platform === 'darwin' ? S.updateKeychainHint : platform === 'win32' ? S.updateWinHint : ''

  $('update-hint').hidden = hint === '' || working
  $('update-hint').textContent = hint
}

// ---------- sidebar update icon and its popover ----------

let badgeDismissed = null // version passed over with "Not now" (this session only)
let updatePop = null // { root, parts, outside, place }

const renderBadge = () => {
  const show = window.UpdateBadge.showBadge(update, badgeDismissed)
  const b = $('update-badge')

  b.hidden = !show
  if (show) {
    const label = fill(S.updateAvailable, { v: update.latest })

    b.title = label
    b.setAttribute('aria-label', label)
  } else {
    closeUpdatePop()
  }
}

const renderUpdatePop = () => {
  if (updatePop === null) {
    return
  }
  const { root, parts } = updatePop
  const v = window.UpdateBadge.popoverView(update)
  const working = v.phase !== 'available'
  const error = updateErrorText(v.error)
  const hint = platform === 'darwin' ? S.updateKeychainHint : platform === 'win32' ? S.updateWinHint : ''
  const hadFocus = root.contains(document.activeElement)

  parts.title.textContent = fill(S.updateAvailable, { v: update.latest })
  parts.versions.textContent = `v${update.current ?? appVersion} → v${update.latest}`
  parts.status.hidden = !working
  parts.status.textContent = v.phase === 'downloading' ? fill(S.updateDownloading, { v: update.latest, pct: v.progress }) : v.phase === 'installing' ? fill(S.updateInstalling, { v: update.latest }) : ''
  parts.bar.hidden = v.phase !== 'downloading'
  parts.fill.style.width = `${v.progress ?? 0}%`
  parts.error.hidden = error === ''
  parts.error.textContent = error
  parts.hint.hidden = hint === '' || working
  parts.hint.textContent = hint
  parts.go.textContent = S.updateNow
  parts.go.hidden = working
  parts.go.disabled = !v.canUpdate
  parts.later.textContent = S.notNow
  parts.later.hidden = working
  parts.cancel.textContent = S.cancel
  parts.cancel.hidden = v.phase !== 'downloading'
  parts.notes.textContent = S.releaseNotes
  parts.notes.hidden = working
  // A button that just went away (Update -> downloading) leaves focus in the popover.
  if (hadFocus && !root.contains(document.activeElement)) {
    root.focus({ preventScroll: true })
  }
  updatePop.place()
}

const closeUpdatePop = (refocus = false) => {
  const p = updatePop

  if (p === null) {
    return
  }
  updatePop = null
  document.removeEventListener('pointerdown', p.outside, true)
  window.removeEventListener('resize', p.place)
  p.root.remove()
  $('update-badge').setAttribute('aria-expanded', 'false')
  if (refocus && !$('update-badge').hidden) {
    $('update-badge').focus()
  }
}

const openUpdatePop = () => {
  closeUpdatePop()
  window.Dropdown.close(false)
  window.ColorPicker.close()
  closeRowMenu()
  const badge = $('update-badge')
  const root = el('div', 'popover update-pop')
  const parts = {
    title: el('h2', null),
    versions: el('span', 'muted-text'),
    status: el('span', null),
    bar: el('div', 'progress'),
    fill: el('span', null),
    error: el('span', 'error-text'),
    hint: el('span', 'muted-text small-text'),
    go: button('primary small', '', () => startUpdate()),
    later: button('ghost flat', '', () => {
      badgeDismissed = update.latest
      closeUpdatePop()
      renderBadge()
      $('nav-settings').focus()
    }),
    cancel: button('tiny-link', '', () => api.cancelUpdate().then(setUpdate, () => {})),
    notes: button('tiny-link', '', () => api.openReleaseNotes()),
  }

  root.id = 'update-pop'
  root.tabIndex = -1
  root.setAttribute('role', 'dialog')
  root.setAttribute('aria-labelledby', 'update-pop-title')
  parts.title.id = 'update-pop-title'
  parts.status.setAttribute('role', 'status')
  parts.error.setAttribute('role', 'alert')
  parts.bar.append(parts.fill)
  const actions = el('div', 'update-pop-actions')

  actions.append(parts.go, parts.later, parts.cancel, parts.notes)
  root.append(parts.title, parts.versions, parts.status, parts.bar, parts.error, parts.hint, actions)
  root.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      closeUpdatePop(true)
    }
  })
  // Non-modal: tabbing out of it, or clicking anywhere else, just closes it.
  root.addEventListener('focusout', e => {
    if (e.relatedTarget instanceof Node && !root.contains(e.relatedTarget) && e.relatedTarget !== badge) {
      closeUpdatePop()
    }
  })
  const outside = e => {
    if (!root.contains(e.target) && !badge.contains(e.target)) {
      closeUpdatePop()
    }
  }
  // Under the icon, left edges aligned; kept inside the window.
  const place = () => {
    const a = badge.getBoundingClientRect()
    const left = Math.max(8, Math.min(a.left, window.innerWidth - root.offsetWidth - 8))
    const top = Math.max(8, Math.min(a.bottom + 6, window.innerHeight - root.offsetHeight - 8))

    root.style.left = `${Math.round(left)}px`
    root.style.top = `${Math.round(top)}px`
  }

  updatePop = { root, parts, outside, place }
  document.body.append(root)
  document.addEventListener('pointerdown', outside, true)
  window.addEventListener('resize', place)
  badge.setAttribute('aria-expanded', 'true')
  badge.setAttribute('aria-controls', 'update-pop')
  renderUpdatePop()
  ;(parts.go.hidden || parts.go.disabled ? root : parts.go).focus({ preventScroll: true })
}

const setUpdate = next => {
  update = next ?? update
  renderUpdate()
  renderStatus()
  renderBadge()
  renderUpdatePop()
}

const checkUpdate = async () => {
  checkedByClick = true
  setUpdate({ ...update, status: 'checking', error: null })
  setUpdate(await api.checkUpdate().catch(error => ({ ...update, status: 'idle', error: { during: 'check', code: 'ipc', message: cleanError(error) } })))
}

const startUpdate = async () => {
  setUpdate(await api.startUpdate().catch(error => ({ ...update, error: { during: 'update', code: 'ipc', message: cleanError(error) } })))
}

const showSettings = async () => {
  setView('settings')
  renderStatus()
  renderSettingsAccount()
  renderLanguage()
  renderAutoUpdate()
  renderUpdate()
  // Arrived from the sidebar dot for a new version (and the bridge is fine): bring its row into view.
  if (!$('set-update').hidden && status.state !== 'not-installed' && !status.error) {
    $('set-update').scrollIntoView({ block: 'nearest' })
  }
  $('set-version').textContent = appVersion ? `v${appVersion}` : ''
  try {
    U.auth = await api.authState()
  } catch {
    // keep the last state
  }
  renderSettingsAccount()
  refreshLibrary(true)
}

// "This is <name> by <author> from the gallery…", from the structured answer.
const copyText = c => fill(S.copyOfGallery, { name: c.name, author: c.author })

const setCheck = r => {
  if (r && r.copyOf) {
    r = { ...r, errors: [copyText(r.copyOf)] }
  } else if (r && r.notMine) {
    r = { ...r, errors: [S.notMine] }
  }
  U.check = r
  U.result = null
  renderChecks()
}

const deleteMine = async item => {
  try {
    await api.deleteMine(item.slug)
    U.result = fill(S.deleted, { ref: item.ref })
  } catch (error) {
    U.result = cleanError(error)
  }
  renderChecks()
  await loadMine()
}

// A skin made here was merged into its upload (service.js mergeInto): its
// draft and thumbnail follow it, and the selection comes from main.
const followMoves = (moves, sel) => {
  const list = Array.isArray(moves) ? moves : []

  if (list.length > 0 && sel) {
    selection = { theme: sel.theme, settings: sel.settings ?? {} }
  }
  for (const { from, to } of list) {
    drafts.move(from, to)
    // The thumbnail of `to` was drawn without the tuning that just moved onto it.
    thumbs.delete(from)
    thumbs.delete(to)
    if (U.check?.label === from) {
      U.check = { ...U.check, label: to }
    }
  }

  return list
}

// The open skin was one of them (either side): show it under its new ref.
const followSubject = async moves => {
  const m = moves.find(x => subject?.kind === 'library' && (x.from === subject.ref || x.to === subject.ref))

  if (m === undefined || entryByRef(m.to) === undefined) {
    return false
  }
  if (view === 'skin') {
    await showLibrary(m.to)
  } else {
    subject = { ...subject, ref: m.to, entry: entryByRef(m.to) }
  }

  return true
}

const sendUpload = async () => {
  U.sending = true
  U.result = null
  renderChecks()
  try {
    const r = await api.upload()

    if (r.ok === false) {
      U.result = r.copyOf ? copyText(r.copyOf) : fill(S.uploadFailed, { error: r.error ?? '' })

      return
    }
    U.result = fill(S.uploadedNew, { ref: r.ref, v: r.version })
    const moved = followMoves(r.moved ? [r.moved] : [], r.selection)

    library = await api.library()
    await Promise.all(library.map(thumbFor))
    renderLibraryList()
    renderUploadLibrary()
    if (moved.length > 0 && $('up-library').value === '') {
      $('up-library').value = moved[0].to
    }
    await followSubject(moved)
  } catch (error) {
    U.result = fill(S.uploadFailed, { error: serverError(cleanError(error)) })
  } finally {
    U.sending = false
    renderUpload()
  }
  await loadMine()
}

// ---------- start ----------

const poll = async () => {
  try {
    status = await api.status()
    renderStatus()
  } catch {
    // keep the last known status
  }
}

// Skins copied into ~/.claude-theme-switcher/skins/ while the app is open show
// up when the window comes back to the front (at most once a second). Every
// unapplied draft stays; the selection changes only if its skin is gone or
// broken (the service resets it to Claude default).
const REFRESH_MIN_MS = 1000
let lastLibraryRefresh = 0
let libraryRefreshing = false
let refreshAgain = false

// force === true skips the once-a-second limit (after the public name is known).
const refreshLibrary = async force => {
  const now = Date.now()

  if (libraryRefreshing && force === true) {
    refreshAgain = true
  }
  if (libraryRefreshing || (force !== true && now - lastLibraryRefresh < REFRESH_MIN_MS)) {
    return
  }
  lastLibraryRefresh = now
  libraryRefreshing = true
  try {
    const fresh = await api.refreshLibrary()
    const next = fresh.library
    // The applied skin was gone or broken: Claude is back to its default look.
    const selChanged = Boolean(fresh.reset)
    const moved = followMoves(fresh.moved, fresh.selection)

    if (selChanged) {
      selection = { theme: fresh.selection.theme, settings: fresh.selection.settings ?? {} }
      showConfirm(fill(S.staleReset, { ref: fresh.reset }))
    }
    // Nothing changed on disk: leave the rows (and keyboard focus) alone.
    if (!selChanged && JSON.stringify(next) === JSON.stringify(library)) {
      return
    }
    library = next
    await Promise.all(library.map(thumbFor))
    renderLibraryList()
    renderUploadLibrary()
    if (subject && subject.kind === 'library') {
      // Files may have changed: the Code tab reads them again.
      subject.codeLoad = undefined
      if (view === 'skin' && tab === 'code') {
        renderCode()
      }
    }
    // The skin on screen was merged into its upload: show that. Gone: fall back to Claude default.
    if (await followSubject(moved)) {
      // shown under its new ref
    } else if (view === 'skin' && subject?.kind === 'library' && entryByRef(subject.ref) === undefined) {
      await showLibrary('default')
    } else if (selChanged && view === 'skin' && subject && subject.kind !== 'gallery') {
      renderHead()
    }
  } catch {
    // keep the list we have
  } finally {
    libraryRefreshing = false
    if (refreshAgain) {
      refreshAgain = false
      refreshLibrary(true)
    }
  }
}

const setMode = next => {
  mode = next
  if (view === 'skin' && subject) {
    renderHead()
    renderPreview()
    renderDetails()
  }
  if (view === 'gallery') {
    renderGrid()
  }
}

const texts = () => {
  const t = (id, key) => {
    $(id).textContent = S[key]
  }

  t('app-name', 'appName')
  t('library-label', 'libraryLabel')
  t('browse-label', 'browseLabel')
  t('nav-gallery-label', 'galleryNav')
  t('nav-upload-label', 'uploadNav')
  t('nav-settings-label', 'settingsNav')
  t('tab-code', 'tabCode')
  t('settings-title', 'settingsTitle')
  t('settings-sub', 'settingsSub')
  t('sec-connection', 'secConnection')
  t('sec-account', 'secAccount')
  t('sec-about', 'secAbout')
  t('set-status-key', 'keyStatus')
  t('set-plugin-key', 'keyPlugin')
  t('set-install-key', 'keyInstall')
  t('set-connection-help', 'connectionHelp')
  t('set-google-key', 'keyGoogle')
  t('set-app-key', 'keyApp')
  t('set-app-name', 'appName')
  t('set-version-key', 'keyAppVersion')
  t('set-source-key', 'keySourceCode')
  t('sec-general', 'secGeneral')
  t('set-language-key', 'keyLanguage')
  t('set-update-key', 'keyNewVersion')
  t('set-auto-key', 'keyUpdates')
  t('auto-update-label', 'autoUpdate')
  t('update-go', 'updateNow')
  t('update-cancel', 'cancel')
  t('update-notes', 'releaseNotes')
  t('mode-dark', 'dark')
  t('mode-light', 'light')
  t('tab-overview', 'tabOverview')
  t('tab-tune', 'tabTune')
  t('mock-text', 'mockText')
  t('mock-user', 'mockUser')
  t('mock-input', 'mockInput')
  t('reset', 'resetDefaults')
  t('discard', 'discard')
  t('save-new', 'saveAsNew')
  t('new-name-label', 'newName')
  t('new-slug-label', 'newSlug')
  t('new-save', 'saveNew')
  t('new-cancel', 'cancel')
  t('gallery-title', 'galleryTitle')
  t('gallery-sub', 'gallerySub')
  t('sort-new', 'sortNew')
  t('sort-popular', 'sortPopular')
  t('load-more', 'loadMore')
  t('grid-retry', 'retry')
  t('upload-title', 'uploadTitle')
  t('upload-sub', 'uploadSub')
  t('up-account-key', 'keyAccount')
  t('up-source-key', 'keySourceUp')
  t('up-checks-key', 'keyChecks')
  t('up-mine-key', 'keyMine')
  t('up-folder', 'importFolder')
  t('up-rules', 'uploadRules')
  t('repo', 'github')
  t('footer-text', 'footer')
  $('search').placeholder = S.searchPlaceholder
}

const DROPDOWN_LABELS = [
  ['tag', 'tagFilter'],
  ['up-library', 'librarySource'],
  ['set-language', 'keyLanguage'],
]

const labelDropdowns = () => {
  for (const [id, key] of DROPDOWN_LABELS) {
    $(id).setAttribute('aria-label', S[key])
  }
}

// Another language from Settings: new strings, everything drawn again in
// place. View, selection, unapplied drafts and form contents stay.
const applyLanguage = r => {
  S = r.strings
  language = r.language
  document.documentElement.lang = r.lang === 'zh' ? 'zh-CN' : 'en'
  window.Dropdown.close(false)
  window.ColorPicker.close()
  closeRowMenu()
  hideAsk()
  texts()
  renderBadge()
  renderUpdatePop()
  labelDropdowns()
  renderLibraryList()
  renderStatus()
  if (subject) {
    renderSkin()
  }
  if (G.loaded || G.loading) {
    renderGrid()
  }
  renderUpload()
  renderSettingsAccount()
  renderLanguage()
  renderAutoUpdate()
  renderUpdate()
}

const wire = () => {
  // Custom dropdowns in place of <select>; same ids, .value and 'change'.
  labelDropdowns()
  for (const [id] of DROPDOWN_LABELS) {
    window.Dropdown.upgrade($(id))
  }
  $('set-language').addEventListener('change', setLanguage)
  $('auto-update').setAttribute('aria-labelledby', 'auto-update-label')
  $('auto-update').addEventListener('click', toggleAutoUpdate)
  $('update-check').addEventListener('click', checkUpdate)
  $('update-go').addEventListener('click', startUpdate)
  $('update-cancel').addEventListener('click', () => api.cancelUpdate().then(setUpdate, () => {}))
  $('update-notes').addEventListener('click', () => api.openReleaseNotes())
  $('update-badge').addEventListener('click', () => (updatePop === null ? openUpdatePop() : closeUpdatePop()))
  $('update-badge').addEventListener('keydown', e => {
    if (e.key === 'Escape' && updatePop !== null) {
      e.preventDefault()
      closeUpdatePop(true)
    }
  })
  api.onUpdate(setUpdate)
  $('lib-list').addEventListener('keydown', onListKey)
  $('nav-gallery').addEventListener('click', showGallery)
  $('nav-upload').addEventListener('click', showUpload)
  $('nav-settings').addEventListener('click', showSettings)
  $('set-account-btn').addEventListener('click', () => (U.auth.signedIn ? signOut() : showUpload()))
  $('code-skin-copy').addEventListener('click', () => copyCode('skin'))
  $('code-scene-copy').addEventListener('click', () => copyCode('scene'))
  $('back').addEventListener('click', showGallery)
  for (const b of document.querySelectorAll('#view-skin .segmented button')) {
    b.addEventListener('click', () => {
      modeChosen = true
      setMode(b.dataset.mode)
    })
  }
  for (const b of document.querySelectorAll('#tabs [role="tab"]')) {
    b.addEventListener('click', () => {
      tab = b.dataset.tab
      renderTabs()
    })
  }
  systemDark.addEventListener('change', e => {
    if (!modeChosen) {
      setMode(e.matches ? 'dark' : 'light')
    }
  })
  $('apply').addEventListener('click', apply)
  $('report').addEventListener('click', report)
  $('delete').addEventListener('click', () => confirmDelete(subject?.ref))
  $('lib-list').addEventListener('contextmenu', onRowContextMenu)
  $('ask-yes').addEventListener('click', () => {
    const action = askAction

    hideAsk()
    action?.()
  })
  $('ask-no').addEventListener('click', hideAsk)
  $('reset').addEventListener('click', resetTuning)
  $('discard').addEventListener('click', discardDraft)
  $('save-new').addEventListener('click', openNewForm)
  $('new-form').addEventListener('submit', saveNew)
  $('new-cancel').addEventListener('click', () => {
    $('new-form').hidden = true
  })
  let searchTimer = null

  $('search').addEventListener('input', () => {
    clearTimeout(searchTimer)
    searchTimer = setTimeout(() => {
      G.q = $('search').value
      loadGallery()
    }, 300)
  })
  for (const b of document.querySelectorAll('#view-gallery .segmented button')) {
    b.addEventListener('click', () => {
      G.sort = b.dataset.sort
      loadGallery()
    })
  }
  $('tag').addEventListener('change', () => {
    G.tag = $('tag').value
    loadGallery()
  })
  $('load-more').addEventListener('click', () => loadGallery(true))
  $('grid-retry').addEventListener('click', () => loadGallery())
  $('up-folder').addEventListener('click', async () => {
    try {
      const r = await api.pickFolder()

      if (r) {
        $('up-library').value = ''
        setCheck(r)
      }
    } catch (error) {
      setCheck({ ok: false, errors: [cleanError(error)], label: '' })
    }
  })
  $('up-library').addEventListener('change', async () => {
    const ref = $('up-library').value

    if (ref) {
      setCheck(await api.checkLibrary(ref).catch(error => ({ ok: false, errors: [cleanError(error)], label: ref })))
    }
  })
  $('up-send').addEventListener('click', sendUpload)
  $('install').addEventListener('click', install)
  $('repo').addEventListener('click', () => api.openRepo())
  $('manual-copy').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText($('manual-text').textContent)
      $('manual-copy').textContent = S.copied
    } catch {
      window.getSelection().selectAllChildren($('manual-text'))
    }
  })
}

const start = async () => {
  const init = await api.init()

  S = init.strings
  library = init.library
  selection = { theme: init.selection.theme, settings: init.selection.settings ?? {} }
  status = init.status
  isShot = init.shot !== null
  appVersion = await api.version().catch(() => '')
  platform = init.platform
  language = init.language
  autoUpdate = init.autoUpdate
  update = init.update ?? update
  document.documentElement.lang = init.lang === 'zh' ? 'zh-CN' : 'en'
  // Frameless window: the CSS reserves room for the traffic lights / caption buttons.
  document.body.classList.add(`platform-${init.platform}`)
  texts()
  wire()
  await Promise.all(library.map(thumbFor))
  renderLibraryList()
  renderStatus()
  renderBadge()

  const shotView = init.shot?.view ?? 'library'
  const firstRef = init.shot?.select && init.shot.view !== 'detail' ? init.shot.select : (selection.theme ?? library.find(e => e.ok)?.ref ?? 'default')

  const firstEntry = entryByRef(firstRef)

  // Screenshot mode can preset an unapplied draft (TS_DRAFT) for that skin.
  if (init.shot?.draft && firstEntry?.ok) {
    drafts.set(firstRef, init.shot.draft, R.parseSkin(firstEntry.skin), selection.settings)
    renderRows()
  }
  await showLibrary(firstEntry || firstRef === 'default' ? firstRef : 'default')
  if (shotView === 'tune' || shotView === 'code') {
    tab = shotView
    renderTabs()
  } else if (shotView === 'gallery') {
    await showGallery()
  } else if (shotView === 'detail') {
    await showGallery()
    const item = G.items.find(i => i.ref === init.shot.select) ?? G.items[0]

    if (item) {
      await openDetail(item)
    }
  } else if (shotView === 'upload') {
    await showUpload()
  } else if (shotView === 'settings') {
    await showSettings()
  }
  // TS_OPEN_PICKER: the Tune tab with that colour control's picker open.
  if (init.shot?.picker && view === 'skin' && subject?.kind === 'library') {
    const key = init.shot.picker === 'accent' ? 'accent' : `vars.${init.shot.picker}`

    openGroups.add(key === 'accent' ? 'panels' : 'vars')
    tab = 'tune'
    renderTabs()
    renderTune()
    document.querySelector(`.color-btn[data-key="${CSS.escape(key)}"]`)?.click()
  }
  // TS_DELETE=confirm|menu: the delete confirmation, or the row's right-click menu.
  if (init.shot?.del && view === 'skin' && deletable(subject?.entry)) {
    const row = document.querySelector(`#lib-list .row[data-ref="${CSS.escape(subject.ref)}"]`)

    if (init.shot.del === 'menu' && row) {
      const r = row.getBoundingClientRect()

      openRowMenu(row, r.left + 120, r.top + r.height / 2)
    } else {
      confirmDelete(subject.ref)
    }
  }
  if (init.shot?.dropdown) {
    window.Dropdown.open($(init.shot.dropdown))
  }
  // TS_UPDATE=popup…: the sidebar update icon's popover.
  if (init.shot?.updatePop && !$('update-badge').hidden) {
    openUpdatePop()
  }
  // TS_TAB: a tab in whichever skin view is open (library or gallery detail).
  if (init.shot?.tab && view === 'skin' && !$('tabs').hidden) {
    tab = init.shot.tab
    renderTabs()
  }

  // The CLI check can take a few seconds; show the heartbeat-only status first.
  const refreshed = api
    .refresh()
    .then(s => {
      status = s
      renderStatus()
    })
    .catch(() => {})
  setInterval(poll, POLL_MS)
  lastLibraryRefresh = Date.now()
  window.addEventListener('focus', refreshLibrary)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      refreshLibrary()
    }
  })

  if (isShot) {
    // Capture the checked bridge status, not "Checking…".
    await refreshed
    if (tab === 'code') {
      await renderCode()
    }
    await sceneLoaded
    await nextFrame()
    api.ready()
  }
}

start()
