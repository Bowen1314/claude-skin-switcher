'use strict'

const assert = require('node:assert/strict')
const { execFileSync, spawnSync } = require('node:child_process')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const { tempDir } = require('./helpers')
const { startMock } = require('./mock-server')
const u = require('../src/updater')

const sha512 = buf => crypto.createHash('sha512').update(buf).digest('base64')
const DL = 'https://github.com/Bowen1314/claude-skin-switcher/releases/download/v0.2.3/'

const ymlFor = (version, files) =>
  [
    `version: ${version}`,
    'files:',
    ...files.flatMap(f => [`  - url: ${f.name}`, `    sha512: ${sha512(f.data)}`, `    size: ${f.data.length}`, '    blockMapSize: 123']),
    `path: ${files[0].name}`,
    `sha512: ${sha512(files[0].data)}`,
    "releaseDate: '2026-11-24T17:21:29.210Z'",
    '',
  ].join('\n')

test('versions compare as x.y.z, with or without a v', () => {
  assert.deepEqual(u.parseVersion('v0.2.3'), [0, 2, 3])
  assert.deepEqual(u.parseVersion('0.10.0'), [0, 10, 0])
  for (const bad of ['0.2', '0.2.3-beta.1', 'v1.2.3.4', '', null, 'latest', ' v1.2.x']) {
    assert.equal(u.parseVersion(bad), null, String(bad))
  }
  assert.equal(u.compareVersions('0.2.10', '0.2.9'), 1)
  assert.equal(u.compareVersions('0.10.0', '0.9.9'), 1)
  assert.equal(u.compareVersions('v1.0.0', '1.0.0'), 0)
  assert.equal(u.compareVersions('0.2.1', '0.2.2'), -1)
  assert.equal(u.compareVersions('1.0.0-rc1', '0.2.2'), null)
  assert.equal(u.isNewer('v0.2.3', '0.2.2'), true)
  assert.equal(u.isNewer('v0.2.2', '0.2.2'), false)
  assert.equal(u.isNewer('v0.2.1', '0.2.2'), false)
  assert.equal(u.isNewer('nightly', '0.2.2'), false)
})

test('drafts, prereleases and odd tags are not updates', () => {
  const base = { tag_name: 'v0.2.3', html_url: 'https://github.com/Bowen1314/claude-skin-switcher/releases/tag/v0.2.3', assets: [] }

  assert.equal(u.releaseInfo({ ...base, draft: true }), null)
  assert.equal(u.releaseInfo({ ...base, prerelease: true }), null)
  assert.equal(u.releaseInfo({ ...base, tag_name: 'v0.2.3-beta' }), null)
  assert.equal(u.releaseInfo(null), null)
  assert.equal(u.releaseInfo({ ...base }).version, '0.2.3')
  assert.equal(u.releaseInfo(base).notesUrl, base.html_url)
  // Release notes only ever point into this repo's releases.
  assert.equal(u.releaseInfo({ ...base, html_url: 'https://evil.example/x' }).notesUrl, u.RELEASES_LATEST)
  assert.equal(u.releaseInfo({ ...base, html_url: 'https://github.com/someone/else/releases/tag/v9' }).notesUrl, u.RELEASES_LATEST)
})

