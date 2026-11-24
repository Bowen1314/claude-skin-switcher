'use strict'

// In-app updates without Squirrel (the macOS builds are ad-hoc signed).
// Checks the latest GitHub release, downloads this platform's asset and the
// electron-builder manifest (latest-mac.yml / latest.yml) from the same
// release, verifies size and sha512, then hands over to a detached installer:
// a small sh script that swaps the .app bundle on macOS, the NSIS installer
// (silent, relaunch) on Windows. Nothing installs until the person clicks
// Update. No Electron here: main.js injects the network, process and quit
// functions, so the logic runs under node --test.

const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const OWNER_REPO = 'Bowen1314/claude-skin-switcher'
const API_PATH = `/repos/${OWNER_REPO}/releases/latest`
const API_URL = `https://api.github.com${API_PATH}`
const DOWNLOAD_PREFIX = `https://github.com/${OWNER_REPO}/releases/download/`
const RELEASES_PREFIX = `https://github.com/${OWNER_REPO}/releases/`
const RELEASES_LATEST = `${RELEASES_PREFIX}latest`
// Where github.com sends release downloads (checked hop by hop).
const ASSET_HOSTS = new Set(['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'])
const LOCAL_URL = /^http:\/\/(127\.0\.0\.1|localhost):\d{1,5}$/

const CHECK_DELAY_MS = 10 * 1000
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000
const MAX_REDIRECTS = 5
const MAX_ASSET_BYTES = 1024 * 1024 * 1024
const IDLE_TIMEOUT_MS = 60 * 1000

class UpdateError extends Error {
  constructor(code, message) {
    super(message ?? code)
    this.code = code
  }
}

const message = error => String(error?.message ?? error)

// ---------- endpoints ----------

// TS_UPDATE_URL=http://127.0.0.1:<port> points the check (and, for that origin
// only, downloads) at a local mock; anything else is ignored. TS_UPDATE_AUTOCLICK=1
// starts the update as soon as one is found, and only together with a local mock.
const updateEndpoints = (env = {}) => {
  const local = typeof env.TS_UPDATE_URL === 'string' && LOCAL_URL.test(env.TS_UPDATE_URL) ? env.TS_UPDATE_URL : null

  return { local, apiUrl: local ? `${local}${API_PATH}` : API_URL, autoclick: local !== null && env.TS_UPDATE_AUTOCLICK === '1' }
}

const parsed = raw => {
  try {
    const u = new URL(String(raw))

    return u.username || u.password ? null : u
  } catch {
    return null
  }
}

const sameOrigin = (u, local) => local !== null && u !== null && u.origin === local

// Where a download may start: this repo's release downloads (or the local mock).
const downloadAllowed = (raw, local = null) => {
  const u = parsed(raw)

  return u !== null && (u.href.startsWith(DOWNLOAD_PREFIX) || sameOrigin(u, local))
}

// Where a download may be redirected to: GitHub's own hosts over https.
const hopAllowed = (raw, local = null) => {
  const u = parsed(raw)

  return u !== null && ((u.protocol === 'https:' && u.port === '' && ASSET_HOSTS.has(u.hostname)) || sameOrigin(u, local))
}

const apiHopAllowed = (raw, local = null) => {
  const u = parsed(raw)

  return u !== null && ((u.protocol === 'https:' && u.port === '' && u.hostname === 'api.github.com') || sameOrigin(u, local))
}

// Pages the app may open in the browser: github.com only.
const externalAllowed = raw => {
  const u = parsed(raw)

  return u !== null && u.protocol === 'https:' && u.hostname === 'github.com' && u.port === ''
}

const notesUrlOf = raw => {
  const u = parsed(raw)

  return u !== null && u.href.startsWith(RELEASES_PREFIX) ? u.href : RELEASES_LATEST
}

// ---------- versions ----------

const parseVersion = raw => {
  const m = /^v?(\d{1,6})\.(\d{1,6})\.(\d{1,6})$/.exec(typeof raw === 'string' ? raw.trim() : '')

  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}

// -1, 0, 1; null when either side isn't a plain x.y.z.
const compareVersions = (a, b) => {
  const x = parseVersion(a)
  const y = parseVersion(b)

  if (x === null || y === null) {
    return null
  }
  for (let i = 0; i < 3; i++) {
    if (x[i] !== y[i]) {
      return x[i] > y[i] ? 1 : -1
    }
  }

  return 0
}

const isNewer = (candidate, current) => compareVersions(candidate, current) === 1

