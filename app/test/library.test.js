'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const { listLibrary, makeRef, readCode, readScene, saveSkin, syncOfficial } = require('../src/library')
const { deps } = require('./deps-helper')
const { TINY_SCENE, tinySkin } = require('./fixtures')
const { tempDir } = require('./helpers')

const BUNDLED = path.join(__dirname, '..', '..', 'plugin', 'skins')

const put = (lib, ref, files) => {
  fs.mkdirSync(path.join(lib, ref), { recursive: true })
  for (const [name, data] of Object.entries(files)) {
    fs.writeFileSync(path.join(lib, ref, name), typeof data === 'string' ? data : JSON.stringify(data))
  }
}

test('makeRef only builds refs the bridge accepts', () => {
  assert.equal(makeRef('Alice', 'tiny'), 'alice.tiny')
  assert.equal(makeRef('..', 'tiny'), null)
  assert.equal(makeRef('a/b', 'tiny'), null)
  assert.equal(makeRef('alice', '../x'), null)
})

test('syncOfficial copies the bundled skins byte for byte, then only on change', async t => {
  const d = await deps()
  const lib = path.join(tempDir(t), 'skins')

  assert.deepEqual((await syncOfficial({ bundledDir: BUNDLED, libDir: lib, deps: d })).sort(), ['official.firefly-meadow', 'official.graphite-circuit'])
  for (const ref of ['official.firefly-meadow', 'official.graphite-circuit']) {
    for (const f of ['skin.json', 'scene.svg']) {
      assert.ok(fs.readFileSync(path.join(lib, ref, f)).equals(fs.readFileSync(path.join(BUNDLED, ref, f))), `${ref}/${f}`)
    }
    assert.deepEqual(
      (({ author, version, source }) => ({ author, version, source }))(JSON.parse(fs.readFileSync(path.join(lib, ref, 'meta.json'), 'utf8'))),
      { author: 'official', version: JSON.parse(fs.readFileSync(path.join(BUNDLED, ref, 'skin.json'), 'utf8')).version, source: 'bundled' },
    )
  }
  assert.deepEqual(await syncOfficial({ bundledDir: BUNDLED, libDir: lib, deps: d }), [])
  fs.appendFileSync(path.join(lib, 'official.graphite-circuit', 'scene.svg'), ' ')
  assert.deepEqual(await syncOfficial({ bundledDir: BUNDLED, libDir: lib, deps: d }), ['official.graphite-circuit'])
  assert.deepEqual(fs.readdirSync(lib).sort(), ['official.firefly-meadow', 'official.graphite-circuit'])

  // A newer copy saved from the gallery is not reverted by the bundled one.
  const metaFile = path.join(lib, 'official.firefly-meadow', 'meta.json')
  const newer = JSON.parse(fs.readFileSync(path.join(BUNDLED, 'official.firefly-meadow', 'skin.json'), 'utf8')).version + 1

  fs.writeFileSync(metaFile, JSON.stringify({ author: 'official', version: newer, source: 'gallery' }))
  fs.appendFileSync(path.join(lib, 'official.firefly-meadow', 'scene.svg'), ' ')
  assert.deepEqual(await syncOfficial({ bundledDir: BUNDLED, libDir: lib, deps: d }), [])
  assert.equal(JSON.parse(fs.readFileSync(metaFile, 'utf8')).version, newer)
})

test('listLibrary: officials first, broken skins become rows with errors', async t => {
  const d = await deps()
  const lib = path.join(tempDir(t), 'skins')

  await syncOfficial({ bundledDir: BUNDLED, libDir: lib, deps: d })
  put(lib, 'alice.tiny', { 'skin.json': tinySkin(), 'scene.svg': TINY_SCENE, 'meta.json': { author: 'alice', version: 4, source: 'gallery' } })
  put(lib, 'bob.broken', { 'skin.json': '{"format":1' })
  put(lib, 'carol.noscene', { 'skin.json': tinySkin({ slug: 'noscene' }) })
  put(lib, 'dave.evil', { 'skin.json': tinySkin({ slug: 'evil' }), 'scene.svg': '<svg viewBox="0 0 1 1"><script>alert(1)</script></svg>' })
  put(lib, 'erin.wrong', { 'skin.json': tinySkin({ slug: 'other' }) })
  put(lib, 'not a ref', { 'skin.json': tinySkin() })
  fs.writeFileSync(path.join(lib, 'stray.file'), 'x')

  const entries = await listLibrary(lib, d)
  const byRef = Object.fromEntries(entries.map(e => [e.ref, e]))

  assert.deepEqual(entries.map(e => e.ref).slice(0, 2), ['official.firefly-meadow', 'official.graphite-circuit'])
  assert.equal(entries.length, 7)
  assert.equal(byRef['alice.tiny'].ok, true)
  assert.deepEqual(byRef['alice.tiny'].meta, { author: 'alice', version: 4, source: 'gallery' })
  assert.equal(byRef['alice.tiny'].skin.variables[1].step, 0.1)
  assert.equal(byRef['official.graphite-circuit'].hasScene, true)
  assert.equal(byRef['bob.broken'].ok, false)
  assert.match(byRef['bob.broken'].errors[0], /JSON/)
  assert.match(byRef['carol.noscene'].errors[0], /scene.svg is missing/)
  assert.match(byRef['dave.evil'].errors.join(' '), /scene:/)
  assert.match(byRef['erin.wrong'].errors[0], /does not match/)
})

