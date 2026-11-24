'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const { createSelectionStore, readSelection, selectionFile } = require('../src/selection')
const { tempDir } = require('./helpers')

const read = dir => JSON.parse(fs.readFileSync(selectionFile(dir), 'utf8'))

test('missing file: nothing selected, nothing created', async t => {
  const dir = path.join(tempDir(t), '.claude-theme-switcher')

  assert.deepEqual(await readSelection(dir), { exists: false, theme: null, settings: {} })
  assert.equal(fs.existsSync(dir), false)
})

test('setTheme writes the spec shape atomically and keeps other settings', async t => {
  const dir = tempDir(t)
  const store = createSelectionStore(dir)

  await store.setSettings('alice.tiny', { dim: 0.2, vars: {} })
  await store.setTheme('official.graphite-circuit')
  assert.deepEqual(read(dir), { theme: 'official.graphite-circuit', settings: { 'alice.tiny': { dim: 0.2, vars: {} } } })
  await store.setTheme('default')
  assert.equal(read(dir).theme, 'default')
  assert.deepEqual(fs.readdirSync(dir), ['selection.json'])
})

test('settings before any Apply leave theme out, so the bridge does nothing', async t => {
  const dir = tempDir(t)

  await createSelectionStore(dir).setSettings('official.firefly-meadow', { dim: 0.1, vars: {} })
  assert.deepEqual(read(dir), { settings: { 'official.firefly-meadow': { dim: 0.1, vars: {} } } })
})

test('v0.1 ids are read through the bridge aliases and rewritten as refs', async t => {
  const dir = tempDir(t)

  fs.writeFileSync(selectionFile(dir), '{"theme":"graphite-circuit"}')
  assert.equal((await readSelection(dir)).theme, 'official.graphite-circuit')
  await createSelectionStore(dir).setSettings('official.graphite-circuit', { dim: 0, vars: {} })
  assert.equal(read(dir).theme, 'official.graphite-circuit')
})

test('concurrent writes are serialised and none is lost', async t => {
  const dir = tempDir(t)
  const store = createSelectionStore(dir)

  await Promise.all([
    store.setSettings('a.one', { dim: 0.1, vars: {} }),
    store.setTheme('a.one'),
    store.setSettings('b.two', { dim: 0.3, vars: {} }),
    store.setSettings('a.one', { dim: 0.5, vars: {} }),
  ])
  assert.deepEqual(read(dir), { theme: 'a.one', settings: { 'a.one': { dim: 0.5, vars: {} }, 'b.two': { dim: 0.3, vars: {} } } })
})

test('reset removes one ref; touchIfActive rewrites only for the active skin', async t => {
  const dir = tempDir(t)
  const store = createSelectionStore(dir)

  assert.equal((await store.touchIfActive('a.one')).exists, false)
  assert.equal(fs.existsSync(selectionFile(dir)), false)
  await store.setSettings('a.one', { dim: 0.1, vars: {} })
  await store.setSettings('b.two', { dim: 0.2, vars: {} })
  await store.setTheme('a.one')
  await store.resetSettings('a.one')
  assert.deepEqual(read(dir), { theme: 'a.one', settings: { 'b.two': { dim: 0.2, vars: {} } } })

  const before = fs.statSync(selectionFile(dir)).mtimeMs

  await new Promise(r => setTimeout(r, 20))
  await store.touchIfActive('b.two')
  assert.equal(fs.statSync(selectionFile(dir)).mtimeMs, before)
  await store.touchIfActive('a.one')
  assert.ok(fs.statSync(selectionFile(dir)).mtimeMs > before)
})

test('bad refs are refused and broken files read as nothing selected', async t => {
  const dir = tempDir(t)
  const store = createSelectionStore(dir)

  await assert.rejects(store.setTheme('../../etc'), /Unknown theme/)
  await assert.rejects(store.setSettings('default', {}), /Not a skin/)
  fs.writeFileSync(selectionFile(dir), '{nope')
  assert.deepEqual(await readSelection(dir), { exists: true, theme: null, settings: {} })
  fs.writeFileSync(selectionFile(dir), '{"theme":"x/y","settings":{"../a":{},"ok.ref":{"dim":1},"b.c":3}}')
  assert.deepEqual(await readSelection(dir), { exists: true, theme: null, settings: { 'ok.ref': { dim: 1 } } })
})
