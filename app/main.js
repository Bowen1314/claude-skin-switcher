'use strict'

const { execFile, spawn } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { BrowserWindow, Menu, app, dialog, ipcMain, nativeTheme, net, safeStorage, shell } = require('electron')

const { bridgeStatus, readHeartbeat } = require('./src/bridge')
const constants = require('./src/constants')
const { loadDeps } = require('./src/deps')
const { createGallery, checkName } = require('./src/gallery')
const { stringsFor } = require('./src/i18n')
const { checkInstalled, installBridge } = require('./src/installer')
const { bundledSkinsDir, marketplaceSources } = require('./src/marketplace')
const { homeDir, stateDir, tildify } = require('./src/paths')
const { createPrefs, resolveLang } = require('./src/prefs')
const { screenshotOptions } = require('./src/screenshot')
const { createService } = require('./src/service')
const { REF } = require('./src/skin-render')
const { createTokenStore } = require('./src/token-store')
const { CHECK_DELAY_MS, CHECK_EVERY_MS, createUpdater, netGet, updateEndpoints } = require('./src/updater')

const INDEX_FILE = path.join(__dirname, 'renderer', 'index.html')

const shot = screenshotOptions(process.env)
const home = homeDir(process.env, process.platform, os.homedir())
const dir = stateDir(home, process.platform)

let lang = 'en'
let prefs = null
let updater = null
let shotUpdate = null // screenshot runs: a fixed update state, no network
let installed = null // null until the first check finishes
let installing = false
let window = null
let service = null
let quitting = false

const refreshInstalled = async () => {
  try {
    // Screenshot runs never spawn the CLI; they only read settings.json.
    installed = await checkInstalled(shot ? { home, find: async () => null } : { home })
  } catch {
    installed = false
  }

  return installed
}

const systemLanguages = () => (shot ? [app.getLocale()] : app.getPreferredSystemLanguages())

const currentStatus = async () => ({ ...bridgeStatus({ heartbeat: await readHeartbeat(dir), installed, now: Date.now() }), installing })

const memoryTokenStore = initial => {
  let token = initial

  return {
    load: async () => token,
    save: async t => {
      token = t

      return { ok: true, persisted: false }
    },
    clear: async () => {
      token = null
    },
  }
}

const makeService = async () => {
  const deps = await loadDeps({ isPackaged: app.isPackaged, resourcesPath: process.resourcesPath, appDir: __dirname })

  const where = { isPackaged: app.isPackaged, resourcesPath: process.resourcesPath, appDir: __dirname }
  const googleBase = shot?.googleUrl ?? null
  const config = {
    googleAuthUrl: googleBase ? `${googleBase}/o/oauth2/v2/auth` : constants.GOOGLE_AUTH_URL,
    googleTokenUrl: googleBase ? `${googleBase}/token` : constants.GOOGLE_TOKEN_URL,
    clientId: shot?.clientId ?? constants.GOOGLE_CLIENT_ID,
    clientSecret: constants.GOOGLE_CLIENT_SECRET,
    localOwner: constants.LOCAL_OWNER,
    // The one-time cleanup of library skins left next to their upload, per public name.
    mergeMarks: {
      has: async h => (prefs.get().mergedUploads ?? []).includes(h),
      add: async h => {
        await prefs.set({ mergedUploads: [...(prefs.get().mergedUploads ?? []), h] })
      },
    },
    // The sign-in page opens in the person's own browser; screenshot runs never open anything.
    openExternal: url => (shot ? Promise.resolve() : shell.openExternal(url)),
    // After the browser hands back the sign-in, put the app in front again.
    focusApp: () => {
      if (shot || window === null || window.isDestroyed()) {
        return
      }
      if (window.isMinimized()) {
        window.restore()
      }
      window.show()
      if (process.platform === 'darwin') {
        app.focus({ steal: true })
      }
      window.focus()
    },
  }
  // Screenshot runs never write to a gallery and never reach the keychain.
  const gallery = createGallery({ baseUrl: shot?.galleryUrl ?? constants.GALLERY_URL, readOnly: shot !== null, deps })
  const tokenStore = shot
    ? memoryTokenStore(shot.token)
    : createTokenStore({ file: path.join(app.getPath('userData'), 'google-refresh-token.bin'), getSafeStorage: () => safeStorage })

  return createService({ dir, deps, bundledDir: bundledSkinsDir(where), gallery, tokenStore, config })
}