test('the asset is picked by platform and arch, by exact name', () => {
  const names = ['claude-skin-switcher-0.2.3-mac-arm64.zip', 'claude-skin-switcher-0.2.3-mac-x64.zip', 'claude-skin-switcher-0.2.3-mac-arm64.dmg', 'claude-skin-switcher-0.2.3-win-x64.exe', 'latest-mac.yml', 'latest.yml']
  const release = u.releaseInfo({ tag_name: 'v0.2.3', assets: names.map(name => ({ name, browser_download_url: DL + name, size: 10 })) })

  assert.equal(u.pickAssets(release, 'darwin', 'arm64').file.name, 'claude-skin-switcher-0.2.3-mac-arm64.zip')
  assert.equal(u.pickAssets(release, 'darwin', 'arm64').yml.name, 'latest-mac.yml')
  assert.equal(u.pickAssets(release, 'darwin', 'x64').file.name, 'claude-skin-switcher-0.2.3-mac-x64.zip')
  assert.equal(u.pickAssets(release, 'win32', 'x64').file.name, 'claude-skin-switcher-0.2.3-win-x64.exe')
  assert.equal(u.pickAssets(release, 'win32', 'x64').yml.name, 'latest.yml')
  assert.equal(u.pickAssets(release, 'darwin', 'ia32'), null)
  assert.equal(u.pickAssets(release, 'linux', 'x64'), null)
  // No manifest in the release: no update.
  const noYml = u.releaseInfo({ tag_name: 'v0.2.3', assets: names.filter(n => !n.endsWith('.yml')).map(name => ({ name, browser_download_url: DL + name })) })

  assert.equal(u.pickAssets(noYml, 'darwin', 'arm64'), null)
  // An asset from another version's name is never taken.
  const stale = u.releaseInfo({ tag_name: 'v0.2.3', assets: [{ name: 'claude-skin-switcher-0.2.2-mac-arm64.zip', browser_download_url: DL }, { name: 'latest-mac.yml', browser_download_url: DL }] })

  assert.equal(u.pickAssets(stale, 'darwin', 'arm64'), null)
})

test('download addresses: this repo on github.com, GitHub hosts for redirects, localhost only in test mode', () => {
  assert.equal(u.downloadAllowed(`${DL}claude-skin-switcher-0.2.3-mac-arm64.zip`), true)
  for (const bad of [
    'https://github.com/Bowen1314/other/releases/download/v1/x.zip',
    'http://github.com/Bowen1314/claude-skin-switcher/releases/download/v0.2.3/x.zip',
    'https://github.com.evil.example/Bowen1314/claude-skin-switcher/releases/download/v0.2.3/x.zip',
    'https://user:pw@github.com/Bowen1314/claude-skin-switcher/releases/download/v0.2.3/x.zip',
    'https://github.com/Bowen1314/claude-skin-switcher/releases/download/../../../evil/x.zip',
    'http://127.0.0.1:8080/x.zip',
    'not a url',
  ]) {
    assert.equal(u.downloadAllowed(bad), false, bad)
  }
  assert.equal(u.hopAllowed('https://release-assets.githubusercontent.com/github-production-release-asset/1?x=y'), true)
  assert.equal(u.hopAllowed('https://objects.githubusercontent.com/a'), true)
  assert.equal(u.hopAllowed('http://release-assets.githubusercontent.com/a'), false)
  assert.equal(u.hopAllowed('https://release-assets.githubusercontent.com:444/a'), false)
  assert.equal(u.hopAllowed('https://evil.githubusercontent.com.example/a'), false)
  assert.equal(u.hopAllowed('https://example.com/a'), false)
  assert.equal(u.apiHopAllowed('https://api.github.com/repositories/1/releases/latest'), true)
  assert.equal(u.apiHopAllowed('https://github.com/x'), false)
  assert.equal(u.externalAllowed('https://github.com/Bowen1314/claude-skin-switcher/releases/tag/v0.2.3'), true)
  assert.equal(u.externalAllowed('https://gist.github.com/x'), false)
  assert.equal(u.externalAllowed('http://github.com/x'), false)
  // Local mock origin, only when given (TS_UPDATE_URL).
  const local = 'http://127.0.0.1:8080'

  assert.equal(u.downloadAllowed('http://127.0.0.1:8080/dl/x.zip', local), true)
  assert.equal(u.downloadAllowed('http://127.0.0.1:8081/dl/x.zip', local), false)
  assert.equal(u.hopAllowed('http://127.0.0.1:8080/blob', local), true)
  assert.equal(u.hopAllowed('http://127.0.0.1:8080/blob'), false)
})

