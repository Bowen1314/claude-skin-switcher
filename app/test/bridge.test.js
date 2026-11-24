'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const test = require('node:test')

const { bridgeStatus, heartbeatFile, heartbeatInfo, platformLabel, readHeartbeat } = require('../src/bridge')
const { tempDir } = require('./helpers')

const NOW = 1_800_000_000_000
const beat = (agoMs, applied = 'graphite-circuit') => ({ version: '0.1.0', platform: 'macos', lastSeen: NOW - agoMs, applied })

test('fresh heartbeat means connected, with the applied theme', () => {
  assert.deepEqual(bridgeStatus({ heartbeat: beat(30_000), installed: false, now: NOW }), {
    state: 'connected',
    applied: 'graphite-circuit',
    lastSeen: NOW - 30_000,
    version: '0.1.0',
    platform: 'macOS',
    error: null,
  })
  assert.equal(bridgeStatus({ heartbeat: beat(179_999), installed: null, now: NOW }).state, 'connected')
})

test('applied null is reported as null', () => {
  const s = bridgeStatus({ heartbeat: beat(1000, null), installed: true, now: NOW })

  assert.equal(s.state, 'connected')
  assert.equal(s.applied, null)
})

test('stale heartbeat falls back to the install check', () => {
  assert.equal(bridgeStatus({ heartbeat: beat(180_000), installed: true, now: NOW }).state, 'installed')
  assert.equal(bridgeStatus({ heartbeat: beat(10 * 60_000), installed: false, now: NOW }).state, 'not-installed')
  assert.equal(bridgeStatus({ heartbeat: beat(10 * 60_000), installed: null, now: NOW }).state, 'checking')
})

test('no heartbeat', () => {
  assert.equal(bridgeStatus({ heartbeat: null, installed: true, now: NOW }).state, 'installed')
  assert.equal(bridgeStatus({ heartbeat: null, installed: false, now: NOW }).state, 'not-installed')
})

test('malformed or far-future lastSeen is not fresh', () => {
  for (const lastSeen of ['123', null, Number.NaN, NOW + 5 * 60_000]) {
    assert.equal(bridgeStatus({ heartbeat: { lastSeen }, installed: false, now: NOW }).state, 'not-installed')
  }
})

test('readHeartbeat tolerates missing and broken files', async t => {
  const dir = tempDir(t)

  assert.equal(await readHeartbeat(dir), null)
  fs.writeFileSync(heartbeatFile(dir), 'garbage')
  assert.equal(await readHeartbeat(dir), null)
  fs.writeFileSync(heartbeatFile(dir), '[1,2]')
  assert.equal(await readHeartbeat(dir), null)
  fs.writeFileSync(heartbeatFile(dir), JSON.stringify(beat(0)))
  assert.deepEqual(await readHeartbeat(dir), beat(0))
})

test('heartbeat info is kept even when stale, and sanitised', () => {
  const s = bridgeStatus({ heartbeat: { ...beat(60 * 60_000), platform: 'windows' }, installed: true, now: NOW })

  assert.equal(s.state, 'installed')
  assert.equal(s.version, '0.1.0')
  assert.equal(s.platform, 'Windows')
  assert.deepEqual(bridgeStatus({ heartbeat: null, installed: false, now: NOW }).version, null)
  assert.deepEqual(heartbeatInfo({ version: '<script>', platform: 7 }), { version: null, platform: null, error: null })
  assert.equal(heartbeatInfo({ error: 'scene.svg: bad\nthing' }).error, 'scene.svg: bad thing')
  assert.equal(heartbeatInfo({ error: 'x'.repeat(500) }).error.length, 200)
  assert.equal(bridgeStatus({ heartbeat: { ...beat(1000), error: 'skin not found' }, installed: true, now: NOW }).error, 'skin not found')
  assert.equal(platformLabel('macos'), 'macOS')
  assert.equal(platformLabel('freebsd'), 'freebsd')
  assert.equal(platformLabel(''), null)
})