// Only answer our own window's top frame (navigation away is blocked).
const fromApp = event => window !== null && event.sender === window.webContents && event.senderFrame === event.sender.mainFrame

const handle = (channel, fn) =>
  ipcMain.handle(channel, (event, ...args) => {
    if (!fromApp(event)) {
      throw new Error('Unexpected sender')
    }

    return fn(...args)
  })

const ref = value => {
  if (typeof value !== 'string' || !REF.test(value)) {
    throw new Error('Not a skin name')
  }

  return value
}

const names = (author, slug) => {
  checkName(author, slug)

  return [author, slug]
}

const plain = value => JSON.parse(JSON.stringify(value ?? null))

const registerIpc = () => {
  handle('app:init', async () => ({
    lang,
    language: prefs.get().language,
    autoUpdate: prefs.get().autoUpdate,
    update: updateState(),
    platform: process.platform,
    strings: stringsFor(lang),
    library: await service.library(),
    selection: await service.selection(),
    shot: shot ? { view: shot.view, select: shot.select, draft: shot.draft, tab: shot.tab, picker: shot.picker, del: shot.del, dropdown: shot.dropdown } : null,
    status: await currentStatus(),
  }))

  handle('app:ready', () => {
    if (shot) {
      setTimeout(capture, 400)
    }
  })

  handle('app:version', () => app.getVersion())

  handle('bridge:status', currentStatus)
  handle('bridge:refresh', async () => {
    await refreshInstalled()

    return currentStatus()
  })
  handle('bridge:install', async () => {
    if (installing) {
      return { ok: false, busy: true }
    }
    installing = true
    try {
      const sources = marketplaceSources({ isPackaged: app.isPackaged, resourcesPath: process.resourcesPath, appDir: __dirname })
      const result = await installBridge({ home, sources })

      await refreshInstalled()

      return { ...result, settingsFileShown: tildify(result.settingsFile, home, process.platform) }
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) }
    } finally {
      installing = false
    }
  })

  handle('library:list', () => service.library())
  // Window focus: the library again, plus the selection (reset if its skin is gone or broken).
  handle('library:refresh', () => service.refresh())
  handle('library:scene', r => service.scene(ref(r)))
  handle('library:code', r => service.code(ref(r)))
  handle('library:delete', r => service.deleteSkin(ref(r)))
  // Apply: the theme plus the window's draft settings for it, written together.
  handle('theme:select', (r, raw) => service.select(r === 'default' ? 'default' : ref(r), plain(raw)))
  handle('library:saveTuned', (r, opts) => {
    const o = plain(opts) ?? {}

    return service.saveTuned(ref(r), { slug: String(o.slug ?? ''), name: String(o.name ?? ''), vars: o.vars })
  })

  handle('gallery:list', opts => service.galleryList(plain(opts) ?? {}))
  handle('gallery:detail', (a, s) => service.galleryDetail(...names(a, s)))
  handle('gallery:save', (a, s) => service.gallerySave(...names(a, s)))
  handle('gallery:report', (a, s) => service.galleryReport(...names(a, s)))

  handle('auth:state', () => service.authState())
  handle('auth:start', () => service.authStart())
  handle('auth:wait', () => service.authWait())
  handle('auth:cancel', () => service.authCancel())
  handle('auth:signOut', () => service.signOut())
  handle('auth:claimHandle', name => service.claimHandle(String(name ?? '')))

  handle('upload:mine', () => service.mine())
  handle('upload:pickFolder', async () => {
    const picked = await dialog.showOpenDialog(window, { properties: ['openDirectory'] })

    return picked.canceled || picked.filePaths.length === 0 ? null : service.checkFolder(picked.filePaths[0])
  })
  handle('upload:checkLibrary', r => service.checkLibrary(ref(r)))
  handle('upload:send', () => service.upload())
  handle('upload:delete', slug => {
    checkName('x', slug)

    return service.removeMine(slug)
  })

  handle('repo:open', () => shell.openExternal(constants.REPO_URL))

  // Language: 'system' | 'en' | 'zh'. The window re-renders with the strings it gets back.
  handle('prefs:setLanguage', async choice => {
    const next = await prefs.set({ language: String(choice ?? '') })

    lang = resolveLang(next.language, systemLanguages())
    window?.setTitle(stringsFor(lang).appName)

    return { lang, language: next.language, strings: stringsFor(lang) }
  })
  handle('prefs:setAutoUpdate', async on => {
    const next = await prefs.set({ autoUpdate: on === true })

    scheduleChecks()

    return { autoUpdate: next.autoUpdate }
  })

  handle('update:state', updateState)
  handle('update:check', () => (updater ? updater.check({ manual: true }) : updateState()))
  // Only ever started by a click on Update (or TS_UPDATE_AUTOCLICK against a local mock).
  handle('update:start', () => (updater ? updater.update() : updateState()))
  handle('update:cancel', () => (updater ? updater.cancel() : updateState()))
  handle('update:notes', () => updater?.openNotes())
}

