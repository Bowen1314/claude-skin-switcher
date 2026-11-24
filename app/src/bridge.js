'use strict'

const fs = require('node:fs')
const path = require('node:path')

const { HEARTBEAT_FRESH_MS } = require('./constants')

const heartbeatFile = dir => path.join(dir, 'bridge.json')

const readHeartbeat = async dir => {
  try {
    const parsed = JSON.parse(await fs.promises.readFile(heartbeatFile(dir), 'utf8'))

    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

// Allow a little clock skew for a heartbeat that claims to be from the future.
const FUTURE_SLACK_MS = 60 * 1000

const isFresh = (heartbeat, now) => {
  const seen = heartbeat?.lastSeen

  return typeof seen === 'number' && Number.isFinite(seen) && now - seen < HEARTBEAT_FRESH_MS && seen - now < FUTURE_SLACK_MS
}

const PLATFORM_LABELS = { macos: 'macOS', windows: 'Windows', linux: 'Linux', ios: 'iOS', android: 'Android' }

const platformLabel = p => (typeof p === 'string' && p !== '' ? (PLATFORM_LABELS[p.toLowerCase()] ?? p) : null)

// Short strings from the last heartbeat, fresh or not ("v0.1.0", "macOS").
const heartbeatInfo = heartbeat => {
  const version = typeof heartbeat?.version === 'string' && /^[\w.+-]{1,32}$/.test(heartbeat.version) ? heartbeat.version : null

  // eslint-disable-next-line no-control-regex
  const error = typeof heartbeat?.error === 'string' && heartbeat.error.trim() !== '' ? heartbeat.error.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 200) : null

  return { version, platform: platformLabel(heartbeat?.platform), error }
}

// state: 'connected' | 'installed' | 'not-installed' | 'checking'
// installed: true | false | null (null = not checked yet)
const bridgeStatus = ({ heartbeat, installed, now }) => {
  const info = heartbeat ? heartbeatInfo(heartbeat) : { version: null, platform: null, error: null }

  if (heartbeat !== null && heartbeat !== undefined && isFresh(heartbeat, now)) {
    const applied = typeof heartbeat.applied === 'string' ? heartbeat.applied : null

    return { state: 'connected', applied, lastSeen: heartbeat.lastSeen, ...info }
  }
  if (installed === true) {
    return { state: 'installed', applied: null, lastSeen: null, ...info }
  }
  if (installed === null || installed === undefined) {
    return { state: 'checking', applied: null, lastSeen: null, ...info }
  }

  return { state: 'not-installed', applied: null, lastSeen: null, ...info }
}

module.exports = { heartbeatFile, readHeartbeat, isFresh, bridgeStatus, heartbeatInfo, platformLabel }