// ---------- release and assets ----------

// The GitHub "latest release" answer, reduced to what is used. Drafts,
// prereleases and tags that aren't vX.Y.Z give null.
const releaseInfo = json => {
  if (json === null || typeof json !== 'object' || json.draft === true || json.prerelease === true) {
    return null
  }
  const v = parseVersion(json.tag_name)

  if (v === null) {
    return null
  }
  const assets = (Array.isArray(json.assets) ? json.assets : [])
    .filter(a => a !== null && typeof a === 'object' && typeof a.name === 'string' && typeof a.browser_download_url === 'string')
    .map(a => ({ name: a.name, url: a.browser_download_url, size: Number.isSafeInteger(a.size) && a.size >= 0 ? a.size : null }))

  return { version: v.join('.'), notesUrl: notesUrlOf(json.html_url), assets }
}

// The file names release.yml uploads (artifactName in package.json).
const assetNames = (version, platform, arch) => {
  if (platform === 'darwin' && (arch === 'arm64' || arch === 'x64')) {
    return { file: `claude-skin-switcher-${version}-mac-${arch}.zip`, yml: 'latest-mac.yml' }
  }
  if (platform === 'win32') {
    return { file: `claude-skin-switcher-${version}-win-x64.exe`, yml: 'latest.yml' }
  }

  return null
}

// { file, yml } assets of the release for this platform, or null.
const pickAssets = (release, platform, arch) => {
  const names = release ? assetNames(release.version, platform, arch) : null

  if (names === null) {
    return null
  }
  const file = release.assets.find(a => a.name === names.file)
  const yml = release.assets.find(a => a.name === names.yml)

  return file && yml ? { file, yml } : null
}

// ---------- latest*.yml ----------

const unquote = raw => {
  const v = raw.trim()

  if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) {
    return v.slice(1, -1).replace(/''/g, "'")
  }
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
    return v.slice(1, -1)
  }

  return v
}

const SHA512_B64 = /^[A-Za-z0-9+/]{86}==$/

// The subset of YAML electron-builder writes: top-level scalars and a
// `files:` list of flat mappings. Returns { version, files: [{ url, sha512, size }] } or null.
const parseUpdateYml = text => {
  if (typeof text !== 'string' || text.length > 100_000) {
    return null
  }
  const top = {}
  const files = []
  let inFiles = false
  let item = null

  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === '' || line.trim().startsWith('#')) {
      continue
    }
    let m = /^([A-Za-z][\w-]*):(?:\s+(.*))?$/.exec(line)

    if (m) {
      const value = m[2] ?? ''

      inFiles = m[1] === 'files' && value.trim() === ''
      item = null
      if (!inFiles) {
        top[m[1]] = unquote(value)
      }
      continue
    }
    if (!inFiles) {
      continue
    }
    m = /^\s+-\s+([A-Za-z][\w-]*):(?:\s+(.*))?$/.exec(line)
    if (m) {
      item = { [m[1]]: unquote(m[2] ?? '') }
      files.push(item)
      continue
    }
    m = /^\s+([A-Za-z][\w-]*):(?:\s+(.*))?$/.exec(line)
    if (m && item !== null) {
      item[m[1]] = unquote(m[2] ?? '')
    }
  }
  const version = parseVersion(top.version)

  if (version === null) {
    return null
  }

  return {
    version: version.join('.'),
    files: files
      .filter(f => typeof f.url === 'string' && f.url !== '' && SHA512_B64.test(f.sha512 ?? '') && /^\d{1,12}$/.test(f.size ?? ''))
      .map(f => ({ url: f.url, sha512: f.sha512, size: Number(f.size) })),
  }
}

// The manifest entry for one asset, by exact file name (one yml covers both mac arches).
const ymlEntry = (yml, name) => yml?.files.find(f => f.url === name) ?? null

const hashFile = file =>
  new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha512')

    fs.createReadStream(file)
      .on('error', reject)
      .on('data', chunk => hash.update(chunk))
      .on('end', () => resolve(hash.digest('base64')))
  })

// { ok } or { ok: false, reason: 'size' | 'sha512' | 'missing' }.
const verifyFile = async (file, expected) => {
  let stat

  try {
    stat = await fs.promises.stat(file)
  } catch {
    return { ok: false, reason: 'missing' }
  }
  if (!stat.isFile() || stat.size !== expected.size) {
    return { ok: false, reason: 'size' }
  }

  return (await hashFile(file)) === expected.sha512 ? { ok: true } : { ok: false, reason: 'sha512' }
}