test('TS_UPDATE_URL is honoured for localhost only; autoclick only with it', () => {
  assert.deepEqual(u.updateEndpoints({}), { local: null, apiUrl: u.API_URL, autoclick: false })
  assert.equal(u.API_URL, 'https://api.github.com/repos/Bowen1314/claude-skin-switcher/releases/latest')
  assert.deepEqual(u.updateEndpoints({ TS_UPDATE_URL: 'http://127.0.0.1:4567', TS_UPDATE_AUTOCLICK: '1' }), {
    local: 'http://127.0.0.1:4567',
    apiUrl: 'http://127.0.0.1:4567/repos/Bowen1314/claude-skin-switcher/releases/latest',
    autoclick: true,
  })
  assert.equal(u.updateEndpoints({ TS_UPDATE_URL: 'http://localhost:9' }).local, 'http://localhost:9')
  for (const bad of ['https://evil.example', 'http://127.0.0.1.evil.example:80', 'http://10.0.0.1:80', 'http://127.0.0.1:80/path']) {
    assert.equal(u.updateEndpoints({ TS_UPDATE_URL: bad, TS_UPDATE_AUTOCLICK: '1' }).local, null, bad)
    assert.equal(u.updateEndpoints({ TS_UPDATE_URL: bad, TS_UPDATE_AUTOCLICK: '1' }).autoclick, false, bad)
  }
  assert.equal(u.updateEndpoints({ TS_UPDATE_AUTOCLICK: '1' }).autoclick, false)
})

test('latest*.yml is parsed and a file is checked against it (size and sha512)', async t => {
  const dir = tempDir(t)
  const data = crypto.randomBytes(5000)
  const other = crypto.randomBytes(10)
  const text = ymlFor('0.2.3', [
    { name: 'claude-skin-switcher-0.2.3-mac-x64.zip', data: other },
    { name: 'claude-skin-switcher-0.2.3-mac-arm64.zip', data },
  ])
  const yml = u.parseUpdateYml(text)

  assert.equal(yml.version, '0.2.3')
  assert.equal(yml.files.length, 2)
  const entry = u.ymlEntry(yml, 'claude-skin-switcher-0.2.3-mac-arm64.zip')

  assert.deepEqual(entry, { url: 'claude-skin-switcher-0.2.3-mac-arm64.zip', sha512: sha512(data), size: 5000 })
  assert.equal(u.ymlEntry(yml, 'claude-skin-switcher-0.2.3-win-x64.exe'), null)
  assert.equal(u.parseUpdateYml(text.replace(/\n/g, '\r\n')).files.length, 2)
  assert.equal(u.parseUpdateYml('files:\n  - url: a\n'), null, 'no version')
  assert.equal(u.parseUpdateYml(text.replace(sha512(data), 'short==')).files.length, 1, 'a bad hash drops the entry')

  const file = path.join(dir, 'a.zip')

  fs.writeFileSync(file, data)
  assert.deepEqual(await u.verifyFile(file, entry), { ok: true })
  // Tampered: same size, one byte changed.
  const bad = Buffer.from(data)

  bad[100] ^= 0xff
  fs.writeFileSync(file, bad)
  assert.deepEqual(await u.verifyFile(file, entry), { ok: false, reason: 'sha512' })
  fs.writeFileSync(file, Buffer.concat([data, Buffer.from('x')]))
  assert.deepEqual(await u.verifyFile(file, entry), { ok: false, reason: 'size' })
  assert.deepEqual(await u.verifyFile(path.join(dir, 'missing.zip'), entry), { ok: false, reason: 'missing' })
})

