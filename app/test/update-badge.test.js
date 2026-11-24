'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')

const { showBadge, popoverView } = require('../src/update-badge')

const st = (status, extra = {}) => ({ status, current: '0.2.5', latest: '0.2.6', progress: null, error: null, ...extra })

test('the icon shows only while a newer version is known', () => {
  for (const s of ['available', 'checking', 'downloading', 'installing']) {
    assert.equal(showBadge(st(s)), true, s)
  }
  assert.equal(showBadge(st('up-to-date', { latest: null })), false)
  assert.equal(showBadge(st('idle', { latest: null })), false)
  assert.equal(showBadge(st('idle')), false)
  assert.equal(showBadge(st('available', { latest: null })), false)
  assert.equal(showBadge(null), false)
  assert.equal(showBadge(undefined), false)
})

test('"Not now" hides the icon for that version only, unless an update is running', () => {
  assert.equal(showBadge(st('available'), '0.2.6'), false)
  assert.equal(showBadge(st('checking'), '0.2.6'), false)
  assert.equal(showBadge(st('available', { latest: '0.2.7' }), '0.2.6'), true)
  assert.equal(showBadge(st('downloading'), '0.2.6'), true)
  assert.equal(showBadge(st('installing'), '0.2.6'), true)
})

test('the popover shows the phase, progress and update errors only', () => {
  assert.deepEqual(popoverView(st('available')), { phase: 'available', canUpdate: true, progress: null, error: null })
  assert.deepEqual(popoverView(st('checking')), { phase: 'available', canUpdate: false, progress: null, error: null })
  assert.deepEqual(popoverView(st('downloading', { progress: 0.424 })), { phase: 'downloading', canUpdate: false, progress: 42, error: null })
  assert.equal(popoverView(st('downloading')).progress, 0)
  assert.equal(popoverView(st('installing')).phase, 'installing')
  const move = { during: 'update', code: 'move', message: 'dmg', reason: 'dmg' }

  assert.deepEqual(popoverView(st('available', { error: move })).error, move)
  assert.equal(popoverView(st('available', { error: { during: 'check', code: 'network', message: 'x' } })).error, null)
})
