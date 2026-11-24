'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const { createGallery } = require('../src/gallery')
const { createService } = require('../src/service')
const { deps } = require('./deps-helper')
const { TINY_SCENE, tinySkin } = require('./fixtures')
const { tempDir } = require('./helpers')
const { startMock } = require('./mock-server')

const BUNDLED = path.join(__dirname, '..', '..', 'plugin', 'skins')
const sleep = ms => new Promise(r => setTimeout(r, ms))

const memoryTokens = () => {
  let token = null

  return { load: async () => token, save: async t => ((token = t), { ok: true, persisted: true }), clear: async () => { token = null } }
}

// The browser, played by the test: follows the auth URL straight back to the loopback redirect.
const browser = { mode: 'approve', opened: [] }
const fakeBrowser = async url => {
  const u = new URL(url)

  browser.opened.push(u)
  if (browser.mode === 'stay') {
    return
  }
  const back = new URLSearchParams({ state: u.searchParams.get('state') })

  back.set(browser.mode === 'deny' ? 'error' : 'code', browser.mode === 'deny' ? 'access_denied' : 'auth-code-1')
  setTimeout(() => fetch(`${u.searchParams.get('redirect_uri')}/?${back}`).catch(() => {}), 10)
}
const idTok = (tag, expMs = Date.now() + 3600_000) => `h.${Buffer.from(JSON.stringify({ exp: Math.floor(expMs / 1000), sub: tag })).toString('base64url')}.s`

const setup = async (t, { routes = {}, clientId = 'cid.apps.example' } = {}) => {
  const d = await deps()
  const home = tempDir(t)
  const dir = path.join(home, '.claude-theme-switcher')
  const mock = await startMock(t, routes)
  const tokens = memoryTokens()
  const service = createService({
    dir,
    deps: d,
    bundledDir: BUNDLED,
    gallery: createGallery({ baseUrl: mock.url, deps: d }),
    tokenStore: tokens,
    config: { googleAuthUrl: `${mock.url}/o/oauth2/v2/auth`, googleTokenUrl: `${mock.url}/token`, clientId, clientSecret: 'desktop-secret', localOwner: 'local', openExternal: fakeBrowser },
  })

  await service.start()

  return { service, dir, mock, tokens, sel: () => JSON.parse(fs.readFileSync(path.join(dir, 'selection.json'), 'utf8')) }
}

test('start copies the official skins; only Apply writes selection.json, with that skin\'s draft', async t => {
  const { service, dir, sel } = await setup(t)
  const file = path.join(dir, 'selection.json')

  assert.deepEqual(service.entries().map(e => e.ref), ['official.firefly-meadow', 'official.graphite-circuit'])
  assert.equal(fs.existsSync(file), false, 'nothing is written before the first Apply')
  assert.equal(service.setSettings, undefined, 'there is no write-while-tuning path any more')
  await assert.rejects(service.select('nobody.here', {}), /Not a usable skin/)

  // Apply: theme and the draft in one write, clamped and stripped like the bridge reads them.
  const r = await service.select('official.graphite-circuit', { dim: 0.3, blur: 999, vars: { nope: 1 } })

  assert.equal(r.settings.dim, 0.3)
  assert.equal(r.settings.blur, 64)
  assert.deepEqual(r.sparse, { dim: 0.3, blur: 64 })
  assert.deepEqual(sel(), { theme: 'official.graphite-circuit', settings: { 'official.graphite-circuit': { dim: 0.3, blur: 64 } } })

  // Apply changes on the active skin replaces its settings.
  await service.select('official.graphite-circuit', { dim: 0.2, motion: false })
  assert.deepEqual(sel(), { theme: 'official.graphite-circuit', settings: { 'official.graphite-circuit': { dim: 0.2, motion: false } } })

  // Reset to defaults, then Apply changes: the entry goes away.
  await service.select('official.graphite-circuit', {})
  assert.deepEqual(sel(), { theme: 'official.graphite-circuit' })

  // Applying another skin keeps the first one's applied settings and writes only its own.
  await service.select('official.graphite-circuit', { dim: 0.1 })
  await service.select('official.firefly-meadow', { panelOpacity: 0.5 })
  assert.deepEqual(sel(), {
    theme: 'official.firefly-meadow',
    settings: { 'official.graphite-circuit': { dim: 0.1 }, 'official.firefly-meadow': { panelOpacity: 0.5 } },
  })
  await service.select('default')
  assert.equal(sel().theme, 'default')
  assert.equal(sel().settings['official.firefly-meadow'].panelOpacity, 0.5)

  // Several quick Applies stay queued and atomic: the last one wins, the file always parses.
  await Promise.all([0.1, 0.2, 0.3, 0.4].map(dim => service.select('official.graphite-circuit', { dim })))
  assert.deepEqual(sel().settings['official.graphite-circuit'], { dim: 0.4 })
  assert.deepEqual(fs.readdirSync(dir).filter(f => f.includes('.tmp')), [])
  await service.shutdown()
})

