'use strict'

// Everything shown here is text (textContent) or a blob: image built from an
// already validated SVG. No innerHTML, no network: main does all of that.

const api = window.switcher
const R = window.SkinRender
const $ = id => document.getElementById(id)

const POLL_MS = 5000
const CONFIRM_MS = 3000
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
let view = 'skin' // skin | gallery | upload
let subject = null // what the skin view shows
let tab = 'overview'
let mode = systemDark.matches ? 'dark' : 'light'
let modeChosen = false
let status = { state: 'checking' }
let busy = false
let confirmTimer = null
let fillPct = 40
let isShot = false
const thumbs = new Map() // ref -> blob url
const openGroups = new Set(['backdrop', 'vars'])

const fill = (text, vars) => text.replace(/\{(\w+)\}/g, (_, k) => (vars[k] === undefined ? `{${k}}` : String(vars[k])))
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

  badge.hidden = true
  row.append(thumb, text, badge)
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
  $('bridge-sub').textContent = [status.version ? `v${status.version}` : null, status.platform].filter(Boolean).join(' · ')
  $('bridge-error').hidden = !status.error
  $('bridge-error').textContent = status.error ? fill(S.bridgeError, { error: status.error }) : ''
  const b = $('install')

  b.hidden = status.state === 'checking' && !busy
  b.disabled = busy
  b.classList.toggle('busy', busy)
  $('install-label').textContent = busy ? S.installing : status.state === 'not-installed' ? S.install : S.reinstall
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
  if (view === 'skin' && next !== 'skin') {
    api.flushSettings().catch(() => {})
  }
  view = next
  for (const v of ['skin', 'gallery', 'upload']) {
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
  if (subject?.kind === 'library' && subject.ref !== ref) {
    api.flushSettings().catch(() => {})
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
  const raw = subject.kind === 'gallery' ? {} : (selection.settings[subject.ref] ?? {})

  return R.normalizeSettings(raw, R.parseSkin(subject.skin))
}

const renderSkin = () => {
  const s = subject
  const broken = s.entry !== null && s.entry !== undefined && !s.entry.ok
  const gallery = s.kind === 'gallery'

  $('back').hidden = !gallery
  $('back').textContent = `‹ ${S.back}`
  $('skin-name').textContent = s.kind === 'default' ? S.claudeDefault : broken ? s.ref : s.skin.name
  const desc = s.kind === 'default' ? S.claudeDefaultDesc : broken ? S.brokenTitle : gallery ? [fill(S.byAuthor, { author: s.detail.author }), `v${s.detail.version}`, s.item ? fill(S.downloadsN, { n: s.item.downloads }) : null].filter(Boolean).join(' · ') : (s.skin.description ?? '')

  $('skin-desc').textContent = desc
  $('skin-desc').title = desc
  $('tabs').hidden = broken || s.kind === 'default'
  $('skin-body').hidden = broken
  $('broken').hidden = !broken
  $('report').hidden = !gallery
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
  const isActive = s.ref === selection.theme
  const broken = s.entry && !s.entry.ok

  apply.textContent = isActive ? S.applied : S.apply
  apply.disabled = isActive || broken
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

  const reactive = settings ? settings.reactive : true
  const pct = R.toPercent(fillPct)

  $('fill-row').hidden = !hasScene
  $('fill').disabled = !reactive
  $('fill-value').textContent = reactive ? `${pct}%` : fill(S.fillFixed, { pct: `${Math.round(settings.fixedFill * 100)}%` })
  if (!hasScene || settings === null) {
    setScene(null)

    return
  }
  const f = R.fillFor(settings, pct)

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

  add(S.keyBackdrop, typeof s.scene === 'string' ? S.backdropAnimated : s.skin.backdrop?.scene ? S.backdropStill : S.backdropNone)
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

let savedTimer = null

const changeSetting = (path, value) => {
  const s = subject

  if (s.kind !== 'library') {
    return
  }
  const raw = structuredClone(selection.settings[s.ref] ?? {})

  if (path[0] === 'vars') {
    raw.vars = { ...(raw.vars ?? {}), [path[1]]: value }
  } else if (value === null) {
    delete raw[path[0]]
  } else {
    raw[path[0]] = value
  }
  selection.settings[s.ref] = raw
  renderPreview()
  api
    .setSettings(s.ref, raw)
    .then(() => {
      clearTimeout(savedTimer)
      $('tune-saved').textContent = S.tuneSaved
      $('tune-saved').classList.add('show')
      savedTimer = setTimeout(() => $('tune-saved').classList.remove('show'), 1500)
    })
    .catch(error => showConfirm(fill(S.saveFailed, { error: cleanError(error) })))
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

const colorControl = (value, shown, path, label, disabled, nullable) => {
  const wrap = el('div', 'ctl')
  const input = el('input')
  const hex = el('span', 'num mono', shown)

  Object.assign(input, { type: 'color', value: shown, disabled })
  input.setAttribute('aria-label', label)
  input.addEventListener('input', () => {
    hex.textContent = input.value
    changeSetting(path, input.value)
    if (def) {
      def.setAttribute('aria-pressed', 'false')
    }
  })
  let def = null

  wrap.append(input, hex)
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
  $('reset').disabled = Object.keys(selection.settings[s.ref] ?? {}).length === 0
  if (ro) {
    $('new-form').hidden = true
  }
}

const resetTuning = async () => {
  const ref = subject.ref

  try {
    await api.resetSettings(ref)
    delete selection.settings[ref]
    renderPreview()
    renderTune()
    showConfirm(S.resetDone)
  } catch (error) {
    showConfirm(fill(S.saveFailed, { error: cleanError(error) }))
  }
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
  if (s.ref === selection.theme || (s.entry && !s.entry.ok)) {
    return
  }
  try {
    await api.select(s.ref)
    selection.theme = s.ref
    renderRows()
    renderHead()
    showConfirm(S.appliedNote)
  } catch (error) {
    showConfirm(fill(S.saveFailed, { error: cleanError(error) }))
  }
}

let askAction = null

const ask = (text, yes, action) => {
  $('ask-text').textContent = text
  $('ask-yes').textContent = yes
  $('ask-no').textContent = S.cancel
  $('ask').hidden = false
  askAction = action
}

const hideAsk = () => {
  $('ask').hidden = true
  askAction = null
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
  if (item.hasScene) {
    box.append(el('span', 'mini-tag', S.animated))
  }

  return box
}

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
  meta.append(name, el('div', 'tile-sub', `${item.author} · ${fill(S.downloadsN, { n: item.downloads })}`))
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
  const current = G.tag

  select.replaceChildren(el('option', null, S.allTags))
  select.firstChild.value = ''
  for (const t of [...G.tags].sort()) {
    const o = el('option', null, t)

    o.value = t
    select.append(o)
  }
  select.value = current
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

const U = { auth: { configured: false, signedIn: false, login: null }, flow: null, check: null, mine: null, mineError: null, sending: false, result: null }

const renderAccount = () => {
  const dd = $('up-account')

  dd.replaceChildren()
  if (!U.auth.configured) {
    dd.append(el('span', 'notice', S.notConfigured))

    return
  }
  if (U.flow) {
    if (U.flow.error) {
      dd.append(el('span', 'error-text', U.flow.error))
      dd.append(button('ghost flat', S.signIn, startSignIn))

      return
    }
    dd.append(el('span', 'muted-text', S.codeLabel))
    const code = el('span', 'device-code', U.flow.userCode)

    code.setAttribute('aria-live', 'polite')
    const row = el('div', 'inline')

    row.append(button('primary small', S.openGithub, () => api.openDevicePage()), button('tiny-link', S.cancel, cancelSignIn))
    dd.append(code, row, el('span', 'muted-text', S.waiting))

    return
  }
  if (U.auth.signedIn) {
    const row = el('div', 'inline')

    row.append(el('span', null, fill(S.signedInAs, { login: U.auth.login ?? '…' })), button('ghost flat', S.signOut, signOut))
    dd.append(row)
    if (U.auth.persisted === false) {
      dd.append(el('span', 'muted-text small-text', S.sessionOnly))
    }

    return
  }
  dd.append(button('ghost flat', S.signIn, startSignIn))
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
  send.disabled = U.sending || !U.auth.configured || !U.auth.signedIn || !U.check?.ok
  $('up-result').textContent = U.result ?? (U.auth.configured && !U.auth.signedIn && U.check?.ok ? S.signInFirst : '')
}

const renderMine = () => {
  const show = U.auth.configured && U.auth.signedIn

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
    const meta = el('span', 'muted-text', `v${item.version} · ${fill(S.downloadsN, { n: item.downloads })}`)
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
  const select = $('up-library')
  const keep = select.value

  select.replaceChildren(el('option', null, S.fromLibrary))
  select.firstChild.value = ''
  for (const e of library.filter(x => x.ok)) {
    const o = el('option', null, `${e.skin.name} (${e.ref})`)

    o.value = e.ref
    select.append(o)
  }
  select.value = library.some(e => e.ref === keep) ? keep : ''
}

const loadMine = async () => {
  if (!U.auth.signedIn) {
    return
  }
  U.mine = null
  U.mineError = null
  renderMine()
  try {
    U.mine = (await api.mySkins()).skins
  } catch (error) {
    U.mineError = cleanError(error)
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
  await loadMine()
}

const startSignIn = async () => {
  try {
    const code = await api.authStart()

    if (code.error) {
      U.flow = { error: fill(S.authFailed, { error: code.error }) }
      renderAccount()

      return
    }
    U.flow = code
    renderAccount()
    const r = await api.authWait()

    if (U.flow !== code) {
      return
    }
    U.flow = null
    if (r.error) {
      if (r.error !== 'cancelled') {
        U.flow = { error: r.error === 'access_denied' ? S.authDenied : r.error === 'expired_token' ? S.authExpired : fill(S.authFailed, { error: r.error }) }
      }
    } else {
      U.auth = r
    }
    renderUpload()
    await loadMine()
  } catch (error) {
    U.flow = { error: fill(S.authFailed, { error: cleanError(error) }) }
    renderAccount()
  }
}

const cancelSignIn = async () => {
  U.flow = null
  await api.authCancel().catch(() => {})
  renderAccount()
}

const signOut = async () => {
  U.auth = await api.signOut().catch(() => ({ ...U.auth, signedIn: false, login: null }))
  U.mine = null
  renderUpload()
}

const setCheck = r => {
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

const sendUpload = async () => {
  U.sending = true
  U.result = null
  renderChecks()
  try {
    const r = await api.upload()

    U.result = fill(S.uploadedNew, { ref: r.ref, v: r.version })
    library = await api.library()
    await Promise.all(library.map(thumbFor))
    renderLibraryList()
  } catch (error) {
    U.result = fill(S.uploadFailed, { error: cleanError(error) })
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
  t('mode-dark', 'dark')
  t('mode-light', 'light')
  t('tab-overview', 'tabOverview')
  t('tab-tune', 'tabTune')
  t('mock-text', 'mockText')
  t('mock-user', 'mockUser')
  t('mock-input', 'mockInput')
  t('hint', 'hint')
  t('fill-label', 'fillLabel')
  t('reset', 'resetDefaults')
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

const wire = () => {
  $('lib-list').addEventListener('keydown', onListKey)
  $('nav-gallery').addEventListener('click', showGallery)
  $('nav-upload').addEventListener('click', showUpload)
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
  $('fill').addEventListener('input', () => {
    fillPct = Number($('fill').value)
    renderPreview()
  })
  $('apply').addEventListener('click', apply)
  $('report').addEventListener('click', report)
  $('ask-yes').addEventListener('click', () => {
    const action = askAction

    hideAsk()
    action?.()
  })
  $('ask-no').addEventListener('click', hideAsk)
  $('reset').addEventListener('click', resetTuning)
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
  window.addEventListener('beforeunload', () => {
    api.flushSettings().catch(() => {})
  })
}

const start = async () => {
  const init = await api.init()

  S = init.strings
  library = init.library
  selection = { theme: init.selection.theme, settings: init.selection.settings ?? {} }
  status = init.status
  isShot = init.shot !== null
  document.documentElement.lang = init.lang === 'zh' ? 'zh-CN' : 'en'
  texts()
  wire()
  await Promise.all(library.map(thumbFor))
  renderLibraryList()
  renderStatus()

  const shotView = init.shot?.view ?? 'library'
  const firstRef = init.shot?.select && init.shot.view !== 'detail' ? init.shot.select : (selection.theme ?? library.find(e => e.ok)?.ref ?? 'default')

  await showLibrary(entryByRef(firstRef) || firstRef === 'default' ? firstRef : 'default')
  if (shotView === 'tune') {
    tab = 'tune'
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
  }

  // The CLI check can take a few seconds; show the heartbeat-only status first.
  api
    .refresh()
    .then(s => {
      status = s
      renderStatus()
    })
    .catch(() => {})
  setInterval(poll, POLL_MS)

  if (isShot) {
    await sceneLoaded
    await nextFrame()
    api.ready()
  }
}

start()
