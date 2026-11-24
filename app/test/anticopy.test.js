'use strict'

// Upload only what you made: the upload list, the fingerprint check on import
// and before sending, the gallery's 409, remix credit, and the stale-selection reset.

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const { depPaths } = require('../src/deps')
const { createGallery, listItem } = require('../src/gallery')
const { createService } = require('../src/service')
const { deps } = require('./deps-helper')
const { TINY_SCENE, tinySkin } = require('./fixtures')
const { tempDir } = require('./helpers')
const { startMock } = require('./mock-server')

const BUNDLED = path.join(__dirname, '..', '..', 'plugin', 'skins')
// TINY_SCENE recolored and reformatted: the same drawing.
const RECOLORED = TINY_SCENE.replace('#ffffff', '#00ff88').replace('<circle', '\n  <circle')
const idTok = () => `h.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600, sub: 'acct' })).toString('base64url')}.s`

const setup = async (t, { routes = {}, handle = 'bob' } = {}) => {
  const d = await deps()
  const home = tempDir(t)
  const dir = path.join(home, '.claude-theme-switcher')
  const uploads = []
  const mock = await startMock(t, {
    'POST /token': () => ({ json: { id_token: idTok(), expires_in: 3599 } }),
    'GET /api/me': () => ({ json: { handle, skins: [] } }),
    'GET /api/skins/alice/tiny': () => ({ json: { ...tinySkin(), author: 'alice', version: 1 } }),
    'GET /api/skins/alice/tiny/scene.svg': () => ({ text: TINY_SCENE }),
    'POST /api/skins/alice/tiny/download': () => ({ json: { ok: true } }),
    'POST /api/skins': (_req, body) => {
      const b = JSON.parse(body)

      uploads.push(b)

      return { status: 201, json: { ref: `${handle}.${b.skin.slug}`, version: 1 } }
    },
    ...routes,
  })
  let token = 'refresh-1'
  const tokenStore = { load: async () => token, save: async v => ((token = v), { ok: true, persisted: true }), clear: async () => { token = null } }
  const service = createService({
    dir,
    deps: d,
    bundledDir: BUNDLED,
    gallery: createGallery({ baseUrl: mock.url, deps: d }),
    tokenStore,
    config: { googleAuthUrl: `${mock.url}/auth`, googleTokenUrl: `${mock.url}/token`, clientId: 'cid', clientSecret: '', localOwner: 'local', openExternal: async () => {} },
  })

  await service.start()

  return { service, dir, mock, uploads, sel: () => JSON.parse(fs.readFileSync(path.join(dir, 'selection.json'), 'utf8')) }
}

// A folder someone made by copying a downloaded skin and renaming it.
const copyFolder = (t, scene, extra = {}, meta = null) => {
  const folder = tempDir(t)

  fs.writeFileSync(path.join(folder, 'skin.json'), JSON.stringify(tinySkin({ slug: 'my-own', name: 'My Own', description: 'Totally mine.', ...extra })))
  fs.writeFileSync(path.join(folder, 'scene.svg'), scene)
  if (meta !== null) {
    fs.writeFileSync(path.join(folder, 'meta.json'), JSON.stringify(meta))
  }

  return folder
}

test('the upload list offers only skins made here or uploaded; checkLibrary refuses the rest', async t => {
  const { service } = await setup(t)

  assert.equal((await service.gallerySave('alice', 'tiny')).ok, true)
  assert.equal((await service.saveTuned('official.graphite-circuit', { slug: 'my-graphite', name: 'Mine', vars: {} })).ok, true)
  assert.deepEqual(service.uploadable(), ['local.my-graphite'], 'gallery downloads and built-in skins never appear')
  for (const ref of ['alice.tiny', 'official.firefly-meadow']) {
    const r = await service.checkLibrary(ref)

    assert.equal(r.ok, false, ref)
    assert.equal(r.notMine, true, ref)
  }
  await assert.rejects(service.upload(), /Nothing checked/, 'a refused check stages nothing')
})

