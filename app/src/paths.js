'use strict'

const path = require('node:path')

const { STATE_DIR_NAME } = require('./constants')

// Always pick the path flavour from the platform we reason about, not the host,
// so the logic is testable for Windows on macOS and vice versa.
const pathFor = platform => (platform === 'win32' ? path.win32 : path.posix)

// Same rule as the bridge mod: USERPROFILE on Windows, HOME elsewhere.
const homeDir = (env, platform, fallback) => {
  const home = platform === 'win32' ? env.USERPROFILE : env.HOME

  return typeof home === 'string' && home !== '' ? home : fallback
}

const stateDir = (home, platform) => pathFor(platform).join(home, STATE_DIR_NAME)

// Claude Code keeps user settings in CLAUDE_CONFIG_DIR when set, else ~/.claude.
const claudeConfigDir = (env, home, platform) => {
  const custom = env.CLAUDE_CONFIG_DIR

  return typeof custom === 'string' && custom !== '' ? custom : pathFor(platform).join(home, '.claude')
}

const userSettingsFile = (env, home, platform) =>
  pathFor(platform).join(claudeConfigDir(env, home, platform), 'settings.json')

// For display only: "/Users/a/.claude/settings.json" -> "~/.claude/settings.json".
const tildify = (file, home, platform) => {
  if (typeof file !== 'string' || !home) {
    return file
  }
  const p = pathFor(platform)
  const rel = p.relative(home, file)

  return rel !== '' && !rel.startsWith('..') && !p.isAbsolute(rel) ? `~${p.sep}${rel}` : file
}

module.exports = { pathFor, homeDir, stateDir, claudeConfigDir, userSettingsFile, tildify }
