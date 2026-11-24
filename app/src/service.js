'use strict'

// Everything the window can ask for, without Electron, so tests can drive it
// with a temp HOME and a local mock server. main.js only adds IPC and dialogs.

const fs = require('node:fs')
const path = require('node:path')

const { pollForToken, requestDeviceCode } = require('./github')
const { listLibrary, makeRef, readScene, saveSkin, skinsDir, syncOfficial } = require('./library')
const { createSelectionStore } = require('./selection')
const { normalizeSettings, parseSkin, sparseSettings } = require('./skin-render')
const { bakeTuning, importFolder, prepareUpload } = require('./upload')

const SETTINGS_DEBOUNCE_MS = 300

const message = error => String(error?.message ?? error)

const createService = ({ dir, deps, bundledDir, gallery, tokenStore, config, debounceMs = SETTINGS_DEBOUNCE_MS }) => {
  const libDir = skinsDir(dir)
  const store = createSelectionStore(dir)
  let entries = []
  const pending = new Map() // ref -> sparse settings waiting for the debounce
  let timer = null
  let flow = null // { cancelled, promise }
  let login = null
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

  const flush = async () => {
    clearTimeout(timer)
    timer = null
    const writes = [...pending.entries()]

    pending.clear()
    await Promise.all(writes.map(([ref, sparse]) => (Object.keys(sparse).length === 0 ? store.resetSettings(ref) : store.setSettings(ref, sparse))))

    return store.idle()
  }

  const token = async () => (configured() ? tokenStore.load() : null)

  const needToken = async () => {
    const t = await token()

    if (!t) {
      throw new Error('Not signed in')
    }

    return t
  }

  const whoAmI = async t => {
    if (login === null) {
      login = (await gallery.me(t)).login
    }

    return login
  }

  const cancelFlow = () => {
    if (flow !== null) {
      flow.cancelled = true
      flow = null
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

      return changed
    },

    library: refresh,
    entries: () => entries,
    scene: ref => readScene(libDir, ref, deps),
    selection: () => store.read(),

    select: async ref => {
      if (ref !== 'default') {
        usable(ref)
      }
      await flush()
      await store.setTheme(ref)

      return ref
    },

    // Live tuning: returns the full normalized settings at once, writes the
    // sparse set (only what the person changed) after a short debounce.
    setSettings: (ref, raw) => {
      const skin = parseSkin(usable(ref).skin)
      const sparse = sparseSettings(raw, skin)

      pending.set(ref, sparse)
      clearTimeout(timer)
      timer = setTimeout(() => {
        flush().catch(() => {})
      }, debounceMs)

      return normalizeSettings(sparse, skin)
    },

    resetSettings: async ref => {
      pending.delete(ref)
      await store.resetSettings(ref)

      return normalizeSettings({}, parseSkin(usable(ref).skin))
    },

    flush,

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
      const saved = await saveSkin({ libDir, owner: config.localOwner, skin: baked, scene, meta: { author: config.localOwner, version: 1, source: 'local' }, deps })

      await refresh()

      return saved
    },

    // ---------- gallery ----------

    galleryList: opts => gallery.list(opts),

    galleryDetail: async (author, slug) => {
      const detail = await gallery.detail(author, slug)
      const mine = entry(`${author}.${slug}`)

      return { ...detail, ref: `${author}.${slug}`, savedVersion: mine?.ok ? (mine.meta.version ?? 1) : null }
    },

    // Fetches again here rather than trusting what the window holds.
    gallerySave: async (author, slug) => {
      // A GitHub login can equal the local owner; never overwrite a skin made here.
      if (entry(`${author}.${slug}`)?.meta.source === 'local') {
        return { ok: false, ref: null, errors: [`${author}.${slug} is a skin you made in this app; rename it first.`] }
      }
      const detail = await gallery.detail(author, slug)
      const saved = await saveSkin({ libDir, owner: author, skin: detail.skin, scene: detail.scene ?? undefined, meta: { author, version: detail.version, source: 'gallery' }, deps })

      if (saved.ok) {
        await store.touchIfActive(saved.ref)
        gallery.download(author, slug).catch(() => {})
      }
      await refresh()

      return saved
    },

    galleryReport: (author, slug) => gallery.report(author, slug),

    // ---------- GitHub sign-in ----------

    authState: async () => {
      if (!configured()) {
        return { configured: false, signedIn: false, login: null }
      }
      const t = await tokenStore.load()

      if (!t) {
        return { configured: true, signedIn: false, login: null }
      }
      try {
        return { configured: true, signedIn: true, login: await whoAmI(t) }
      } catch (error) {
        return { configured: true, signedIn: true, login: null, error: message(error) }
      }
    },

    // One flow at a time; a new start cancels the old one.
    authStart: async () => {
      if (!configured()) {
        return { error: 'not-configured' }
      }
      cancelFlow()
      const code = await requestDeviceCode({ githubUrl: config.githubUrl, clientId: config.clientId, fetchImpl: config.fetchImpl })
      const current = { cancelled: false }

      current.promise = pollForToken({
        githubUrl: config.githubUrl,
        clientId: config.clientId,
        deviceCode: code.deviceCode,
        interval: code.interval,
        expiresIn: code.expiresIn,
        fetchImpl: config.fetchImpl,
        sleep: config.sleep,
        now: config.now,
        isCancelled: () => current.cancelled,
      })
      flow = current

      return { userCode: code.userCode, verificationUri: code.verificationUri, expiresIn: code.expiresIn }
    },

    authWait: async () => {
      const current = flow

      if (current === null) {
        return { error: 'no-flow' }
      }
      const result = await current.promise

      if (flow === current) {
        flow = null
      }
      if (result.token === undefined) {
        return { error: result.error }
      }
      const saved = await tokenStore.save(result.token)

      login = null
      try {
        await whoAmI(result.token)
      } catch {
        // signed in; the login shows up on the next state check
      }

      return { configured: true, signedIn: true, login, persisted: saved.persisted }
    },

    authCancel: () => {
      cancelFlow()

      return true
    },

    signOut: async () => {
      cancelFlow()
      login = null
      await tokenStore.clear()

      return { configured: configured(), signedIn: false, login: null }
    },

    // ---------- upload ----------

    mine: async () => gallery.me(await needToken()),

    checkFolder: async folder => {
      const imported = await importFolder(folder)

      staged = null
      if (!imported.ok) {
        return { ok: false, errors: imported.errors, label: path.basename(folder) }
      }
      const prep = prepareUpload({ skin: imported.skin, scene: imported.scene, deps })

      staged = prep.ok ? prep.payload : null

      return { ok: prep.ok, errors: prep.errors, label: path.basename(folder), name: prep.payload?.skin.name ?? null, slug: prep.payload?.skin.slug ?? null }
    },

    // The skin as stored in the library (its own files, not the in-memory copy).
    checkLibrary: async ref => {
      const e = usable(ref)
      const folder = path.join(libDir, ref)
      const imported = await importFolder(folder)
      const prep = imported.ok ? prepareUpload({ skin: imported.skin, scene: imported.scene, deps }) : { ok: false, errors: imported.errors }

      staged = prep.ok ? prep.payload : null

      return { ok: prep.ok, errors: prep.errors, label: ref, name: e.skin.name, slug: e.slug }
    },

    upload: async () => {
      if (staged === null) {
        throw new Error('Nothing checked to upload')
      }
      const t = await needToken()
      const owner = await whoAmI(t)
      const payload = staged
      const result = await gallery.upload(t, payload)
      const saved = await saveSkin({ libDir, owner, skin: payload.skin, scene: payload.scene, meta: { author: owner, version: result.version, source: 'upload' }, deps })

      if (saved.ok) {
        await store.touchIfActive(saved.ref)
      }
      await refresh()

      return { ...result, ref: saved.ok ? saved.ref : result.ref, savedOk: saved.ok }
    },

    removeMine: async slug => {
      const t = await needToken()

      return gallery.remove(t, await whoAmI(t), slug)
    },

    // On quit: stop polling GitHub and write any tuning still waiting.
    shutdown: async () => {
      cancelFlow()
      await flush()
    },
  }
}

module.exports = { createService, SETTINGS_DEBOUNCE_MS }
