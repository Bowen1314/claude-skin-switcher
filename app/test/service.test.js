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

const setup = async (t, { routes = {}, clientId = 'Iv1.test' } = {}) => {
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
    config: { githubUrl: mock.url, clientId, localOwner: 'local', sleep: async () => {}, now: Date.now },
    debounceMs: 30,
  })

  await service.start()

  return { service, dir, mock, tokens, sel: () => JSON.parse(fs.readFileSync(path.join(dir, 'selection.json'), 'utf8')) }
}

test('start copies the official skins; select and tuning write selection.json', async t => {
  const { service, dir, sel } = await setup(t)

  assert.deepEqual(service.entries().map(e => e.ref), ['official.firefly-meadow', 'official.graphite-circuit'])
  assert.equal(fs.existsSync(path.join(dir, 'selection.json')), false, 'nothing is written before the first choice')
  await assert.rejects(service.select('nobody.here'), /Not a usable skin/)

  // Tuning before Apply leaves `theme` out, so Claude's look does not change.
  const live = service.setSettings('official.graphite-circuit', { dim: 0.3, blur: 999, vars: { nope: 1 } })

  assert.equal(live.dim, 0.3)
  assert.equal(live.blur, 64)
  await sleep(80)
  assert.deepEqual(sel(), { settings: { 'official.graphite-circuit': { dim: 0.3, blur: 64 } } })

  // Several quick changes collapse into one write; Apply flushes first.
  service.setSettings('official.graphite-circuit', { dim: 0.1 })
  service.setSettings('official.graphite-circuit', { dim: 0.2, motion: false })
  await service.select('official.graphite-circuit')
  assert.deepEqual(sel(), { theme: 'official.graphite-circuit', settings: { 'official.graphite-circuit': { dim: 0.2, motion: false } } })

  const reset = await service.resetSettings('official.graphite-circuit')

  assert.equal(reset.dim, 0)
  assert.deepEqual(sel(), { theme: 'official.graphite-circuit' })
  await service.select('default')
  assert.equal(sel().theme, 'default')

  // shutdown writes what is still waiting.
  service.setSettings('official.firefly-meadow', { panelOpacity: 0.5 })
  await service.shutdown()
  assert.equal(sel().settings['official.firefly-meadow'].panelOpacity, 0.5)
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
  const { service, mock } = await setup(t, {
    routes: {
      'GET /api/skins/alice/tiny': () => ({ json: { ...tinySkin(), author: 'alice', version } }),
      'GET /api/skins/alice/tiny/scene.svg': () => ({ text: TINY_SCENE }),
      'POST /api/skins/alice/tiny/download': () => ({ json: { ok: true } }),
    },
  })

  assert.equal((await service.galleryDetail('alice', 'tiny')).savedVersion, null)
  const r = await service.gallerySave('alice', 'tiny')

  assert.equal(r.ok, true)
  const e = service.entries().find(x => x.ref === 'alice.tiny')

  assert.deepEqual(e.meta, { author: 'alice', version: 2, source: 'gallery' })
  version = 3
  const detail = await service.galleryDetail('alice', 'tiny')

  assert.equal(detail.savedVersion, 2)
  assert.equal(detail.version, 3)
  await sleep(30)
  assert.ok(mock.calls.some(c => c.method === 'POST' && c.path === '/api/skins/alice/tiny/download'))
})

test('sign in, check, upload, list and delete, all against the mock', async t => {
  const answers = [{ error: 'authorization_pending' }, { access_token: 'gho_fake' }]
  const uploads = []
  const { service, tokens } = await setup(t, {
    routes: {
      'POST /login/device/code': () => ({ json: { device_code: 'dc', user_code: 'WXYZ-0001', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 5 } }),
      'POST /login/oauth/access_token': () => ({ json: answers.shift() }),
      'GET /api/me': req => (req.headers.authorization === 'Bearer gho_fake' ? { json: { login: 'Alice', skins: [] } } : { status: 401, json: { error: 'no' } }),
      'POST /api/skins': (_req, body) => {
        uploads.push(JSON.parse(body))

        return { status: 201, json: { ref: 'alice.tiny', version: 1 } }
      },
      'DELETE /api/skins/alice/tiny': () => ({ json: { ok: true } }),
    },
  })

  assert.deepEqual(await service.authState(), { configured: true, signedIn: false, login: null })
  await assert.rejects(service.upload(), /Nothing checked/)
  const code = await service.authStart()

  assert.equal(code.userCode, 'WXYZ-0001')
  assert.deepEqual(await service.authWait(), { configured: true, signedIn: true, login: 'alice', persisted: true })
  assert.equal(await tokens.load(), 'gho_fake')

  const folder = tempDir(t)

  fs.writeFileSync(path.join(folder, 'skin.json'), JSON.stringify(tinySkin()))
  assert.equal((await service.checkFolder(folder)).ok, false, 'scene missing')
  fs.writeFileSync(path.join(folder, 'scene.svg'), TINY_SCENE)
  assert.equal((await service.checkFolder(folder)).ok, true)
  const up = await service.upload()

  assert.equal(up.ref, 'alice.tiny')
  assert.equal(uploads[0].scene, TINY_SCENE)
  assert.deepEqual(service.entries().find(e => e.ref === 'alice.tiny').meta, { author: 'alice', version: 1, source: 'upload' })
  assert.equal((await service.checkLibrary('official.graphite-circuit')).ok, true)
  assert.deepEqual(await service.removeMine('tiny'), { ok: true })
  await service.signOut()
  assert.equal(await tokens.load(), null)
  await assert.rejects(service.mine(), /Not signed in/)
})

test('an empty client id: uploads report not configured and never reach GitHub or the token store', async t => {
  const { service, mock, tokens } = await setup(t, { clientId: '' })
  let loaded = false

  tokens.load = async () => {
    loaded = true

    return 'gho_should_not_be_read'
  }
  assert.deepEqual(await service.authState(), { configured: false, signedIn: false, login: null })
  assert.deepEqual(await service.authStart(), { error: 'not-configured' })
  await assert.rejects(service.mine(), /Not signed in/)
  assert.equal(mock.calls.length, 0)
  assert.equal(loaded, false)
})

test('cancelling a sign-in stops the polling', async t => {
  const { service } = await setup(t, {
    routes: {
      'POST /login/device/code': () => ({ json: { device_code: 'dc', user_code: 'WXYZ-0001', expires_in: 900, interval: 5 } }),
      'POST /login/oauth/access_token': () => ({ json: { error: 'authorization_pending' } }),
    },
  })

  await service.authStart()
  const waiting = service.authWait()

  service.authCancel()
  assert.deepEqual(await waiting, { error: 'cancelled' })
})