// ---------- updates ----------

const updateState = () => (shotUpdate ?? updater?.state() ?? { status: 'idle', current: app.getVersion(), latest: null, notesUrl: null, progress: null, error: null })

const sendUpdate = state => {
  if (window !== null && !window.isDestroyed()) {
    window.webContents.send('update:state', state)
  }
}

let checkTimer = null
let checkInterval = null

const scheduleChecks = () => {
  clearTimeout(checkTimer)
  clearInterval(checkInterval)
  if (updater === null || !prefs.get().autoUpdate) {
    return
  }
  checkTimer = setTimeout(() => updater.check(), CHECK_DELAY_MS)
  checkInterval = setInterval(() => updater.check(), CHECK_EVERY_MS)
}

const runFile = (cmd, args) =>
  new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 120000, maxBuffer: 1024 * 1024 }, (error, stdout) => (error ? reject(error) : resolve(stdout)))
  })

const makeUpdater = () => {
  const endpoints = updateEndpoints(process.env)
  let clicked = false
  // Local test runs: the relaunched app keeps the temp HOME, the mock and the profile folder.
  const relaunch = endpoints.local
    ? { open: ['-n', '--env', `HOME=${home}`, '--env', `TS_UPDATE_URL=${endpoints.local}`], args: process.argv.filter(a => a.startsWith('--user-data-dir=')) }
    : { open: [], args: [] }
  const u = createUpdater({
    version: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    get: netGet(net),
    endpoints,
    tempRoot: path.join(app.getPath('userData'), 'updates'),
    exePath: app.getPath('exe'),
    isPackaged: app.isPackaged,
    run: runFile,
    spawnDetached: (cmd, args) => spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref(),
    quit: () => app.quit(),
    openExternal: url => shell.openExternal(url),
    relaunch,
    onState: state => {
      sendUpdate(state)
      if (endpoints.autoclick && !clicked && state.status === 'available') {
        clicked = true
        setTimeout(() => u.update(), 0)
      }
    },
  })

  return u
}

// Screenshot runs (TS_UPDATE=available|downloading): the About row in that state.
const fakeUpdate = kind => {
  const [a, b, c] = app.getVersion().split('.').map(Number)
  const latest = `${a}.${b}.${c + 1}`

  return { status: kind, current: app.getVersion(), latest, notesUrl: null, progress: kind === 'downloading' ? 0.42 : null, error: null }
}

