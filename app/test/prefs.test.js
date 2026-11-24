'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const { tempDir } = require('./helpers')
const { DEFAULTS, createPrefs, normalizePrefs, resolveLang } = require('../src/prefs')

test('System follows the first preferred language that is English or Chinese', () => {
  assert.equal(resolveLang('system', ['en-US', 'zh-Hans-US']), 'en')
  assert.equal(resolveLang('system', ['zh-Hans-CN', 'en-US']), 'zh')
  assert.equal(resolveLang('system', ['fr-FR', 'zh-TW', 'en-GB']), 'zh')
  assert.equal(resolveLang('system', ['de-DE', 'en-GB', 'zh-CN']), 'en')
  assert.equal(resolveLang('system', ['ja-JP']), 'en')
  assert.equal(resolveLang('system', []), 'en')
  assert.equal(resolveLang('system', undefined), 'en')
  assert.equal(resolveLang('zh', ['en-US']), 'zh')
  assert.equal(resolveLang('en', ['zh-CN']), 'en')
  assert.equal(resolveLang('klingon', ['zh-CN']), 'zh', 'an unknown choice behaves like System')
})

test('preferences are normalized', () => {
  assert.deepEqual(normalizePrefs(null), DEFAULTS)
  assert.deepEqual(normalizePrefs([]), DEFAULTS)
  assert.deepEqual(normalizePrefs({ language: 'zh', autoUpdate: false }), { language: 'zh', autoUpdate: false })
  assert.deepEqual(normalizePrefs({ language: 'fr', autoUpdate: 'yes', extra: 1 }), DEFAULTS)
  assert.deepEqual(DEFAULTS, { language: 'system', autoUpdate: true })
})

test('the language choice persists in a JSON file and survives a restart', async t => {
  const dir = tempDir(t)
  const file = path.join(dir, 'userData', 'preferences.json')
  const first = createPrefs({ file })

  assert.deepEqual(await first.load(), DEFAULTS, 'no file yet: defaults, nothing written')
  assert.equal(fs.existsSync(file), false)
  assert.deepEqual(await first.set({ language: 'zh' }), { language: 'zh', autoUpdate: true })
  assert.deepEqual(await first.set({ autoUpdate: false }), { language: 'zh', autoUpdate: false })
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { language: 'zh', autoUpdate: false })
  // Written atomically: no temp files left next to it.
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['preferences.json'])
  const again = createPrefs({ file })

  assert.deepEqual(await again.load(), { language: 'zh', autoUpdate: false })
  assert.equal(resolveLang(again.get().language, ['en-US']), 'zh')
  // Bad values from the window are dropped.
  assert.deepEqual(await again.set({ language: '../../etc' }), { language: 'system', autoUpdate: false })
})

test('a broken preferences file falls back to defaults; memory mode writes nothing', async t => {
  const dir = tempDir(t)
  const file = path.join(dir, 'preferences.json')

  fs.writeFileSync(file, '{not json')
  assert.deepEqual(await createPrefs({ file }).load(), DEFAULTS)
  const memory = createPrefs({ file: null })

  await memory.set({ language: 'en' })
  assert.equal(memory.get().language, 'en')
  assert.deepEqual(fs.readdirSync(dir), ['preferences.json'])
  assert.equal(fs.readFileSync(file, 'utf8'), '{not json')
})

test('writes that overlap end with the last value on disk', async t => {
  const file = path.join(tempDir(t), 'preferences.json')
  const prefs = createPrefs({ file })

  await Promise.all([prefs.set({ language: 'en' }), prefs.set({ language: 'zh' }), prefs.set({ autoUpdate: false })])
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { language: 'zh', autoUpdate: false })
})
