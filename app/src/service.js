'use strict'

// Everything the window can ask for, without Electron, so tests can drive it
// with a temp HOME and a local mock server. main.js only adds IPC and dialogs.

const fs = require('node:fs')
const path = require('node:path')

const { exchangeCode, isFresh, refreshIdToken, startLoopback } = require('./google')
const { listItem, refOrNull } = require('./gallery')
const { checkMeta, codeOf, listLibrary, makeRef, readCode, readEntry, readScene, removeSkinDir, saveSkin, skinFileText, skinsDir, syncOfficial } = require('./library')
const { HttpError } = require('./http')
const { createSelectionStore } = require('./selection')
const { normalizeSettings, parseSkin, sparseSettings } = require('./skin-render')
const { bakeTuning, importFolder, prepareUpload } = require('./upload')

const message = error => String(error?.message ?? error)

// Only skins the person made can be uploaded. Gallery downloads and the
// built-in skins are someone else's.
const UPLOADABLE = new Set(['local', 'upload'])
const FOREIGN = new Set(['gallery', 'bundled'])
const isUploadable = e => Boolean(e?.ok) && UPLOADABLE.has(e.meta.source)
const copyMessage = c => `This is ${c.name} by ${c.author} from the gallery. You can only upload skins you made.`
const withBasedOn = (payload, basedOn) => (typeof basedOn === 'string' ? { ...payload, basedOn } : payload)
// How long a skin that looks gone gets before the selection is reset (a folder
// being swapped by writeSkinDir is briefly missing).
const SETTLE_MS = 150