test('importing a recolored, renamed copy of a downloaded skin is refused, naming the original', async t => {
  const { service, uploads } = await setup(t)

  await service.gallerySave('alice', 'tiny')
  const r = await service.checkFolder(copyFolder(t, RECOLORED, { colors: { roles: { accent: '#ff0000' }, dark: { anchors: { 'surface-0': '#000000', 'surface-1': '#0a0a0a', 'text-primary': '#ffffff', 'text-muted': '#999999' } } } }))

  assert.equal(r.ok, false)
  assert.deepEqual(r.copyOf, { ref: 'alice.tiny', name: 'Tiny', author: 'alice' })
  assert.deepEqual(r.errors, ['This is Tiny by alice from the gallery. You can only upload skins you made.'])
  await assert.rejects(service.upload(), /Nothing checked/)
  // The downloaded folder itself, copied out of the library, is refused the same way.
  const lib = path.join(service.libDir, 'alice.tiny')

  assert.equal((await service.checkFolder(lib)).copyOf?.ref, 'alice.tiny')
  // A built-in skin's folder too.
  assert.equal((await service.checkFolder(path.join(BUNDLED, 'official.firefly-meadow'))).copyOf?.ref, 'official.firefly-meadow')
  // A different drawing passes.
  assert.equal((await service.checkFolder(copyFolder(t, TINY_SCENE.replace('r="5"', 'r="6"')))).ok, true)
  assert.equal(uploads.length, 0)
})

test('a declared remix (basedOn in meta.json) may be imported, and basedOn is sent top-level', async t => {
  const { service, uploads } = await setup(t)

  await service.gallerySave('alice', 'tiny')
  assert.equal((await service.checkFolder(copyFolder(t, RECOLORED, {}, { basedOn: 'official.firefly-meadow' }))).ok, false, 'naming another skin does not help')
  const r = await service.checkFolder(copyFolder(t, RECOLORED, {}, { basedOn: 'alice.tiny' }))

  assert.equal(r.ok, true, r.errors.join(' '))
  const up = await service.upload()

  assert.equal(up.ok, true)
  assert.equal(uploads[0].basedOn, 'alice.tiny')
  assert.equal(uploads[0].skin.basedOn, undefined, 'not inside skin.json')
  assert.equal(service.entries().find(e => e.ref === 'bob.my-own').meta.basedOn, 'alice.tiny')
})

test('Save as new from a gallery or built-in skin records basedOn, and that skin can be uploaded', async t => {
  const { service, uploads } = await setup(t)

  await service.gallerySave('alice', 'tiny')
  assert.equal((await service.saveTuned('alice.tiny', { slug: 'tiny-mine', name: 'Tiny mine', vars: { glow: '#00ff00' } })).ok, true)
  assert.equal((await service.saveTuned('official.graphite-circuit', { slug: 'graphite-mine', name: 'G', vars: {} })).ok, true)
  const remix = service.entries().find(e => e.ref === 'local.tiny-mine')

  assert.equal(remix.meta.basedOn, 'alice.tiny')
  assert.equal(JSON.parse(fs.readFileSync(path.join(service.libDir, 'local.tiny-mine', 'meta.json'), 'utf8')).basedOn, 'alice.tiny')
  assert.equal(service.entries().find(e => e.ref === 'local.graphite-mine').meta.basedOn, 'official.graphite-circuit')
  // A copy of the remix keeps crediting the original.
  assert.equal((await service.saveTuned('local.tiny-mine', { slug: 'tiny-mine-two', vars: {} })).ok, true)
  assert.equal(service.entries().find(e => e.ref === 'local.tiny-mine-two').meta.basedOn, 'alice.tiny')

  const r = await service.checkLibrary('local.tiny-mine')

  assert.equal(r.ok, true, r.errors.join(' '))
  assert.equal((await service.upload()).ok, true)
  assert.equal(uploads[0].basedOn, 'alice.tiny')
})

test('right before sending, the copy check runs again; a 409 from the gallery names the original', async t => {
  const { service, uploads } = await setup(t, {
    routes: {
      'POST /api/skins': () => ({ status: 409, json: { error: 'already in the gallery', original: 'carol.meadow', name: 'Meadow‮' } }),
    },
  })

  // Checked before the gallery skin was in the library, sent after.
  assert.equal((await service.checkFolder(copyFolder(t, RECOLORED))).ok, true)
  await service.gallerySave('alice', 'tiny')
  const local = await service.upload()

  assert.equal(local.ok, false)
  assert.equal(local.copyOf.ref, 'alice.tiny')
  assert.equal(uploads.length, 0, 'nothing was sent')

  // The gallery knows a skin this library doesn't have.
  assert.equal((await service.checkFolder(copyFolder(t, TINY_SCENE.replace('r="5"', 'r="7"')))).ok, true)
  const remote = await service.upload()

  assert.deepEqual(remote.copyOf, { ref: 'carol.meadow', author: 'carol', name: 'Meadow ' })
  assert.match(remote.error, /This is Meadow {2}by carol/)
  assert.equal(service.entries().some(e => e.ref === 'bob.my-own'), false, 'a refused upload is not saved as yours')
})

