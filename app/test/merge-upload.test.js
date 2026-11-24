'use strict'

// A skin made here and then uploaded is kept once, as <handle>.<slug>: on
// upload, and once per public name for libraries that already hold both.

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const { createDrafts } = require('../src/drafts')
const { createGallery } = require('../src/gallery')
const { saveSkin } = require('../src/library')
const { createSelectionStore } = require('../src/selection')
const { createService } = require('../src/service')
const { parseSkin, sparseSettings } = require('../src/skin-render')
const { deps } = require('./deps-helper')
const { TINY_SCENE, tinySkin } = require('./fixtures')
const { tempDir } = require('./helpers')
const { startMock } = require('./mock-server')

const BUNDLED = path.join(__dirname, '..', '..', 'plugin', 'skins')
const idTok = () => `h.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600, sub: 'acct' })).toString('base64url')}.s`

const setup = async (t, { token = 'refresh-1', marks } = {}) => {
  const d = await deps()
  const dir = path.join(tempDir(t), '.claude-theme-switcher')
  const versions = new Map()
  const mock = await startMock(t, {
    'POST /token': () => ({ json: { id_token: idTok(), expires_in: 3599 } }),
    'GET /api/me': () => ({ json: { handle: 'bob', skins: [] } }),
    'POST /api/skins': (_req, body) => {
      const slug = JSON.parse(body).skin.slug
      const version = (versions.get(slug) ?? 0) + 1

      versions.set(slug, version)

      return { status: 201, json: { ref: `bob.${slug}`, version } }
    },
  })
  let stored = token
  const tokenStore = { load: async () => stored, save: async v => ((stored = v), { ok: true, persisted: true }), clear: async () => { stored = null } }
  const service = createService({
    dir,
    deps: d,
    bundledDir: BUNDLED,
    gallery: createGallery({ baseUrl: mock.url, deps: d }),
    tokenStore,
    config: { googleAuthUrl: `${mock.url}/auth`, googleTokenUrl: `${mock.url}/token`, clientId: 'cid', clientSecret: '', localOwner: 'local', openExternal: async () => {}, ...(marks ? { mergeMarks: marks } : {}) },
  })

  await service.start()
  const lib = ref => path.join(service.libDir, ref)
  // A skin written straight into the library, as an older version left it.
  const put = async (owner, skin, source, version = 1) => {
    const r = await saveSkin({ libDir: service.libDir, owner, skin, scene: TINY_SCENE, meta: { author: owner, version, source }, deps: d })

    assert.equal(r.ok, true, r.errors.join(' '))
  }

  return { service, dir, lib, put, sel: () => JSON.parse(fs.readFileSync(path.join(dir, 'selection.json'), 'utf8')) }
}

test('uploading a skin made here keeps one copy, <handle>.<slug>; theme and tuning move with it', async t => {
  const { service, lib, sel } = await setup(t)

  assert.equal((await service.saveTuned('official.graphite-circuit', { slug: 'mine', name: 'Mine', vars: {} })).ok, true)
  await service.select('official.firefly-meadow', { dim: 0.1 })
  await service.select('local.mine', { dim: 0.3 })
  assert.deepEqual(sel().theme, 'local.mine')
  assert.equal((await service.authState()).handle, 'bob')
  assert.equal((await service.checkLibrary('local.mine')).ok, true)

  // Order: the upload's folder exists and the local one is still there when the selection moves.
  const order = []
  const moveRef = service.store.moveRef

  service.store.moveRef = async (from, to) => {
    order.push({ toExists: fs.existsSync(lib(to)), fromExists: fs.existsSync(lib(from)) })
    const r = await moveRef(from, to)

    order.push({ theme: sel().theme, fromExists: fs.existsSync(lib(from)) })

    return r
  }
  const up = await service.upload()

  service.store.moveRef = moveRef
  assert.equal(up.ok, true)
  assert.equal(up.ref, 'bob.mine')
  assert.deepEqual(up.moved, { from: 'local.mine', to: 'bob.mine' })
  assert.deepEqual(order, [{ toExists: true, fromExists: true }, { theme: 'bob.mine', fromExists: true }])
  assert.deepEqual(sel(), { theme: 'bob.mine', settings: { 'official.firefly-meadow': { dim: 0.1 }, 'bob.mine': { dim: 0.3 } } })
  assert.deepEqual(up.selection.theme, 'bob.mine')
  assert.equal(fs.existsSync(lib('local.mine')), false)
  assert.deepEqual(service.entries().filter(e => e.slug === 'mine').map(e => e.ref), ['bob.mine'])
  assert.deepEqual(service.entries().find(e => e.ref === 'bob.mine').meta, { author: 'bob', version: 1, source: 'upload', basedOn: 'official.graphite-circuit' })
  assert.deepEqual(service.uploadable(), ['bob.mine'])

  // Sending again updates the upload in place.
  const again = await service.upload()

  assert.equal(again.version, 2)
  assert.equal(again.moved, null)
  assert.equal(service.entries().find(e => e.ref === 'bob.mine').meta.version, 2)
  assert.equal(sel().theme, 'bob.mine')
})