test('save as new skin bakes the knob values into a local copy', async t => {
  const { service } = await setup(t)
  const base = service.entries().find(e => e.ref === 'official.graphite-circuit')
  const key = base.skin.variables[0].key
  const value = base.skin.variables[0].type === 'color' ? '#123456' : base.skin.variables[0].min
  const r = await service.saveTuned('official.graphite-circuit', { slug: 'my-graphite', name: 'My graphite', vars: { [key]: value } })

  assert.deepEqual(r, { ok: true, ref: 'local.my-graphite', errors: [] })
  const saved = service.entries().find(e => e.ref === 'local.my-graphite')

  assert.equal(saved.ok, true, saved.errors.join(' '))
  assert.equal(saved.skin.variables[0].default, value)
  assert.equal(saved.meta.source, 'local')
  assert.equal((await service.saveTuned('official.graphite-circuit', { slug: 'my-graphite', vars: {} })).ok, false)
  // A gallery author called "local" cannot overwrite it.
  const clash = await service.gallerySave('local', 'my-graphite')

  assert.equal(clash.ok, false)
  assert.match(clash.errors[0], /made in this app/)
  assert.equal((await service.saveTuned('official.graphite-circuit', { slug: 'X', vars: {} })).ok, false)
})

test('gallery save writes the files, meta and counts a download; updates show by version', async t => {
  let version = 2
  const { service, mock, dir } = await setup(t, {
    routes: {
      'GET /api/skins/alice/tiny': () => ({ json: { ...tinySkin(), author: 'alice', version } }),
      'GET /api/skins/alice/tiny/scene.svg': () => ({ text: TINY_SCENE }),
      'POST /api/skins/alice/tiny/download': () => ({ json: { ok: true } }),
    },
  })

  const before = await service.galleryDetail('alice', 'tiny')

  assert.equal(before.savedVersion, null)
  const r = await service.gallerySave('alice', 'tiny')

  assert.equal(r.ok, true)
  const e = service.entries().find(x => x.ref === 'alice.tiny')

  // The Code tab shows exactly the files Save writes.
  assert.equal(before.code.skinJson, fs.readFileSync(path.join(dir, 'skins', 'alice.tiny', 'skin.json'), 'utf8'))
  assert.equal(before.code.sceneSvg, fs.readFileSync(path.join(dir, 'skins', 'alice.tiny', 'scene.svg'), 'utf8'))
  assert.deepEqual(before.code.check, { ok: true, errors: [] })

  assert.deepEqual(e.meta, { author: 'alice', version: 2, source: 'gallery' })
  version = 3
  const detail = await service.galleryDetail('alice', 'tiny')

  assert.equal(detail.savedVersion, 2)
  assert.equal(detail.version, 3)
  await sleep(30)
  assert.ok(mock.calls.some(c => c.method === 'POST' && c.path === '/api/skins/alice/tiny/download'))
})