const capture = async () => {
  if (window === null || capture.done) {
    return
  }
  capture.done = true
  try {
    let image = await window.webContents.capturePage()
    const { width, height } = image.getSize()
    const [cw, ch] = window.getContentSize()

    if (width !== cw || height !== ch) {
      image = image.resize({ width: cw, height: ch, quality: 'best' })
    }
    fs.writeFileSync(shot.out, image.toPNG())
    app.exit(0)
  } catch (error) {
    process.stderr.write(`screenshot failed: ${error?.stack ?? error}\n`)
    app.exit(1)
  }
}

// No native title bar. macOS: traffic lights inset into the sidebar's top row.
// Windows: caption buttons drawn as an overlay in the page's own colours.
const TITLE_ROW = 44 // matches .platform-darwin .sidebar padding-top / the drag strip
const OVERLAY_HEIGHT = 36
const overlayColors = () => (nativeTheme.shouldUseDarkColors ? { color: '#111214', symbolColor: '#e8e9eb' } : { color: '#ffffff', symbolColor: '#17181b' })

const frameOptions = () => {
  if (process.platform === 'darwin') {
    return { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 18, y: Math.round((TITLE_ROW - 14) / 2) } }
  }
  if (process.platform === 'win32') {
    return { titleBarStyle: 'hidden', titleBarOverlay: { ...overlayColors(), height: OVERLAY_HEIGHT } }
  }

  return {}
}

const createWindow = () => {
  window = new BrowserWindow({
    ...frameOptions(),
    // Packaged builds take the icon from electron-builder (build/); macOS uses the bundle icon.
    ...(process.platform !== 'darwin' && !app.isPackaged ? { icon: path.join(__dirname, 'build', 'icon.png') } : {}),
    width: shot?.size?.width ?? 980,
    height: shot?.size?.height ?? 640,
    minWidth: 860,
    minHeight: 560,
    useContentSize: true,
    show: false,
    title: stringsFor(lang).appName,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#111214' : '#ffffff',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  })
  if (process.platform !== 'darwin') {
    window.removeMenu()
  }
  if (process.platform === 'win32') {
    const recolor = () => window?.setTitleBarOverlay({ ...overlayColors(), height: OVERLAY_HEIGHT })

    nativeTheme.on('updated', recolor)
    window.on('closed', () => nativeTheme.off('updated', recolor))
  }
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', event => event.preventDefault())
  if (shot) {
    // The page says when it has drawn (app:ready); this is only a fallback.
    window.webContents.once('did-finish-load', () => setTimeout(capture, 10000))
  } else {
    window.once('ready-to-show', () => window.show())
  }
  window.on('closed', () => {
    window = null
  })
  window.loadFile(INDEX_FILE)
}

if (!shot && !app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (window !== null) {
      if (window.isMinimized()) {
        window.restore()
      }
      window.focus()
    }
  })

  app.whenReady().then(async () => {
    // Screenshot runs keep preferences in memory and take "System" from --lang.
    prefs = createPrefs({ file: shot ? null : path.join(app.getPath('userData'), 'preferences.json') })
    await prefs.load()
    lang = resolveLang(prefs.get().language, systemLanguages())
    if (shot) {
      shotUpdate = shot.update ? fakeUpdate(shot.update) : null
    } else {
      updater = makeUpdater()
      updater.cleanup()
    }
    if (shot) {
      app.dock?.hide()
      if (shot.scheme !== null) {
        nativeTheme.themeSource = shot.scheme
      }
    }
    if (process.platform === 'darwin') {
      Menu.setApplicationMenu(Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'windowMenu' }]))
    }
    service = await makeService()
    try {
      await service.start()
    } catch (error) {
      process.stderr.write(`library sync failed: ${error?.message ?? error}\n`)
    }
    registerIpc()
    createWindow()
    scheduleChecks()
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow()
      }
    })
  })

  // Let a selection write in progress finish before the app goes (drafts are dropped).
  app.on('before-quit', event => {
    if (quitting || service === null) {
      return
    }
    event.preventDefault()
    quitting = true
    const done = () => app.quit()

    Promise.race([service.shutdown(), new Promise(resolve => setTimeout(resolve, 3000))]).then(done, done)
  })

  app.on('window-all-closed', () => app.quit())
}