test('your own skins downloaded again stay uploadable', async t => {
  const { service } = await setup(t, { handle: 'alice' })

  assert.equal((await service.authState()).handle, 'alice')
  await service.gallerySave('alice', 'tiny')
  assert.equal(service.entries().find(e => e.ref === 'alice.tiny').meta.source, 'upload')
  assert.deepEqual(service.uploadable(), ['alice.tiny'])
  assert.equal((await service.checkLibrary('alice.tiny')).ok, true)
  assert.equal((await service.checkFolder(copyFolder(t, RECOLORED))).ok, true)
})

test('a selection that points at a missing or broken skin goes back to default, on start and on refresh', async t => {
  const { service, dir, sel } = await setup(t)
  const file = path.join(dir, 'selection.json')

  // On start: a skin that is not in the library.
  fs.writeFileSync(file, JSON.stringify({ theme: 'alice.gone', settings: { 'alice.gone': { dim: 0.2 }, 'official.firefly-meadow': { dim: 0.1 } } }))
  await service.start()
  assert.deepEqual(sel(), { theme: 'default', settings: { 'official.firefly-meadow': { dim: 0.1 } } })

  // A working skin is left alone.
  await service.gallerySave('alice', 'tiny')
  await service.select('alice.tiny', { dim: 0.3 })
  assert.equal((await service.refresh()).reset, null)
  assert.equal(sel().theme, 'alice.tiny')

  // On refresh: the applied skin's files are broken, then gone.
  fs.writeFileSync(path.join(service.libDir, 'alice.tiny', 'skin.json'), '{ "format": 1, "slug": "tiny" }')
  const broken = await service.refresh()

  assert.equal(broken.reset, 'alice.tiny')
  assert.equal(broken.selection.theme, 'default')
  assert.equal(sel().theme, 'default')
  await service.select('official.graphite-circuit', {})
  fs.rmSync(path.join(service.libDir, 'official.graphite-circuit'), { recursive: true })
  const gone = await service.refresh()

  assert.equal(gone.reset, 'official.graphite-circuit')
  assert.equal(gone.library.some(e => e.ref === 'official.graphite-circuit'), false)
  assert.equal(sel().theme, 'default')
  // "default" and no selection at all are never touched.
  assert.equal((await service.refresh()).reset, null)
})

test('the fingerprint module ships with the app; the gallery client keeps a valid basedOn only', () => {
  const dev = depPaths({ isPackaged: false, appDir: path.join(__dirname, '..') })
  const packed = depPaths({ isPackaged: true, resourcesPath: '/res' })

  assert.equal(fs.existsSync(dev.fingerprint), true)
  assert.equal(packed.fingerprint, path.join('/res', 'shared', 'fingerprint.mjs'))
  const extra = require('../package.json').build.extraResources

  assert.ok(extra.some(e => e.from === '../shared/fingerprint.js' && e.to === 'shared/fingerprint.mjs'))
  // No imports: the packaged copy sits alone next to skin-validate.mjs.
  assert.doesNotMatch(fs.readFileSync(dev.fingerprint, 'utf8'), /^\s*import\s/m)

  assert.deepEqual(
    [listItem({ author: 'bob', slug: 'remix', basedOn: 'alice.tiny', basedOnName: 'Tiny' }).basedOn, listItem({ author: 'bob', slug: 'remix', basedOn: 'alice.tiny' }).basedOnName],
    ['alice.tiny', null],
  )
  for (const bad of ['../x.y', 'alice', 'a.b.c', 'Alice.Tiny', 42]) {
    assert.equal(listItem({ author: 'bob', slug: 'remix', basedOn: bad }).basedOn, undefined, String(bad))
  }
})