test('the running bundle comes from the executable path; DMG, translocated and read-only places are refused', () => {
  assert.equal(u.bundlePathFromExe('/Applications/Claude Skin Switcher.app/Contents/MacOS/Claude Skin Switcher'), '/Applications/Claude Skin Switcher.app')
  assert.equal(u.bundlePathFromExe('C:\\Program Files\\x.exe'), null)
  assert.equal(u.bundlePathFromExe('/usr/local/bin/node'), null)
  assert.equal(u.installBlocker('/Applications/Claude Skin Switcher.app', { writable: true }), null)
  assert.equal(u.installBlocker('/Users/a/Apps/Claude Skin Switcher.app', { writable: true }), null)
  assert.equal(u.installBlocker('/Volumes/Claude Skin Switcher 0.2.2/Claude Skin Switcher.app', { writable: true }), 'dmg')
  assert.equal(u.installBlocker('/private/var/folders/x/T/AppTranslocation/ABC/d/Claude Skin Switcher.app', { writable: true }), 'translocated')
  assert.equal(u.installBlocker('/Applications/Claude Skin Switcher.app', { writable: false }), 'read-only')
  assert.equal(u.installBlocker(null, { writable: true }), 'not-bundle')
})

const scriptArgs = (root, extra = {}) => ({
  pid: 4242,
  oldApp: path.posix.join(root, "Apps It's here", 'Claude Skin Switcher.app'),
  newApp: path.posix.join(root, 'updates', 'x', 'extracted', 'Claude Skin Switcher.app'),
  workDir: path.posix.join(root, 'updates', 'x'),
  backup: path.posix.join(root, "Apps It's here", '.Claude Skin Switcher-old-1.app'),
  ...extra,
})