const createService = ({ dir, deps, bundledDir, gallery, tokenStore, config }) => {
  const libDir = skinsDir(dir)
  const store = createSelectionStore(dir)
  let entries = []
  let flow = null // the loopback sign-in in progress
  let handle // undefined = not asked yet, null = no public name chosen
  let idCache = null // { idToken, expiresAt }
  let staged = null // the checked upload payload

  const configured = () => typeof config.clientId === 'string' && config.clientId !== ''
  const entry = ref => entries.find(e => e.ref === ref)
  const usable = ref => {
    const e = entry(ref)

    if (e === undefined || !e.ok) {
      throw new Error(`Not a usable skin: ${String(ref)}`)
    }

    return e
  }

  const refresh = async () => {
    entries = await listLibrary(libDir, deps)

    return entries
  }

  // selection.json names a skin that is gone or no longer passes the checks:
  // back to Claude's default (selection.forget also drops its settings).
  // Returns the ref that was reset, or null.
  const healSelection = async () => {
    const { theme } = await store.read()

    if (theme === null || theme === 'default' || entry(theme)?.ok) {
      return null
    }
    await new Promise(resolve => setTimeout(resolve, SETTLE_MS))
    if ((await readEntry(libDir, theme, deps)).ok) {
      return null
    }

    return (await store.forget(theme)) ? theme : null
  }

  const myHandle = () => (typeof handle === 'string' ? handle : null)

  // The gallery or built-in skin in the library that draws the same thing
  // (shared/fingerprint.js), or null. Skins under the person's own public name
  // don't count, nor a match the upload declares itself a remix of (basedOn).
  const copyOf = async ({ skin, scene }, { basedOn = null, owner = null } = {}) => {
    const mine = await deps.fingerprint(skin, scene ?? null)
    const matches = []

    for (const e of entries) {
      if (!e.ok || !FOREIGN.has(e.meta.source) || (owner !== null && e.owner === owner)) {
        continue
      }
      try {
        if ((await deps.fingerprint(e.skin, e.hasScene ? await readScene(libDir, e.ref, deps) : null)) === mine) {
          matches.push(e)
        }
      } catch {
        // A scene that can't be read now is skipped; the gallery checks again.
      }
    }
    if (matches.length === 0 || (basedOn !== null && matches.some(e => e.ref === basedOn))) {
      return null
    }
    const e = matches.find(m => m.meta.basedOn === undefined) ?? matches[0]

    return { ref: e.ref, name: e.skin.name, author: e.meta.author ?? e.owner }
  }

  const now = () => (config.now ?? Date.now)()
  const google = { tokenUrl: config.googleTokenUrl, clientId: config.clientId, clientSecret: config.clientSecret ?? '', fetchImpl: config.fetchImpl }

  const forget = async () => {
    idCache = null
    handle = undefined
    await tokenStore.clear()
  }

  // A fresh Google id token for the gallery, from the stored refresh token.
  // A revoked refresh token signs the person out.
  const idToken = async () => {
    if (!configured()) {
      throw new HttpError('Not signed in', { code: 'no-token' })
    }
    if (isFresh(idCache, now())) {
      return idCache.idToken
    }
    const refreshToken = await tokenStore.load()

    if (!refreshToken) {
      throw new HttpError('Not signed in', { code: 'no-token' })
    }
    try {
      idCache = await refreshIdToken({ ...google, refreshToken, now })
    } catch (error) {
      if (error.code === 'invalid_grant') {
        await forget()
        throw new HttpError('Google signed you out. Sign in again.', { code: 'signed-out' })
      }
      throw error
    }

    return idCache.idToken
  }

  const whoAmI = async t => {
    if (handle === undefined) {
      handle = (await gallery.me(t)).handle
    }

    return handle
  }

  const needHandle = async t => {
    const h = await whoAmI(t)

    if (h === null) {
      throw new HttpError('Choose your public name first', { code: 'no-handle' })
    }

    return h
  }

  const cancelFlow = () => {
    if (flow !== null) {
      flow.cancel()
      flow = null
    }
  }

  const state = async () => {
    if (!configured()) {
      return { configured: false, signedIn: false, handle: null }
    }
    if (!(await tokenStore.load())) {
      return { configured: true, signedIn: false, handle: null }
    }
    try {
      return { configured: true, signedIn: true, handle: await whoAmI(await idToken()) }
    } catch (error) {
      return error.code === 'signed-out'
        ? { configured: true, signedIn: false, handle: null, error: message(error) }
        : { configured: true, signedIn: true, handle: handle ?? null, error: message(error) }
    }
  }

  return {
    libDir,
    store,

    // Copy in the bundled skins, then read the library. Returns the refs that changed.
    start: async () => {
      let changed = []

      if (bundledDir && fs.existsSync(bundledDir)) {
        changed = await syncOfficial({ bundledDir, libDir, deps })
        for (const ref of changed) {
          await store.touchIfActive(ref)
        }
      }
      await refresh()
      await healSelection()

      return changed
    },

    library: refresh,
    // The window came back to the front: read the library again and reset a
    // selection that points at a skin that is gone or broken.
    refresh: async () => {
      await refresh()
      const reset = await healSelection()

      return { library: entries, selection: await store.read(), reset }
    },
    // Skins the Upload view may offer: ones made here or uploaded by this person.
    uploadable: () => entries.filter(isUploadable).map(e => e.ref),
    entries: () => entries,
    scene: ref => readScene(libDir, ref, deps),
    // The raw skin.json / scene.svg on disk and the validator's verdict.
    code: ref => readCode(libDir, ref, deps),
    selection: () => store.read(),

    // Apply: the theme plus that skin's tuning (the draft the window holds),
    // checked against the skin on disk, in one atomic write. Tuning is never
    // written before this, so skins that were never applied get no settings.
    // Returns the normalized settings and the sparse set that was written.
    select: async (ref, raw) => {
      if (ref === 'default') {
        await store.setTheme('default')

        return { theme: 'default', settings: null, sparse: null }
      }
      const skin = parseSkin(usable(ref).skin)
      const sparse = sparseSettings(raw ?? {}, skin)

      await store.applyTheme(ref, sparse)

      return { theme: ref, settings: normalizeSettings(sparse, skin), sparse }
    },

    // "Save as new skin": current knob values become the defaults of a local copy.
    saveTuned: async (ref, { slug, name, vars }) => {
      const source = usable(ref)
      const newRef = makeRef(config.localOwner, slug)

      if (newRef === null) {
        return { ok: false, errors: ['The slug must be 3 to 40 of a-z, 0-9 and inner hyphens.'] }
      }
      if (entry(newRef) !== undefined) {
        return { ok: false, errors: [`${newRef} already exists.`] }
      }
      let baked

      try {
        baked = bakeTuning(source.skin, vars, { slug, name })
      } catch (error) {
        return { ok: false, errors: [message(error)] }
      }
      const scene = source.hasScene ? await readScene(libDir, ref, deps) : undefined
      // Made from someone else's skin: credit it (the gallery checks the claim).
      const own = myHandle() !== null && source.owner === myHandle()
      const basedOn = FOREIGN.has(source.meta.source) && !own ? source.ref : (source.meta.basedOn ?? null)
      const meta = { author: config.localOwner, version: 1, source: 'local', ...(basedOn !== null ? { basedOn } : {}) }
      const saved = await saveSkin({ libDir, owner: config.localOwner, skin: baked, scene, meta, deps })

      await refresh()

      return saved
    },

    // ---------- gallery ----------

    galleryList: opts => gallery.list(opts),

    galleryDetail: async (author, slug) => {
      const detail = await gallery.detail(author, slug)
      const mine = entry(`${author}.${slug}`)

      // The files Save would write (and Claude would read), not a rebuild for show.
      const checked = deps.validateSkin(detail.skin)
      const m = checkMeta({ author, version: detail.version }, author.toLowerCase(), null)
      const code = checked.ok ? codeOf(skinFileText(checked.skin, author.toLowerCase(), m.version), detail.scene, deps) : { skinJson: JSON.stringify(detail.skin, null, 2), sceneSvg: detail.scene, check: { ok: false, errors: checked.errors } }

      return { ...detail, ref: `${author}.${slug}`, savedVersion: mine?.ok ? (mine.meta.version ?? 1) : null, code }
    },

    // Fetches again here rather than trusting what the window holds.
    gallerySave: async (author, slug) => {
      // A public name could equal the local owner; never overwrite a skin made here.
      if (entry(`${author}.${slug}`)?.meta.source === 'local') {
        return { ok: false, ref: null, errors: [`${author}.${slug} is a skin you made in this app; rename it first.`] }
      }
      const detail = await gallery.detail(author, slug)
      // The person's own upload, downloaded again, stays theirs.
      const source = author === myHandle() ? 'upload' : 'gallery'
      const meta = { author, version: detail.version, source, ...(detail.basedOn ? { basedOn: detail.basedOn } : {}) }
      const saved = await saveSkin({ libDir, owner: author, skin: detail.skin, scene: detail.scene ?? undefined, meta, deps })

      if (saved.ok) {
        await store.touchIfActive(saved.ref)
        gallery.download(author, slug).catch(() => {})
      }
      await refresh()

      return saved
    },

    galleryReport: (author, slug) => gallery.report(author, slug),

    // ---------- Google sign-in ----------

    authState: state,

    // Opens the browser; one sign-in at a time (a new start cancels the old one).
    authStart: async () => {
      if (!configured()) {
        return { error: 'not-configured' }
      }
      cancelFlow()
      flow = await startLoopback({ authUrl: config.googleAuthUrl, clientId: config.clientId, openExternal: config.openExternal, timeoutMs: config.signInTimeoutMs })

      return { started: true }
    },

    authWait: async () => {
      const current = flow

      if (current === null) {
        return { error: 'no-flow' }
      }
      const result = await current.result

      if (flow === current) {
        flow = null
      }
      // The browser can't hand focus back on its own: bring the app forward.
      config.focusApp?.()
      if (result.code === undefined) {
        return { error: result.error }
      }
      let tokens

      try {
        tokens = await exchangeCode({ ...google, code: result.code, verifier: current.verifier, redirectUri: current.redirectUri, now })
      } catch (error) {
        return { error: message(error) }
      }
      const saved = await tokenStore.save(tokens.refreshToken)

      idCache = { idToken: tokens.idToken, expiresAt: tokens.expiresAt }
      handle = undefined

      return { ...(await state()), persisted: saved.persisted }
    },

    authCancel: () => {
      cancelFlow()

      return true
    },

    signOut: async () => {
      cancelFlow()
      await forget()

      return { configured: configured(), signedIn: false, handle: null }
    },

    // The public name uploads appear under. Server errors come back as messages.
    claimHandle: async name => {
      const t = await idToken()
      const r = await gallery.claimHandle(t, name)

      handle = r.handle

      return state()
    },

    // ---------- upload ----------

    mine: async () => gallery.me(await idToken()),

    checkFolder: async folder => {
      const imported = await importFolder(folder)

      staged = null
      if (!imported.ok) {
        return { ok: false, errors: imported.errors, label: path.basename(folder) }
      }
      const prep = prepareUpload({ skin: imported.skin, scene: imported.scene, deps })
      const label = path.basename(folder)

      if (!prep.ok) {
        return { ok: false, errors: prep.errors, label, name: null, slug: null }
      }
      const info = { label, name: prep.payload.skin.name, slug: prep.payload.skin.slug }
      const copy = await copyOf(prep.payload, { basedOn: imported.basedOn, owner: myHandle() })

      if (copy !== null) {
        return { ok: false, errors: [copyMessage(copy)], copyOf: copy, ...info }
      }
      staged = withBasedOn(prep.payload, imported.basedOn)

      return { ok: true, errors: [], ...info }
    },

    // The skin as stored in the library (its own files, not the in-memory copy).
    checkLibrary: async ref => {
      const e = usable(ref)
      const info = { label: ref, name: e.skin.name, slug: e.slug }

      staged = null
      if (!isUploadable(e)) {
        return { ok: false, errors: ['Only skins you made can be uploaded.'], notMine: true, ...info }
      }
      const folder = path.join(libDir, ref)
      const imported = await importFolder(folder)
      const prep = imported.ok ? prepareUpload({ skin: imported.skin, scene: imported.scene, deps }) : { ok: false, errors: imported.errors }

      if (!prep.ok) {
        return { ok: false, errors: prep.errors, ...info }
      }
      const basedOn = e.meta.basedOn ?? null
      const copy = await copyOf(prep.payload, { basedOn, owner: myHandle() })

      if (copy !== null) {
        return { ok: false, errors: [copyMessage(copy)], copyOf: copy, ...info }
      }
      staged = withBasedOn(prep.payload, basedOn)

      return { ok: true, errors: [], ...info }
    },

    upload: async () => {
      if (staged === null) {
        throw new Error('Nothing checked to upload')
      }
      const t = await idToken()
      const owner = await needHandle(t)
      const payload = staged
      // Checked again right before sending, against the library as it is now.
      const local = await copyOf(payload, { basedOn: payload.basedOn ?? null, owner })

      if (local !== null) {
        return { ok: false, copyOf: local, error: copyMessage(local) }
      }
      let result

      try {
        result = await gallery.upload(t, payload)
      } catch (error) {
        // 409 { error: "already in the gallery", original, name }: another author's skin draws the same.
        const original = error?.status === 409 ? refOrNull(error.data?.original) : null

        if (original === null) {
          throw error
        }
        const [author, slug] = original.split('.')
        const copy = { ref: original, author, name: listItem({ author, slug, name: error.data.name })?.name ?? slug }

        return { ok: false, copyOf: copy, error: copyMessage(copy) }
      }
      const meta = { author: owner, version: result.version, source: 'upload', ...(payload.basedOn ? { basedOn: payload.basedOn } : {}) }
      const saved = await saveSkin({ libDir, owner, skin: payload.skin, scene: payload.scene, meta, deps })

      if (saved.ok) {
        await store.touchIfActive(saved.ref)
      }
      await refresh()

      return { ok: true, ...result, ref: saved.ok ? saved.ref : result.ref, savedOk: saved.ok }
    },

    // Delete a skin from the local library (never official ones). If it is the
    // active theme, selection.json goes back to "default" first (Claude follows
    // in about 2 s); its settings go in the same write. Then the folder goes.
    deleteSkin: async ref => {
      const e = entry(ref)

      if (e === undefined) {
        throw new Error(`Not in the library: ${String(ref)}`)
      }
      if (e.owner === 'official' || e.meta.source === 'bundled') {
        throw new Error('Built-in skins cannot be deleted')
      }
      const switchedToDefault = await store.forget(ref)

      await removeSkinDir(libDir, ref)
      await refresh()

      return { ok: true, ref, switchedToDefault }
    },

    removeMine: async slug => {
      const t = await idToken()

      return gallery.remove(t, await needHandle(t), slug)
    },

    // On quit: stop a sign-in in progress and let a write in progress finish.
    // Unapplied drafts live only in the window and are dropped.
    shutdown: async () => {
      cancelFlow()
      await store.idle()
    },
  }
}

module.exports = { createService }