test('a local skin changed between the check and the send stays; a folder import merges nothing', async t => {
  const { service, lib, sel } = await setup(t)

  assert.equal((await service.saveTuned('official.graphite-circuit', { slug: 'mine', name: 'Mine', vars: {} })).ok, true)
  await service.select('local.mine', { dim: 0.3 })
  await service.authState()
  assert.equal((await service.checkLibrary('local.mine')).ok, true)
  const file = path.join(lib('local.mine'), 'skin.json')

  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), name: 'Mine, edited' }))
  const up = await service.upload()

  assert.equal(up.ok, true)
  assert.equal(up.moved, null)
  assert.equal(fs.existsSync(lib('local.mine')), true)
  assert.equal(sel().theme, 'local.mine')

  // Import folder… with the same files as a library skin: both stay.
  assert.equal((await service.saveTuned('official.graphite-circuit', { slug: 'twin', name: 'Twin', vars: {} })).ok, true)
  assert.equal((await service.checkFolder(lib('local.twin'))).ok, true)
  assert.equal((await service.upload()).moved, null)
  assert.equal(fs.existsSync(lib('local.twin')), true)
  assert.equal(fs.existsSync(lib('bob.twin')), true)
})

test('a crash before the local folder goes leaves a usable theme, and the cleanup finishes later', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, async t => {
  // The one-time cleanup already ran for this name: only the retry can finish it.
  const done = new Set(['bob'])
  const { service, lib, sel } = await setup(t, { marks: { has: async h => done.has(h), add: async h => void done.add(h) } })

  assert.equal((await service.saveTuned('official.graphite-circuit', { slug: 'mine', name: 'Mine', vars: {} })).ok, true)
  await service.select('local.mine', { dim: 0.3 })
  await service.authState()

  // The selection write fails: nothing moved, the theme still names the local skin.
  assert.equal((await service.checkLibrary('local.mine')).ok, true)
  const moveRef = service.store.moveRef

  service.store.moveRef = async () => {
    throw new Error('disk full')
  }
  const failed = await service.upload()

  service.store.moveRef = moveRef
  assert.equal(failed.ok, true, 'the upload itself went through')
  assert.equal(failed.moved, null)
  assert.equal(sel().theme, 'local.mine')
  assert.equal(fs.existsSync(lib('local.mine')), true)
  assert.equal(fs.existsSync(lib('bob.mine')), true)

  // The folder can't be removed: the selection already names the upload, which exists.
  fs.chmodSync(lib('local.mine'), 0o555)
  t.after(() => fs.existsSync(lib('local.mine')) && fs.chmodSync(lib('local.mine'), 0o755))
  assert.equal((await service.checkLibrary('local.mine')).ok, true)
  assert.equal((await service.upload()).ok, true)
  fs.chmodSync(lib('local.mine'), 0o755)
  assert.deepEqual(sel(), { theme: 'bob.mine', settings: { 'bob.mine': { dim: 0.3 } } })
  assert.equal(fs.existsSync(lib('local.mine')), true)

  // The next refresh removes the leftover folder without losing the tuning.
  const r = await service.refresh()

  assert.deepEqual(r.moved, [{ from: 'local.mine', to: 'bob.mine' }])
  assert.deepEqual((await service.refresh()).moved, [])
  assert.equal(fs.existsSync(lib('local.mine')), false)
  assert.deepEqual(sel(), { theme: 'bob.mine', settings: { 'bob.mine': { dim: 0.3 } } })
})