test('Google sign-in, public name, upload, list and delete, all against mocks', async t => {
  browser.mode = 'approve'
  let handle = null
  let revoked = false
  const uploads = []
  const tokenCalls = []
  const authed = req => /^Bearer h\./.test(req.headers.authorization ?? '')
  const { service, tokens } = await setup(t, {
    routes: {
      'POST /token': (_req, body) => {
        const f = new URLSearchParams(body)

        tokenCalls.push(f)
        if (f.get('grant_type') === 'authorization_code') {
          return { json: { refresh_token: 'refresh-1', id_token: idTok('acct-1', Date.now() + 1000), expires_in: 1 } }
        }

        return revoked ? { status: 400, json: { error: 'invalid_grant' } } : { json: { id_token: idTok('acct-1'), expires_in: 3599 } }
      },
      'GET /api/me': req => (authed(req) ? { json: { handle, skins: [] } } : { status: 401, json: { error: 'no' } }),
      'POST /api/me/handle': (_req, body) => {
        const want = JSON.parse(body).handle

        if (want === 'taken-name') {
          return { status: 409, json: { error: 'taken' } }
        }
        handle = want

        return { json: { handle } }
      },
      'POST /api/skins': (_req, body) => {
        if (handle === null) {
          return { status: 409, json: { error: 'no handle' } }
        }
        uploads.push(JSON.parse(body))

        return { status: 201, json: { ref: `${handle}.tiny`, version: 1 } }
      },
      'DELETE /api/skins/alice-skins/tiny': () => ({ json: { ok: true } }),
    },
  })

  assert.deepEqual(await service.authState(), { configured: true, signedIn: false, handle: null })
  await assert.rejects(service.upload(), /Nothing checked/)
  assert.deepEqual(await service.authStart(), { started: true })
  const opened = browser.opened.at(-1)

  assert.equal(opened.searchParams.get('scope'), 'openid')
  const signedIn = await service.authWait()

  assert.deepEqual(signedIn, { configured: true, signedIn: true, handle: null, persisted: true })
  assert.equal(await tokens.load(), 'refresh-1', 'only the refresh token is stored')
  const exchange = tokenCalls.find(f => f.get('grant_type') === 'authorization_code')

  assert.equal(exchange.get('redirect_uri'), opened.searchParams.get('redirect_uri'))
  assert.equal(exchange.get('client_secret'), 'desktop-secret')
  assert.match(exchange.get('code_verifier'), /^[\w-]{43}$/, 'PKCE verifier sent')
  // The first id token expires in a second, so the next call refreshes it.
  assert.ok(tokenCalls.some(f => f.get('grant_type') === 'refresh_token' && f.get('refresh_token') === 'refresh-1'), 'refreshed on demand')

  // No public name yet: uploads are blocked before anything is sent.
  const folder = tempDir(t)

  fs.writeFileSync(path.join(folder, 'skin.json'), JSON.stringify(tinySkin()))
  fs.writeFileSync(path.join(folder, 'scene.svg'), TINY_SCENE)
  assert.equal((await service.checkFolder(folder)).ok, true)
  await assert.rejects(service.upload(), e => e.code === 'no-handle')
  assert.equal(uploads.length, 0)

  await assert.rejects(service.claimHandle('taken-name'), /taken/)
  assert.equal((await service.claimHandle('alice-skins')).handle, 'alice-skins')
  const up = await service.upload()

  assert.equal(up.ref, 'alice-skins.tiny')
  assert.equal(uploads[0].scene, TINY_SCENE)
  assert.deepEqual(service.entries().find(e => e.ref === 'alice-skins.tiny').meta, { author: 'alice-skins', version: 1, source: 'upload' })
  assert.deepEqual(await service.removeMine('tiny'), { ok: true })

  // Google revokes the refresh token: the next call signs out and says so.
  revoked = true
  await service.signOut()
  await tokens.save('refresh-1')
  const after = await service.authState()

  assert.equal(after.signedIn, false)
  assert.match(after.error, /signed you out/)
  assert.equal(await tokens.load(), null)
  await assert.rejects(service.mine(), /Not signed in/)
})

test('an empty client id: sign-in reports not configured and never reaches Google or the token store', async t => {
  const { service, mock, tokens } = await setup(t, { clientId: '' })
  let loaded = false

  tokens.load = async () => {
    loaded = true

    return 'refresh-should-not-be-read'
  }
  browser.opened = []
  assert.deepEqual(await service.authState(), { configured: false, signedIn: false, handle: null })
  assert.deepEqual(await service.authStart(), { error: 'not-configured' })
  await assert.rejects(service.mine(), /Not signed in/)
  assert.equal(mock.calls.length, 0)
  assert.equal(browser.opened.length, 0)
  assert.equal(loaded, false)
})

test('a denied or cancelled sign-in stores nothing', async t => {
  const { service, tokens } = await setup(t)

  browser.mode = 'deny'
  await service.authStart()
  assert.deepEqual(await service.authWait(), { error: 'access_denied' })
  browser.mode = 'stay'
  await service.authStart()
  const waiting = service.authWait()

  service.authCancel()
  assert.deepEqual(await waiting, { error: 'cancelled' })
  assert.equal(await tokens.load(), null)
  browser.mode = 'approve'
})