// ---------- macOS install ----------

// …/Name.app/Contents/MacOS/Name -> …/Name.app, else null.
const bundlePathFromExe = exe => {
  const marker = '.app/Contents/MacOS/'
  const i = typeof exe === 'string' ? exe.lastIndexOf(marker) : -1

  return i > 0 && exe.startsWith('/') ? exe.slice(0, i + 4) : null
}

// Why the bundle can't be replaced in place, or null.
const installBlocker = (bundle, { writable }) => {
  if (typeof bundle !== 'string' || !bundle.endsWith('.app')) {
    return 'not-bundle'
  }
  if (bundle.startsWith('/Volumes/')) {
    return 'dmg'
  }
  if (bundle.includes('/AppTranslocation/')) {
    return 'translocated'
  }

  return writable ? null : 'read-only'
}

const shQuote = s => `'${String(s).replace(/'/g, `'\\''`)}'`

const checkPath = p => {
  if (typeof p !== 'string' || !p.startsWith('/') || p.includes('\0') || p.includes('\n')) {
    throw new Error(`Not an absolute path: ${JSON.stringify(p)}`)
  }

  return p
}

// The detached script: wait for the app to exit (at most ~30 s), swap the
// bundles (old one put back if the new one can't be moved in), clean up and
// open the app again. `open` / `args` add flags to the relaunch (local test
// runs only); `openCmd` is replaceable for tests.
const macInstallScript = ({ pid, oldApp, newApp, workDir, backup, open = [], args = [], openCmd = '/usr/bin/open' }) => {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw new Error('Bad pid')
  }
  for (const p of [oldApp, newApp, workDir, backup]) {
    checkPath(p)
  }
  if (path.posix.dirname(backup) !== path.posix.dirname(oldApp)) {
    throw new Error('The backup must sit next to the app')
  }
  if (installBlocker(oldApp, { writable: true }) !== null) {
    throw new Error(`Refusing to replace ${oldApp}`)
  }
  const relaunch = [shQuote(openCmd), ...open.map(shQuote), '"$OLD"', ...(args.length > 0 ? ['--args', ...args.map(shQuote)] : [])].join(' ')

  return [
    '#!/bin/sh',
    '# Claude Skin Switcher update: replace the app bundle once the app has quit.',
    `PID=${pid}`,
    `OLD=${shQuote(oldApp)}`,
    `NEW=${shQuote(newApp)}`,
    `BACKUP=${shQuote(backup)}`,
    `WORK=${shQuote(workDir)}`,
    'i=0',
    'while kill -0 "$PID" 2>/dev/null; do',
    '  i=$((i + 1))',
    '  if [ "$i" -ge 150 ]; then',
    '    rm -rf "$WORK"',
    '    exit 1',
    '  fi',
    '  sleep 0.2',
    'done',
    '/usr/bin/xattr -cr "$NEW" 2>/dev/null',
    'if mv "$OLD" "$BACKUP"; then',
    '  if mv "$NEW" "$OLD"; then',
    '    rm -rf "$BACKUP"',
    '  else',
    '    mv "$BACKUP" "$OLD"',
    '  fi',
    'fi',
    'rm -rf "$WORK"',
    relaunch,
    '',
  ].join('\n')
}

// ---------- network ----------

// get(url, { headers, signal }) -> { status, location, length, body, close }.
// One request, never following redirects (follow() checks each hop).
const nodeGet = (url, { headers = {}, signal } = {}) =>
  new Promise((resolve, reject) => {
    const u = new URL(url)
    const mod = u.protocol === 'https:' ? require('node:https') : u.protocol === 'http:' ? require('node:http') : null

    if (mod === null) {
      reject(new UpdateError('bad-url', 'Unsupported URL'))

      return
    }
    const req = mod.get(u, { headers, signal }, res => {
      resolve({
        status: res.statusCode,
        location: typeof res.headers.location === 'string' ? res.headers.location : null,
        length: Number(res.headers['content-length']) || null,
        body: res,
        close: () => res.destroy(),
      })
    })

    req.on('error', reject)
  })

// The same over Electron's net module (system proxy settings apply).
const netGet = net => (url, { headers = {}, signal } = {}) =>
  new Promise((resolve, reject) => {
    const req = net.request({ url, redirect: 'manual', useSessionCookies: false })
    let settled = false

    for (const [k, v] of Object.entries(headers)) {
      req.setHeader(k, v)
    }
    const onAbort = () => {
      req.abort()
      if (!settled) {
        settled = true
        reject(new UpdateError('aborted', 'Cancelled'))
      }
    }

    signal?.addEventListener('abort', onAbort, { once: true })
    req.on('redirect', (status, _method, location) => {
      settled = true
      resolve({ status, location, length: null, body: null, close: () => {} })
      req.abort()
    })
    req.on('response', res => {
      const len = res.headers['content-length']

      settled = true
      resolve({
        status: res.statusCode,
        location: null,
        length: Number(Array.isArray(len) ? len[0] : len) || null,
        body: res,
        close: () => {
          req.abort()
          res.destroy?.()
        },
      })
    })
    req.on('error', error => {
      if (!settled) {
        settled = true
        reject(error)
      }
    })
    req.end()
  })

// The final 200 response, every redirect checked with allowHop.
const follow = async (get, url, { allowHop, headers, signal }) => {
  let current = url

  for (let hop = 0; ; hop++) {
    if (signal?.aborted) {
      throw new UpdateError('aborted', 'Cancelled')
    }
    const res = await get(current, { headers, signal })

    if (res.status >= 300 && res.status < 400 && res.location) {
      res.close()
      const next = new URL(res.location, current).href

      if (hop >= MAX_REDIRECTS) {
        throw new UpdateError('network', 'Too many redirects')
      }
      if (!allowHop(next)) {
        throw new UpdateError('bad-url', `Redirected to an unexpected address (${parsed(next)?.host ?? 'invalid'})`)
      }
      current = next
      continue
    }
    if (res.status !== 200) {
      res.close()
      throw new UpdateError('network', `HTTP ${res.status}`)
    }

    return res
  }
}

// Read the body chunk by chunk; stops (and fails) past maxBytes, on abort, or
// after a minute without data.
const eachChunk = async (res, { maxBytes, signal }, onChunk) => {
  let total = 0
  let idle = null
  const stall = () => res.body.destroy?.(new UpdateError('network', 'The download stalled'))
  const onAbort = () => res.body.destroy?.(new UpdateError('aborted', 'Cancelled'))

  if (res.length !== null && res.length > maxBytes) {
    res.close()
    throw new UpdateError('verify', 'The file is larger than expected')
  }
  signal?.addEventListener('abort', onAbort, { once: true })
  try {
    idle = setTimeout(stall, IDLE_TIMEOUT_MS)
    for await (const chunk of res.body) {
      clearTimeout(idle)
      idle = setTimeout(stall, IDLE_TIMEOUT_MS)
      total += chunk.length
      if (total > maxBytes) {
        res.close()
        throw new UpdateError('verify', 'The file is larger than expected')
      }
      await onChunk(chunk, total)
    }
  } catch (error) {
    throw signal?.aborted ? new UpdateError('aborted', 'Cancelled') : error
  } finally {
    clearTimeout(idle)
    signal?.removeEventListener('abort', onAbort)
  }
  if (signal?.aborted) {
    throw new UpdateError('aborted', 'Cancelled')
  }

  return total
}

const fetchBuffer = async (get, url, { allowStart, allowHop, headers, signal, maxBytes = 1_000_000 }) => {
  if (!allowStart(url)) {
    throw new UpdateError('bad-url', 'Unexpected download address')
  }
  const res = await follow(get, url, { allowHop, headers, signal })
  const parts = []

  await eachChunk(res, { maxBytes, signal }, chunk => {
    parts.push(chunk)
  })

  return Buffer.concat(parts)
}

const downloadTo = async (get, url, file, { allowStart, allowHop, headers, signal, maxBytes, onProgress }) => {
  if (!allowStart(url)) {
    throw new UpdateError('bad-url', 'Unexpected download address')
  }
  const res = await follow(get, url, { allowHop, headers, signal })
  const out = fs.createWriteStream(file, { flags: 'wx', mode: 0o600 })
  const failed = new Promise((_, reject) => out.once('error', reject))

  failed.catch(() => {})
  try {
    await eachChunk(res, { maxBytes, signal }, async (chunk, total) => {
      if (!out.write(chunk)) {
        await Promise.race([new Promise(resolve => out.once('drain', resolve)), failed])
      }
      onProgress?.(total)
    })
    await Promise.race([new Promise(resolve => out.end(resolve)), failed])
  } catch (error) {
    out.destroy()
    throw error
  }
}

// ---------- the updater ----------

// state: { status, current, latest, notesUrl, progress, error }
//   status: idle | checking | up-to-date | available | downloading | installing
//   error:  null | { during: 'check' | 'update', code, message }
const createUpdater = ({
  version,
  platform,
  arch,
  get,
  endpoints = updateEndpoints({}),
  tempRoot,
  exePath = '',
  pid = process.pid,
  isPackaged = true,
  run, // (cmd, args) -> Promise<stdout>
  spawnDetached, // (cmd, args) -> void
  quit,
  openExternal = async () => {},
  isWritable = async dir => fs.promises.access(dir, fs.constants.W_OK).then(() => true, () => false),
  relaunch = { open: [], args: [] },
  userAgent = `claude-skin-switcher/${version}`,
  onState = () => {},
}) => {
  let state = { status: 'idle', current: version, latest: null, notesUrl: null, progress: null, error: null }
  let release = null
  let controller = null
  let checking = null

  const emit = patch => {
    state = { ...state, ...patch }
    onState(state)

    return state
  }
  const local = endpoints.local
  const allowStart = url => downloadAllowed(url, local)
  const allowHop = url => hopAllowed(url, local)
  const headers = { 'User-Agent': userAgent }
  const readPlist = async (app, key) => String(await run('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', path.join(app, 'Contents', 'Info.plist')])).trim()

  const doCheck = async manual => {
    emit({ status: 'checking', error: null })
    try {
      const body = await fetchBuffer(get, endpoints.apiUrl, {
        allowStart: url => url === endpoints.apiUrl,
        allowHop: url => apiHopAllowed(url, local),
        headers: { ...headers, Accept: 'application/vnd.github+json' },
        maxBytes: 2_000_000,
      })
      let json

      try {
        json = JSON.parse(body.toString('utf8'))
      } catch {
        throw new UpdateError('network', 'GitHub sent an unreadable answer')
      }
      const info = releaseInfo(json)

      if (info === null || !isNewer(info.version, version)) {
        release = null

        return emit({ status: 'up-to-date', latest: null, notesUrl: null })
      }
      release = info

      return emit({ status: 'available', latest: info.version, notesUrl: info.notesUrl })
    } catch (error) {
      // Background checks fail quietly; a click shows why.
      return emit({ status: release ? 'available' : 'idle', error: manual ? { during: 'check', code: error.code ?? 'network', message: message(error) } : null })
    }
  }

  const fail = (code, text, extra = {}) => emit({ status: release ? 'available' : 'idle', progress: null, error: { during: 'update', code, message: text, ...extra } })

  const installMac = async (zip, work, bundle) => {
    const out = path.join(work, 'extracted')

    await fs.promises.mkdir(out)
    await run('/usr/bin/ditto', ['-x', '-k', zip, out])
    const apps = (await fs.promises.readdir(out, { withFileTypes: true })).filter(d => d.name.endsWith('.app'))

    if (apps.length !== 1 || !apps[0].isDirectory()) {
      throw new UpdateError('install', 'The update archive has an unexpected layout')
    }
    const newApp = path.join(out, apps[0].name)
    const [mine, theirs, newVersion] = await Promise.all([readPlist(bundle, 'CFBundleIdentifier'), readPlist(newApp, 'CFBundleIdentifier'), readPlist(newApp, 'CFBundleShortVersionString')])

    if (mine === '' || theirs !== mine) {
      throw new UpdateError('install', 'The download is a different app')
    }
    if (newVersion !== release.version) {
      throw new UpdateError('install', `The download is version ${newVersion}, not ${release.version}`)
    }
    const backup = path.join(path.dirname(bundle), `.${path.basename(bundle, '.app')}-old-${crypto.randomBytes(4).toString('hex')}.app`)
    const script = macInstallScript({ pid, oldApp: bundle, newApp, workDir: work, backup, open: relaunch.open ?? [], args: relaunch.args ?? [] })
    const scriptFile = path.join(work, 'install.sh')

    await fs.promises.writeFile(scriptFile, script, { mode: 0o700 })
    spawnDetached('/bin/sh', [scriptFile])
  }

  const doUpdate = async () => {
    const target = pickAssets(release, platform, arch)

    if (target === null) {
      return fail('no-asset', 'This release has no download for this computer')
    }
    let bundle = null

    if (platform === 'darwin') {
      bundle = isPackaged ? bundlePathFromExe(exePath) : null
      const blocker = installBlocker(bundle, { writable: bundle !== null && (await isWritable(path.dirname(bundle))) })

      if (blocker !== null) {
        // Can't swap the bundle here: send the person to the release page.
        if (externalAllowed(state.notesUrl ?? RELEASES_LATEST) && local === null) {
          openExternal(state.notesUrl ?? RELEASES_LATEST)
        }

        return fail('move', blocker, { reason: blocker })
      }
    } else if (!isPackaged) {
      return fail('not-packaged', 'Updates only work in the installed app')
    }
    const ctl = new AbortController()
    const signal = ctl.signal
    const work = path.join(tempRoot, `${release.version}-${crypto.randomBytes(4).toString('hex')}`)
    let handedOver = false

    controller = ctl
    emit({ status: 'downloading', progress: 0, error: null })
    try {
      await fs.promises.mkdir(work, { recursive: true })
      const yml = parseUpdateYml((await fetchBuffer(get, target.yml.url, { allowStart, allowHop, headers, signal, maxBytes: 100_000 })).toString('utf8'))

      if (yml === null || yml.version !== release.version) {
        throw new UpdateError('verify', `${target.yml.name} doesn't match the release`)
      }
      const expected = ymlEntry(yml, target.file.name)

      if (expected === null || (target.file.size !== null && target.file.size !== expected.size) || expected.size > MAX_ASSET_BYTES) {
        throw new UpdateError('verify', `${target.yml.name} doesn't list ${target.file.name}`)
      }
      const file = path.join(work, target.file.name)
      let shown = 0

      await downloadTo(get, target.file.url, file, {
        allowStart,
        allowHop,
        headers,
        signal,
        maxBytes: expected.size,
        onProgress: n => {
          const p = Math.floor((n / expected.size) * 100) / 100

          if (p !== shown) {
            shown = p
            emit({ progress: p })
          }
        },
      })
      const verdict = await verifyFile(file, expected)

      if (!verdict.ok) {
        throw new UpdateError('verify', `The download failed the ${verdict.reason} check`)
      }
      if (signal.aborted) {
        throw new UpdateError('aborted', 'Cancelled')
      }
      emit({ status: 'installing', progress: 1 })
      if (platform === 'darwin') {
        await installMac(file, work, bundle)
      } else {
        // electron-builder NSIS: /S silent (per-user, no UAC), --force-run reopens the app.
        spawnDetached(file, ['/S', '--force-run'])
      }
      handedOver = true
      quit()

      return state
    } catch (error) {
      if (error?.code === 'aborted' || signal.aborted) {
        return emit({ status: 'available', progress: null, error: null })
      }

      return fail(error?.code ?? 'install', message(error))
    } finally {
      controller = null
      if (!handedOver) {
        await fs.promises.rm(work, { recursive: true, force: true }).catch(() => {})
      }
    }
  }

  return {
    state: () => state,
    // One check at a time; a click while a background check runs waits for it.
    check: async ({ manual = false } = {}) => {
      if (state.status === 'downloading' || state.status === 'installing') {
        return state
      }
      if (checking === null) {
        checking = doCheck(manual).finally(() => {
          checking = null
        })
      }

      return checking
    },
    update: async () => {
      if (state.status !== 'available' || release === null || controller !== null) {
        return state
      }

      return doUpdate()
    },
    cancel: () => {
      controller?.abort()

      return state
    },
    openNotes: () => {
      const url = state.notesUrl ?? RELEASES_LATEST

      if (externalAllowed(url)) {
        openExternal(url)
      }
    },
    // Leftovers of an earlier run (a Windows installer, a failed swap).
    cleanup: () => fs.promises.rm(tempRoot, { recursive: true, force: true }).catch(() => {}),
  }
}

module.exports = {
  API_URL,
  DOWNLOAD_PREFIX,
  RELEASES_LATEST,
  CHECK_DELAY_MS,
  CHECK_EVERY_MS,
  UpdateError,
  updateEndpoints,
  downloadAllowed,
  hopAllowed,
  apiHopAllowed,
  externalAllowed,
  parseVersion,
  compareVersions,
  isNewer,
  releaseInfo,
  assetNames,
  pickAssets,
  parseUpdateYml,
  ymlEntry,
  hashFile,
  verifyFile,
  bundlePathFromExe,
  installBlocker,
  shQuote,
  macInstallScript,
  nodeGet,
  netGet,
  follow,
  fetchBuffer,
  downloadTo,
  createUpdater,
}