test('the one-time cleanup merges identical pairs, keeps edited ones, and waits for the public name', async t => {
  const added = []
  const done = new Set()
  const marks = { has: async h => done.has(h), add: async h => (added.push(h), done.add(h)) }
  const { service, lib, put, sel, dir } = await setup(t, { marks })

  await put('local', tinySkin({ slug: 'same', name: 'Same' }), 'local')
  await put('bob', tinySkin({ slug: 'same', name: 'Same' }), 'upload', 3)
  // Recolored after the upload: the same fingerprint (only the scene counts), not the same skin.
  await put('local', tinySkin({ slug: 'edited', name: 'Edited', colors: { ...tinySkin().colors, roles: { accent: '#c94f35' } } }), 'local')
  await put('bob', tinySkin({ slug: 'edited', name: 'Edited' }), 'upload')
  // A gallery skin of another author with the same slug is not this person's upload.
  await put('local', tinySkin({ slug: 'theirs', name: 'Theirs' }), 'local')
  await put('carol', tinySkin({ slug: 'theirs', name: 'Theirs' }), 'gallery')
  fs.writeFileSync(path.join(dir, 'selection.json'), JSON.stringify({ theme: 'local.same', settings: { 'local.same': { dim: 0.4 }, 'bob.same': { dim: 0.9 }, 'local.edited': { blur: 2 } } }))

  // Not signed in yet (no public name in memory): nothing happens.
  const before = await service.refresh()

  assert.deepEqual(before.moved, [])
  assert.equal(fs.existsSync(lib('local.same')), true)
  assert.deepEqual(added, [])

  assert.equal((await service.authState()).handle, 'bob')
  const r = await service.refresh()

  assert.deepEqual(r.moved, [{ from: 'local.same', to: 'bob.same' }])
  assert.equal(r.selection.theme, 'bob.same')
  assert.deepEqual(sel(), { theme: 'bob.same', settings: { 'bob.same': { dim: 0.4 }, 'local.edited': { blur: 2 } } })
  assert.equal(fs.existsSync(lib('local.same')), false)
  assert.deepEqual(r.library.find(e => e.ref === 'bob.same').meta, { author: 'bob', version: 3, source: 'upload' })
  for (const ref of ['local.edited', 'bob.edited', 'local.theirs', 'carol.theirs']) {
    assert.equal(fs.existsSync(lib(ref)), true, ref)
  }
  assert.equal(r.reset, null)
  assert.deepEqual(added, ['bob'])

  // Once per public name: a pair made later (e.g. Import folder…) is left alone.
  await put('local', tinySkin({ slug: 'later', name: 'Later' }), 'local')
  await put('bob', tinySkin({ slug: 'later', name: 'Later' }), 'upload')
  assert.deepEqual((await service.refresh()).moved, [])
  assert.equal(fs.existsSync(lib('local.later')), true)
})

test('signed out: no public name, no cleanup', async t => {
  const { service, lib, put } = await setup(t, { token: null })

  await put('local', tinySkin({ slug: 'same', name: 'Same' }), 'local')
  await put('bob', tinySkin({ slug: 'same', name: 'Same' }), 'upload')
  assert.equal((await service.authState()).signedIn, false)
  assert.deepEqual((await service.refresh()).moved, [])
  assert.equal(fs.existsSync(lib('local.same')), true)
})

test('selection moveRef: theme and settings follow, the old ref\'s settings win, a repeat keeps them', async t => {
  const dir = tempDir(t)
  const store = createSelectionStore(dir)
  const read = () => JSON.parse(fs.readFileSync(path.join(dir, 'selection.json'), 'utf8'))

  assert.equal(await store.moveRef('local.a', 'bob.a'), false, 'nothing names it: no write')
  assert.equal(fs.existsSync(path.join(dir, 'selection.json')), false)
  await store.applyTheme('bob.a', { dim: 0.9 })
  await store.applyTheme('local.a', { dim: 0.2 })
  assert.equal(await store.moveRef('local.a', 'bob.a'), true)
  assert.deepEqual(read(), { theme: 'bob.a', settings: { 'bob.a': { dim: 0.2 } } })
  assert.equal(await store.moveRef('local.a', 'bob.a'), false)
  assert.deepEqual(read(), { theme: 'bob.a', settings: { 'bob.a': { dim: 0.2 } } })
  // Another skin applied: only the settings move.
  await store.applyTheme('official.x', {})
  await store.setSettings('local.b', { blur: 3 })
  assert.equal(await store.moveRef('local.b', 'bob.b'), true)
  assert.deepEqual(read(), { theme: 'official.x', settings: { 'bob.a': { dim: 0.2 }, 'bob.b': { blur: 3 } } })
  await assert.rejects(store.moveRef('local.b', 'nope'), /Not a skin/)
})

test('drafts.move: the draft follows the skin and wins', () => {
  const drafts = createDrafts(sparseSettings)
  const skin = parseSkin(tinySkin())

  drafts.set('local.a', { dim: 0.5 }, skin, {})
  drafts.set('bob.a', { dim: 0.1 }, skin, {})
  drafts.move('local.a', 'bob.a')
  assert.deepEqual(drafts.refs(), ['bob.a'])
  assert.deepEqual(drafts.current('bob.a', {}), { dim: 0.5 })
  drafts.move('local.none', 'bob.a')
  assert.deepEqual(drafts.current('bob.a', {}), { dim: 0.5 })
})

test('preferences keep the handles the cleanup ran for, and nothing else', () => {
  const { normalizePrefs } = require('../src/prefs')

  assert.deepEqual(normalizePrefs({ mergedUploads: ['13o', '13o', 'Bad Name', 5] }), { language: 'system', autoUpdate: true, mergedUploads: ['13o'] })
  assert.deepEqual(normalizePrefs({ mergedUploads: 'x' }), { language: 'system', autoUpdate: true })
})