const noBackdrop = extra => {
  const skin = tinySkin(extra)

  delete skin.backdrop

  return skin
}

test('a skin makeColors refuses is a broken row', async t => {
  const d = await deps()
  const lib = tempDir(t)
  // Passes the validator, but text on surface-0 is unreadable (about 1:1).
  const dim = noBackdrop({ slug: 'murky', colors: { dark: { anchors: { 'surface-0': '#101114', 'text-primary': '#141518' } } } })
  // surface-0 lighter than text-primary in dark mode: makeColors throws (if the validator lets it through).
  const upside = noBackdrop({ slug: 'upside', colors: { dark: { anchors: { 'surface-0': '#ffffff', 'text-primary': '#000000' } } } })

  assert.equal(d.validateSkin(dim).ok, true)
  put(lib, 'zed.murky', { 'skin.json': dim })
  put(lib, 'zed.upside', { 'skin.json': upside })
  const entries = await listLibrary(lib, d)

  for (const entry of entries) {
    assert.equal(entry.ok, false, entry.ref)
    assert.match(entry.errors[0], /^colors: /, entry.ref)
  }
  assert.match(entries.find(e => e.ref === 'zed.murky').errors[0], /won't paint/)
})

test('saveSkin validates, swaps the folder in, and refuses bad input', async t => {
  const d = await deps()
  const lib = path.join(tempDir(t), 'skins')
  const r = await saveSkin({ libDir: lib, owner: 'Alice', skin: { ...tinySkin(), author: 'mallory', version: 99 }, scene: TINY_SCENE, meta: { author: 'alice', version: 3, source: 'gallery' }, deps: d })

  assert.deepEqual(r, { ok: true, ref: 'alice.tiny', errors: [] })
  const saved = JSON.parse(fs.readFileSync(path.join(lib, 'alice.tiny', 'skin.json'), 'utf8'))

  assert.equal(saved.author, 'alice')
  assert.equal(saved.version, 3)
  const forged = await saveSkin({ libDir: lib, owner: 'alice', skin: { ...tinySkin(), slug: 'forged' }, scene: TINY_SCENE, meta: { author: 'mallory', version: 1, source: 'gallery' }, deps: d })

  assert.equal(JSON.parse(fs.readFileSync(path.join(lib, forged.ref, 'meta.json'), 'utf8')).author, 'alice')
  fs.rmSync(path.join(lib, forged.ref), { recursive: true })
  assert.equal(await readScene(lib, 'alice.tiny', d), TINY_SCENE)

  assert.equal((await saveSkin({ libDir: lib, owner: 'alice', skin: tinySkin(), scene: undefined, meta: {}, deps: d })).ok, false)
  assert.equal((await saveSkin({ libDir: lib, owner: 'alice', skin: tinySkin(), scene: '<svg><script/></svg>', meta: {}, deps: d })).ok, false)
  assert.equal((await saveSkin({ libDir: lib, owner: '../x', skin: tinySkin(), scene: TINY_SCENE, meta: {}, deps: d })).ok, false)
  assert.equal((await saveSkin({ libDir: lib, owner: 'alice', skin: { format: 1 }, meta: {}, deps: d })).ok, false)
  await assert.rejects(readScene(lib, '../alice.tiny', d), /not a skin name/)
  assert.deepEqual(fs.readdirSync(lib), ['alice.tiny'])
})

test('readCode returns the files on disk byte for byte, with the validator verdict', async t => {
  const d = await deps()
  const lib = path.join(tempDir(t), 'skins')

  await syncOfficial({ bundledDir: BUNDLED, libDir: lib, deps: d })
  const code = await readCode(lib, 'official.firefly-meadow', d)

  assert.equal(code.skinJson, fs.readFileSync(path.join(BUNDLED, 'official.firefly-meadow', 'skin.json'), 'utf8'))
  assert.equal(code.sceneSvg, fs.readFileSync(path.join(BUNDLED, 'official.firefly-meadow', 'scene.svg'), 'utf8'))
  assert.deepEqual(code.check, { ok: true, errors: [] })

  const { backdrop, variables, ...flatSkin } = tinySkin()

  put(lib, 'local.flat', { 'skin.json': { ...flatSkin, slug: 'flat' } })
  const flat = await readCode(lib, 'local.flat', d)

  assert.equal(flat.sceneSvg, null, 'no scene for a skin without a backdrop scene')
  assert.equal(flat.check.ok, true)

  put(lib, 'local.evil', { 'skin.json': { ...tinySkin(), slug: 'evil', backdrop: { scene: true } }, 'scene.svg': '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>' })
  const evil = await readCode(lib, 'local.evil', d)

  assert.equal(evil.check.ok, false)
  assert.ok(evil.check.errors.every(e => e.startsWith('scene: ')))
  assert.match(evil.sceneSvg, /<script>/, 'the raw text is still shown')

  put(lib, 'local.bad', { 'skin.json': '{oops' })
  assert.equal((await readCode(lib, 'local.bad', d)).check.ok, false)
  await assert.rejects(readCode(lib, '../x', d))
})