test('the macOS install script quotes every path and refuses DMG / translocated bundles', () => {
  const script = u.macInstallScript(scriptArgs('/Users/a b'))

  assert.match(script, /^#!\/bin\/sh\n/)
  assert.match(script, /^PID=4242$/m)
  assert.ok(script.includes(`OLD='/Users/a b/Apps It'\\''s here/Claude Skin Switcher.app'`), script)
  assert.ok(script.includes(`NEW='/Users/a b/updates/x/extracted/Claude Skin Switcher.app'`))
  assert.ok(script.includes(`WORK='/Users/a b/updates/x'`))
  assert.match(script, /^'\/usr\/bin\/open' "\$OLD"$/m)
  // Variables are always used quoted.
  for (const v of ['OLD', 'NEW', 'BACKUP', 'WORK']) {
    assert.doesNotMatch(script, new RegExp(`[^"]\\$${v}`), v)
  }
  assert.equal(u.shQuote("a'b"), `'a'\\''b'`)
  const relaunch = u.macInstallScript(scriptArgs('/u', { open: ['-n', '--env', 'HOME=/tmp/h h'], args: ['--user-data-dir=/tmp/u d'] }))

  assert.match(relaunch, /^'\/usr\/bin\/open' '-n' '--env' 'HOME=\/tmp\/h h' "\$OLD" --args '--user-data-dir=\/tmp\/u d'$/m)
  assert.throws(() => u.macInstallScript(scriptArgs('/u', { oldApp: '/Volumes/Claude Skin Switcher/Claude Skin Switcher.app', backup: '/Volumes/Claude Skin Switcher/.old.app' })), /Refusing/)
  assert.throws(() => u.macInstallScript(scriptArgs('/u', { oldApp: '/private/var/folders/T/AppTranslocation/X/d/Claude Skin Switcher.app', backup: '/private/var/folders/T/AppTranslocation/X/d/.old.app' })), /Refusing/)
  assert.throws(() => u.macInstallScript(scriptArgs('/u', { pid: 0 })), /pid/)
  assert.throws(() => u.macInstallScript(scriptArgs('/u', { newApp: 'relative/X.app' })), /absolute/)
  assert.throws(() => u.macInstallScript(scriptArgs('/u', { backup: '/elsewhere/.old.app' })), /next to the app/)
})

// A finished process: its PID is free (kill -0 fails), like the app after it quit.
const deadPid = () => spawnSync(process.execPath, ['-e', '0']).pid

const fakeBundle = (dir, version) => {
  fs.mkdirSync(path.join(dir, 'Contents', 'MacOS'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'Contents', 'MacOS', 'Claude Skin Switcher'), `v${version}`)
  fs.writeFileSync(
    path.join(dir, 'Contents', 'Info.plist'),
    `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.sosotech.claude-skin-switcher</string><key>CFBundleShortVersionString</key><string>${version}</string></dict></plist>\n`,
  )
}

test('the macOS install script swaps the bundle and opens the new one', { skip: process.platform !== 'darwin' }, t => {
  const root = tempDir(t)
  const a = scriptArgs(root, { pid: deadPid() })
  const opened = path.join(root, 'opened.txt')

  fakeBundle(a.oldApp, '0.2.2')
  fakeBundle(a.newApp, '0.2.3')
  const stub = path.join(root, 'open-stub')

  fs.writeFileSync(stub, `#!/bin/sh\nprintf '%s\\n' "$@" > '${opened}'\n`, { mode: 0o755 })
  const scriptFile = path.join(a.workDir, 'install.sh')

  fs.writeFileSync(scriptFile, u.macInstallScript({ ...a, openCmd: stub }))
  execFileSync('/bin/sh', [scriptFile])
  assert.equal(fs.readFileSync(path.join(a.oldApp, 'Contents', 'MacOS', 'Claude Skin Switcher'), 'utf8'), 'v0.2.3')
  assert.equal(fs.existsSync(a.backup), false, 'old bundle removed')
  assert.equal(fs.existsSync(a.workDir), false, 'temp folder removed')
  assert.equal(fs.readFileSync(opened, 'utf8'), `${a.oldApp}\n`)
})

test('the macOS install script puts the old bundle back when the new one is missing', { skip: process.platform !== 'darwin' }, t => {
  const root = tempDir(t)
  const a = scriptArgs(root, { pid: deadPid() })

  fakeBundle(a.oldApp, '0.2.2')
  fs.mkdirSync(a.workDir, { recursive: true })
  const scriptFile = path.join(a.workDir, 'install.sh')

  fs.writeFileSync(scriptFile, u.macInstallScript({ ...a, openCmd: '/usr/bin/true' }))
  execFileSync('/bin/sh', [scriptFile], { stdio: 'ignore' })
  assert.equal(fs.readFileSync(path.join(a.oldApp, 'Contents', 'MacOS', 'Claude Skin Switcher'), 'utf8'), 'v0.2.2')
  assert.equal(fs.existsSync(a.backup), false)
})

// ---------- the whole flow against a local mock ----------

const releaseServer = async (t, { version = '0.2.3', data, tamper = false, redirectTo = null, assetNames } = {}) => {
  const exe = `claude-skin-switcher-${version}-win-x64.exe`
  const zip = `claude-skin-switcher-${version}-mac-arm64.zip`
  const served = tamper ? Buffer.concat([data.subarray(0, -1), Buffer.from([data.at(-1) ^ 1])]) : data
  let base = ''
  const routes = {
    'GET /repos/Bowen1314/claude-skin-switcher/releases/latest': () => ({
      json: {
        tag_name: `v${version}`,
        draft: false,
        prerelease: false,
        html_url: `https://github.com/Bowen1314/claude-skin-switcher/releases/tag/v${version}`,
        assets: (assetNames ?? [exe, zip, 'latest.yml', 'latest-mac.yml']).map(name => ({ name, size: name.endsWith('.yml') ? 100 : data.length, browser_download_url: `${base}/dl/${name}` })),
      },
    }),
    'GET /dl/latest.yml': () => ({ text: ymlFor(version, [{ name: exe, data }]) }),
    'GET /dl/latest-mac.yml': () => ({ text: ymlFor(version, [{ name: zip, data }]) }),
    // GitHub answers asset downloads with a redirect to its asset host.
    [`GET /dl/${exe}`]: () => ({ status: 302, headers: { Location: redirectTo ?? '/blob/exe' } }),
    [`GET /dl/${zip}`]: () => ({ status: 302, headers: { Location: redirectTo ?? '/blob/zip' } }),
    'GET /blob/exe': () => ({ text: served, headers: { 'Content-Length': String(served.length) } }),
    'GET /blob/zip': () => ({ text: served, headers: { 'Content-Length': String(served.length) } }),
  }
  const mock = await startMock(t, routes)

  base = mock.url

  return mock
}

const winUpdater = (t, mock, extra = {}) => {
  const root = tempDir(t)
  const events = { spawned: [], quit: 0, states: [] }
  const updater = u.createUpdater({
    version: '0.2.2',
    platform: 'win32',
    arch: 'x64',
    get: u.nodeGet,
    endpoints: u.updateEndpoints({ TS_UPDATE_URL: mock.url }),
    tempRoot: path.join(root, 'updates'),
    isPackaged: true,
    run: async () => '',
    spawnDetached: (cmd, args) => events.spawned.push({ cmd, args, exists: fs.existsSync(cmd), bytes: fs.existsSync(cmd) ? fs.readFileSync(cmd) : null }),
    quit: () => {
      events.quit++
    },
    onState: s => events.states.push(s),
    ...extra,
  })

  return { updater, events, root }
}

test('check finds a newer release; Update downloads, verifies and starts the silent installer', async t => {
  const data = crypto.randomBytes(300_000)
  const mock = await releaseServer(t, { data })
  const { updater, events, root } = winUpdater(t, mock)

  assert.equal(updater.state().status, 'idle')
  const found = await updater.check({ manual: true })

  assert.equal(found.status, 'available')
  assert.equal(found.latest, '0.2.3')
  assert.equal(found.notesUrl, 'https://github.com/Bowen1314/claude-skin-switcher/releases/tag/v0.2.3')
  assert.equal(events.spawned.length, 0, 'nothing installs before a click')
  await updater.update()
  assert.equal(events.spawned.length, 1)
  assert.deepEqual(events.spawned[0].args, ['/S', '--force-run'])
  assert.ok(events.spawned[0].cmd.startsWith(path.join(root, 'updates')))
  assert.ok(events.spawned[0].bytes.equals(data))
  assert.equal(events.quit, 1)
  assert.equal(updater.state().status, 'installing')
  const progress = events.states.filter(s => s.status === 'downloading').map(s => s.progress)

  assert.ok(progress.length >= 2 && progress.at(-1) === 1, JSON.stringify(progress))
  assert.ok(mock.calls.some(c => c.path === '/blob/exe'), 'followed the redirect')
  assert.match(mock.calls[0].headers['user-agent'], /^claude-skin-switcher\/0\.2\.2$/)
})

test('a tampered download is refused and removed', async t => {
  const data = crypto.randomBytes(50_000)
  const mock = await releaseServer(t, { data, tamper: true })
  const { updater, events, root } = winUpdater(t, mock)

  await updater.check()
  const s = await updater.update()

  assert.equal(s.status, 'available')
  assert.equal(s.error.during, 'update')
  assert.equal(s.error.code, 'verify')
  assert.equal(events.spawned.length, 0)
  assert.equal(events.quit, 0)
  assert.deepEqual(fs.readdirSync(path.join(root, 'updates')), [], 'temp folder cleaned')
})

test('a redirect off GitHub is refused', async t => {
  const data = crypto.randomBytes(1000)
  const mock = await releaseServer(t, { data, redirectTo: 'https://evil.example/payload.exe' })
  const { updater, events } = winUpdater(t, mock)

  await updater.check()
  const s = await updater.update()

  assert.equal(s.error.code, 'bad-url')
  assert.equal(events.spawned.length, 0)
})

test('no newer release, a release without this platform, and background failures', async t => {
  const data = crypto.randomBytes(1000)
  const same = await releaseServer(t, { data, version: '0.2.2' })

  assert.equal((await winUpdater(t, same).updater.check({ manual: true })).status, 'up-to-date')
  const noWin = await releaseServer(t, { data, assetNames: ['latest-mac.yml'] })
  const w = winUpdater(t, noWin).updater

  await w.check()
  assert.equal((await w.update()).error.code, 'no-asset')
  // Unreachable: quiet in the background, explained after a click.
  const down = u.createUpdater({ version: '0.2.2', platform: 'win32', arch: 'x64', get: u.nodeGet, endpoints: u.updateEndpoints({ TS_UPDATE_URL: 'http://127.0.0.1:9' }), tempRoot: tempDir(t), run: async () => '', spawnDetached: () => {}, quit: () => {} })

  assert.deepEqual((await down.check()).error, null)
  assert.equal((await down.check()).status, 'idle')
  const clicked = await down.check({ manual: true })

  assert.equal(clicked.error.during, 'check')
})

test('cancel stops the download and goes back to available', async t => {
  const data = crypto.randomBytes(1000)
  let release = null
  const mock = await startMock(t, {
    'GET /repos/Bowen1314/claude-skin-switcher/releases/latest': () => ({
      json: { tag_name: 'v0.2.3', assets: ['claude-skin-switcher-0.2.3-win-x64.exe', 'latest.yml'].map(name => ({ name, browser_download_url: `${mock.url}/dl/${name}` })) },
    }),
    'GET /dl/latest.yml': () => ({ text: ymlFor('0.2.3', [{ name: 'claude-skin-switcher-0.2.3-win-x64.exe', data }]) }),
    // Sends nothing until the test lets it.
    'GET /dl/claude-skin-switcher-0.2.3-win-x64.exe': () => new Promise(resolve => {
      release = resolve
    }),
  })
  const { updater, events, root } = winUpdater(t, mock)

  await updater.check()
  const running = updater.update()

  while (release === null) {
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.equal(updater.state().status, 'downloading')
  updater.cancel()
  const s = await running

  release({ hang: true })
  assert.equal(s.status, 'available')
  assert.equal(s.error, null)
  assert.equal(events.spawned.length, 0)
  assert.deepEqual(fs.readdirSync(path.join(root, 'updates')), [])
})

test('macOS: a DMG copy is not updated in place; the release page opens instead', async t => {
  // A get that answers like api.github.com (production endpoints, no network).
  const release = {
    tag_name: 'v0.2.3',
    html_url: 'https://github.com/Bowen1314/claude-skin-switcher/releases/tag/v0.2.3',
    assets: ['claude-skin-switcher-0.2.3-mac-arm64.zip', 'latest-mac.yml'].map(name => ({ name, browser_download_url: DL + name })),
  }
  const asked = []
  const get = async url => {
    asked.push(url)
    const body = Buffer.from(JSON.stringify(release))

    return { status: 200, location: null, length: body.length, body: [body], close: () => {} }
  }
  const opened = []
  const updater = u.createUpdater({
    version: '0.2.2',
    platform: 'darwin',
    arch: 'arm64',
    get,
    tempRoot: tempDir(t),
    exePath: '/Volumes/Claude Skin Switcher/Claude Skin Switcher.app/Contents/MacOS/Claude Skin Switcher',
    run: async () => '',
    spawnDetached: () => assert.fail('must not install'),
    quit: () => assert.fail('must not quit'),
    openExternal: url => opened.push(url),
  })

  assert.equal((await updater.check()).status, 'available')
  assert.deepEqual(asked, [u.API_URL])
  const s = await updater.update()

  assert.equal(s.error.code, 'move')
  assert.equal(s.error.reason, 'dmg')
  assert.deepEqual(asked, [u.API_URL], 'nothing downloaded')
  assert.deepEqual(opened, ['https://github.com/Bowen1314/claude-skin-switcher/releases/tag/v0.2.3'])
})

test('macOS: full flow with ditto and plutil, bundle id and version checked', { skip: process.platform !== 'darwin' }, async t => {
  const root = tempDir(t)
  // The app as built: a bundle zipped the way electron-builder ships it.
  const build = path.join(root, 'build', 'Claude Skin Switcher.app')

  fakeBundle(build, '0.2.3')
  const zipFile = path.join(root, 'build.zip')

  execFileSync('/usr/bin/ditto', ['-c', '-k', '--keepParent', build, zipFile])
  const data = fs.readFileSync(zipFile)
  const mock = await releaseServer(t, { data })
  const installed = path.join(root, 'Apps', 'Claude Skin Switcher.app')

  fakeBundle(installed, '0.2.2')
  const spawned = []
  let quit = 0
  const run = (cmd, args) => Promise.resolve(execFileSync(cmd, args).toString())
  const updater = u.createUpdater({
    version: '0.2.2',
    platform: 'darwin',
    arch: 'arm64',
    get: u.nodeGet,
    endpoints: u.updateEndpoints({ TS_UPDATE_URL: mock.url }),
    tempRoot: path.join(root, 'updates'),
    exePath: path.join(installed, 'Contents', 'MacOS', 'Claude Skin Switcher'),
    pid: deadPid(),
    run,
    spawnDetached: (cmd, args) => spawned.push([cmd, ...args]),
    quit: () => {
      quit++
    },
  })

  await updater.check()
  const s = await updater.update()

  assert.equal(s.status, 'installing', JSON.stringify(s.error))
  assert.equal(quit, 1)
  assert.equal(spawned.length, 1)
  assert.equal(spawned[0][0], '/bin/sh')
  // Run the script it wrote (with open stubbed out).
  const scriptFile = spawned[0][1]

  fs.writeFileSync(scriptFile, fs.readFileSync(scriptFile, 'utf8').replace("'/usr/bin/open'", "'/usr/bin/true'"))
  execFileSync('/bin/sh', [scriptFile])
  assert.equal(execFileSync('/usr/bin/plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', path.join(installed, 'Contents', 'Info.plist')]).toString().trim(), '0.2.3')
  assert.deepEqual(fs.readdirSync(path.join(root, 'Apps')), ['Claude Skin Switcher.app'])
  assert.deepEqual(fs.readdirSync(path.join(root, 'updates')), [])
})

test('macOS: a zip with a different bundle id or version is refused', { skip: process.platform !== 'darwin' }, async t => {
  for (const [id, version, why] of [['com.example.other', '0.2.3', /different app/], ['com.sosotech.claude-skin-switcher', '0.2.4', /version 0.2.4/]]) {
    const root = tempDir(t)
    const build = path.join(root, 'build', 'Claude Skin Switcher.app')

    fakeBundle(build, version)
    const plist = path.join(build, 'Contents', 'Info.plist')

    fs.writeFileSync(plist, fs.readFileSync(plist, 'utf8').replace('com.sosotech.claude-skin-switcher', id))
    const zipFile = path.join(root, 'build.zip')

    execFileSync('/usr/bin/ditto', ['-c', '-k', '--keepParent', build, zipFile])
    const mock = await releaseServer(t, { data: fs.readFileSync(zipFile) })
    const installed = path.join(root, 'Apps', 'Claude Skin Switcher.app')

    fakeBundle(installed, '0.2.2')
    const updater = u.createUpdater({
      version: '0.2.2',
      platform: 'darwin',
      arch: 'arm64',
      get: u.nodeGet,
      endpoints: u.updateEndpoints({ TS_UPDATE_URL: mock.url }),
      tempRoot: path.join(root, 'updates'),
      exePath: path.join(installed, 'Contents', 'MacOS', 'Claude Skin Switcher'),
      run: (cmd, args) => Promise.resolve(execFileSync(cmd, args).toString()),
      spawnDetached: () => assert.fail('must not install'),
      quit: () => assert.fail('must not quit'),
    })

    await updater.check()
    const s = await updater.update()

    assert.equal(s.error.code, 'install')
    assert.match(s.error.message, why)
    assert.deepEqual(fs.readdirSync(path.join(root, 'updates')), [])
  }
})
