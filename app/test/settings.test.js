'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const { backupStamp, enableInSettings, mergeSettings, settingsSayInstalled } = require('../src/settings')
const { tempDir } = require('./helpers')

const NOW = Date.UTC(2026, 10, 24, 12, 30, 45, 123)
const MK = { source: { source: 'directory', path: '/home/a/.claude-theme-switcher/marketplace' } }

test('merge keeps other keys, marketplaces and plugins', () => {
  const r = mergeSettings(
    {
      theme: 'dark',
      permissions: { allow: ['Bash(ls)'] },
      extraKnownMarketplaces: { other: { source: { source: 'github', repo: 'o/r' } } },
      enabledPlugins: { 'x@other': false },
    },
    MK.source.path,
  )

  assert.equal(r.ok, true)
  assert.deepEqual(r.settings, {
    theme: 'dark',
    permissions: { allow: ['Bash(ls)'] },
    extraKnownMarketplaces: { other: { source: { source: 'github', repo: 'o/r' } }, 'claude-theme-switcher': MK },
    enabledPlugins: { 'x@other': false, 'theme-switcher@claude-theme-switcher': true },
  })
})

test('merge repoints an existing entry and keeps its extra fields', () => {
  const r = mergeSettings(
    { extraKnownMarketplaces: { 'claude-theme-switcher': { autoUpdate: false, source: { source: 'directory', path: '/old' } } } },
    '/new',
  )

  assert.deepEqual(r.settings.extraKnownMarketplaces['claude-theme-switcher'], {
    autoUpdate: false,
    source: { source: 'directory', path: '/new' },
  })
})

test('merge refuses non-objects', () => {
  assert.equal(mergeSettings([], '/m').reason, 'not-object')
  assert.equal(mergeSettings('x', '/m').reason, 'not-object')
  assert.equal(mergeSettings({ enabledPlugins: [] }, '/m').reason, 'unexpected-shape')
  assert.equal(mergeSettings({ extraKnownMarketplaces: 'x' }, '/m').reason, 'unexpected-shape')
})

test('enableInSettings backs up, merges and writes atomically', async t => {
  const dir = path.join(tempDir(t), '.claude')
  const file = path.join(dir, 'settings.json')
  const original = '{\n  "model": "opus",\n  "enabledPlugins": { "a@b": true }\n}\n'

  fs.mkdirSync(dir)
  fs.writeFileSync(file, original)

  const r = await enableInSettings({ settingsFile: file, marketplaceDir: MK.source.path, now: NOW })

  assert.equal(r.ok, true)
  assert.equal(r.backup, `${file}.bak-${backupStamp(NOW)}`)
  assert.equal(path.basename(r.backup), 'settings.json.bak-2026-11-24T12-30-45-123Z')
  assert.equal(fs.readFileSync(r.backup, 'utf8'), original)

  const written = JSON.parse(fs.readFileSync(file, 'utf8'))

  assert.equal(written.model, 'opus')
  assert.equal(written.enabledPlugins['a@b'], true)
  assert.equal(written.enabledPlugins['theme-switcher@claude-theme-switcher'], true)
  assert.deepEqual(written.extraKnownMarketplaces['claude-theme-switcher'], MK)
  assert.deepEqual(fs.readdirSync(dir).sort(), ['settings.json', path.basename(r.backup)].sort())
  assert.equal(await settingsSayInstalled(file), true)
})

test('enableInSettings creates the file (no backup) when missing', async t => {
  const file = path.join(tempDir(t), '.claude', 'settings.json')
  const r = await enableInSettings({ settingsFile: file, marketplaceDir: MK.source.path, now: NOW })

  assert.equal(r.ok, true)
  assert.equal(r.backup, null)
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).enabledPlugins['theme-switcher@claude-theme-switcher'], true)
})

test('enableInSettings refuses invalid JSON and leaves the file alone', async t => {
  const dir = tempDir(t)
  const file = path.join(dir, 'settings.json')
  const broken = '{ "model": "opus", // comment\n}'

  fs.writeFileSync(file, broken)

  const r = await enableInSettings({ settingsFile: file, marketplaceDir: '/m', now: NOW })

  assert.equal(r.ok, false)
  assert.equal(r.reason, 'invalid-json')
  assert.equal(fs.readFileSync(file, 'utf8'), broken)
  assert.deepEqual(fs.readdirSync(dir), ['settings.json'])
})

test('settingsSayInstalled needs both keys', async t => {
  const file = path.join(tempDir(t), 'settings.json')

  assert.equal(await settingsSayInstalled(file), false)
  fs.writeFileSync(file, JSON.stringify({ enabledPlugins: { 'theme-switcher@claude-theme-switcher': true } }))
  assert.equal(await settingsSayInstalled(file), false)
  fs.writeFileSync(file, JSON.stringify({ enabledPlugins: { 'theme-switcher@claude-theme-switcher': true }, extraKnownMarketplaces: { 'claude-theme-switcher': MK } }))
  assert.equal(await settingsSayInstalled(file), true)
})
