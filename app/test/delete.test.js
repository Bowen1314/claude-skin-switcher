'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const { createDrafts } = require('../src/drafts')
const { removeSkinDir } = require('../src/library')
const { createService } = require('../src/service')
const { parseSkin, sparseSettings } = require('../src/skin-render')
const { deps } = require('./deps-helper')
const { TINY_SCENE, tinySkin } = require('./fixtures')
const { tempDir } = require('./helpers')

const BUNDLED = path.join(__dirname, '..', '..', 'plugin', 'skins')
const offlineGallery = { detail: async () => { throw new Error('offline') }, list: async () => ({ items: [] }) }

const setup = async t => {
  const home = tempDir(t)
  const dir = path.join(home, '.claude-theme-switcher')
  const service = createService({
    dir,
    deps: await deps(),
    bundledDir: BUNDLED,
    gallery: offlineGallery,
    tokenStore: { load: async () => null, save: async () => ({ ok: true }), clear: async () => {} },
    config: { clientId: '', localOwner: 'local', openExternal: async () => {} },
  })

  await service.start()
  const lib = path.join(dir, 'skins')
  const put = (ref, source) => {
    const [owner, slug] = ref.split('.')
    const folder = path.join(lib, ref)

    fs.mkdirSync(folder, { recursive: true })
    fs.writeFileSync(path.join(folder, 'skin.json'), JSON.stringify({ ...tinySkin(), slug, author: owner }))
    fs.writeFileSync(path.join(folder, 'scene.svg'), TINY_SCENE)
    fs.writeFileSync(path.join(folder, 'meta.json'), JSON.stringify({ author: owner, version: 1, source }))
  }

  return { service, dir, lib, put, sel: () => JSON.parse(fs.readFileSync(path.join(dir, 'selection.json'), 'utf8')) }
}

test('deleting a skin that is not active removes only its folder and settings', async t => {
  const { service, lib, put, sel } = await setup(t)

  put('alice.tiny', 'gallery')
  put('local.mine', 'local')
  await service.library()
  await service.select('alice.tiny', { dim: 0.3 })
  await service.select('local.mine', { dim: 0.5 })
  await service.select('official.firefly-meadow', null)
  assert.ok('alice.tiny' in sel().settings)

  const r = await service.deleteSkin('alice.tiny')

  assert.deepEqual(r, { ok: true, ref: 'alice.tiny', switchedToDefault: false })
  assert.equal(fs.existsSync(path.join(lib, 'alice.tiny')), false)
  assert.equal(sel().theme, 'official.firefly-meadow', 'the active theme is untouched')
  assert.equal('alice.tiny' in sel().settings, false)
  assert.ok('local.mine' in sel().settings, 'other skins keep their settings')
  assert.equal(service.entries().some(e => e.ref === 'alice.tiny'), false)
  assert.ok(fs.existsSync(path.join(lib, 'local.mine')))
})

test('deleting the active skin switches Claude back to default and clears its settings and draft', async t => {
  const { service, lib, put, sel } = await setup(t)

  put('local.mine', 'local')
  await service.library()
  await service.select('local.mine', { dim: 0.4 })
  assert.equal(sel().theme, 'local.mine')

  // The window's unapplied draft for it goes too (the renderer calls discard).
  const drafts = createDrafts(sparseSettings)
  const parsed = parseSkin(service.entries().find(e => e.ref === 'local.mine').skin)

  drafts.set('local.mine', { dim: 0.7 }, parsed, sel().settings)
  assert.equal(drafts.has('local.mine'), true)

  const r = await service.deleteSkin('local.mine')

  drafts.discard('local.mine')
  assert.equal(r.switchedToDefault, true)
  assert.equal(sel().theme, 'default')
  assert.equal(sel().settings?.['local.mine'], undefined)
  assert.equal(drafts.has('local.mine'), false)
  assert.equal(fs.existsSync(path.join(lib, 'local.mine')), false)
})

test('official skins cannot be deleted', async t => {
  const { service, lib } = await setup(t)

  await assert.rejects(service.deleteSkin('official.firefly-meadow'), /Built-in/)
  await assert.rejects(removeSkinDir(lib, 'official.firefly-meadow'), /Built-in/)
  assert.ok(fs.existsSync(path.join(lib, 'official.firefly-meadow', 'skin.json')))
  await assert.rejects(service.deleteSkin('default'))
})

test('refs with .. or path separators are refused before anything is touched', async t => {
  const { service, dir, lib } = await setup(t)
  const outside = path.join(dir, 'outside')

  fs.mkdirSync(outside)
  fs.writeFileSync(path.join(outside, 'keep.txt'), 'x')
  for (const bad of ['../outside', '..', '.', 'a/../../outside', 'alice/../..', 'alice\\..\\x', '/etc', '', 'alice.tiny/..', null]) {
    await assert.rejects(removeSkinDir(lib, bad), String(bad))
    await assert.rejects(service.deleteSkin(bad), String(bad))
  }
  assert.ok(fs.existsSync(path.join(outside, 'keep.txt')))
  assert.ok(fs.existsSync(lib))
})
