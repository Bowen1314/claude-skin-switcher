'use strict'

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { BrowserWindow, Menu, app, dialog, ipcMain, nativeTheme, safeStorage, shell } = require('electron')

const { bridgeStatus, readHeartbeat } = require('./src/bridge')
const constants = require('./src/constants')
const { loadDeps } = require('./src/deps')
const { createGallery, checkName } = require('./src/gallery')
const { langFor, stringsFor } = require('./src/i18n')
const { checkInstalled, installBridge } = require('./src/installer')
const { bundledSkinsDir, marketplaceSources } = require('./src/marketplace')
const { homeDir, stateDir, tildify } = require('./src/paths')
const { screenshotOptions } = require('./src/screenshot')
const { createService } = require('./src/service')
const { REF } = require('./src/skin-render')
const { createTokenStore } = require('./src/token-store')

const INDEX_FILE = path.join(__dirname, 'renderer', 'index.html')

const shot = screenshotOptions(process.env)
const home = homeDir(process.env, process.platform, os.homedir())
const dir = stateDir(home, process.platform)

let lang = 'en'
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
  const config = {
    githubUrl: shot?.githubUrl ?? constants.GITHUB_URL,
    clientId: shot?.clientId ?? constants.GITHUB_CLIENT_ID,
    localOwner: constants.LOCAL_OWNER,
  }
  // Screenshot runs never write to a gallery and never reach the keychain.
  const gallery = createGallery({ baseUrl: shot?.galleryUrl ?? constants.GALLERY_URL, readOnly: shot !== null, deps })
  const tokenStore = shot
    ? memoryTokenStore(shot.token)
    : createTokenStore({ file: path.join(app.getPath('userData'), 'github-token.bin'), getSafeStorage: () => safeStorage })

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
    strings: stringsFor(lang),
    library: await service.library(),
    selection: await service.selection(),
    shot: shot ? { view: shot.view, select: shot.select } : null,
    status: await currentStatus(),
  }))

  handle('app:ready', () => {
    if (shot) {
      setTimeout(capture, 400)
    }
  })

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
  handle('library:scene', r => service.scene(ref(r)))
  handle('theme:select', r => service.select(r === 'default' ? 'default' : ref(r)))
  handle('settings:set', (r, raw) => service.setSettings(ref(r), plain(raw)))
  handle('settings:reset', r => service.resetSettings(ref(r)))
  handle('settings:flush', () => service.flush().then(() => true))
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
  handle('auth:openDevicePage', () => shell.openExternal(constants.GITHUB_DEVICE_PAGE))

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

const createWindow = () => {
  window = new BrowserWindow({
    width: 980,
    height: 640,
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
    lang = langFor(app.getLocale())
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
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow()
      }
    })
  })

  // Write tuning that is still waiting for its debounce before the app goes.
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
