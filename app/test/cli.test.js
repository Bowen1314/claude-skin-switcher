'use strict'

const assert = require('node:assert/strict')
const path = require('node:path')
const test = require('node:test')

const { buildInvocation, childEnv, findClaude, parseJsonOutput } = require('../src/cli')
const { homeDir, stateDir, userSettingsFile } = require('../src/paths')

const W = path.win32
const P = path.posix
const noShell = async () => null

test('homeDir follows the bridge mod: USERPROFILE on Windows, HOME elsewhere', () => {
  assert.equal(homeDir({ HOME: '/Users/a', USERPROFILE: 'C:\\Users\\b' }, 'darwin', '/x'), '/Users/a')
  assert.equal(homeDir({ HOME: '/Users/a', USERPROFILE: 'C:\\Users\\b' }, 'win32', 'C:\\x'), 'C:\\Users\\b')
  assert.equal(homeDir({}, 'win32', 'C:\\x'), 'C:\\x')
  assert.equal(stateDir('C:\\Users\\b', 'win32'), 'C:\\Users\\b\\.claude-theme-switcher')
  assert.equal(stateDir('/Users/a', 'darwin'), '/Users/a/.claude-theme-switcher')
  assert.equal(userSettingsFile({}, '/Users/a', 'darwin'), '/Users/a/.claude/settings.json')
  assert.equal(userSettingsFile({ CLAUDE_CONFIG_DIR: '/cfg' }, '/Users/a', 'darwin'), '/cfg/settings.json')
  assert.equal(userSettingsFile({}, 'C:\\Users\\b', 'win32'), 'C:\\Users\\b\\.claude\\settings.json')
})

test('PATH lookup wins first (macOS)', async () => {
  const files = new Set(['/usr/local/bin/claude', '/opt/tools/claude'])
  const found = await findClaude({
    env: { PATH: '/usr/bin:relative/dir:/opt/tools' },
    platform: 'darwin',
    home: '/Users/a',
    exists: f => files.has(f),
    loginShellLookup: noShell,
  })

  assert.equal(found, '/opt/tools/claude')
})

test('common spots in order when PATH has nothing (macOS)', async () => {
  const seen = []
  const files = new Set(['/opt/homebrew/bin/claude', '/usr/local/bin/claude'])
  const found = await findClaude({
    env: { PATH: '/usr/bin:/bin' },
    platform: 'darwin',
    home: '/Users/a',
    exists: f => {
      seen.push(f)

      return files.has(f)
    },
    loginShellLookup: noShell,
  })

  assert.equal(found, '/opt/homebrew/bin/claude')
  assert.ok(seen.indexOf(P.join('/Users/a', '.local', 'bin', 'claude')) < seen.indexOf('/opt/homebrew/bin/claude'))
})

test('macOS falls back to the login shell, and checks what it returns', async () => {
  let asked = 0
  const shell = async () => {
    asked++

    return '/Users/a/.nvm/versions/node/v22/bin/claude'
  }

  assert.equal(
    await findClaude({ env: { PATH: '/usr/bin' }, platform: 'darwin', home: '/Users/a', exists: f => f.includes('.nvm'), loginShellLookup: shell }),
    '/Users/a/.nvm/versions/node/v22/bin/claude',
  )
  assert.equal(await findClaude({ env: { PATH: '/usr/bin' }, platform: 'darwin', home: '/Users/a', exists: () => false, loginShellLookup: shell }), null)
  assert.equal(asked, 2)
})

test('login shell is not consulted on Windows or Linux', async () => {
  const shell = async () => {
    throw new Error('should not be called')
  }

  assert.equal(await findClaude({ env: {}, platform: 'linux', home: '/home/a', exists: () => false, loginShellLookup: shell }), null)
  assert.equal(await findClaude({ env: {}, platform: 'win32', home: 'C:\\Users\\a', exists: () => false, loginShellLookup: shell }), null)
})

test('Windows: Path key is case-insensitive, .exe preferred over .cmd in the same dir', async () => {
  const files = new Set(['D:\\tools\\claude.exe', 'D:\\tools\\claude.cmd'])
  const found = await findClaude({
    env: { Path: 'C:\\Windows;"D:\\tools"' },
    platform: 'win32',
    home: 'C:\\Users\\a',
    exists: f => files.has(f),
    loginShellLookup: noShell,
  })

  assert.equal(found, 'D:\\tools\\claude.exe')
})

test('Windows: common spots are ~/.local/bin/claude.exe then %APPDATA%\\npm\\claude.cmd', async () => {
  const env = { Path: 'C:\\Windows', APPDATA: 'C:\\Users\\a\\AppData\\Roaming' }
  const npm = W.join(env.APPDATA, 'npm', 'claude.cmd')
  const local = W.join('C:\\Users\\a', '.local', 'bin', 'claude.exe')

  assert.equal(await findClaude({ env, platform: 'win32', home: 'C:\\Users\\a', exists: f => f === npm, loginShellLookup: noShell }), npm)
  assert.equal(
    await findClaude({ env, platform: 'win32', home: 'C:\\Users\\a', exists: f => f === npm || f === local, loginShellLookup: noShell }),
    local,
  )
})

test('buildInvocation: plain executable runs directly, stdin ignored, with a timeout', () => {
  const inv = buildInvocation('/Users/a/.local/bin/claude', ['plugin', 'list', '--json'], { platform: 'darwin', cwd: '/tmp/x', env: { PATH: '/usr/bin' } })

  assert.equal(inv.file, '/Users/a/.local/bin/claude')
  assert.deepEqual(inv.args, ['plugin', 'list', '--json'])
  assert.deepEqual(inv.options.stdio, ['ignore', 'pipe', 'pipe'])
  assert.equal(inv.options.cwd, '/tmp/x')
  assert.ok(inv.options.timeoutMs > 0)
  assert.equal(inv.options.env.PATH.split(':')[0], '/Users/a/.local/bin')
  assert.equal(inv.options.windowsVerbatimArguments, undefined)
})

test('buildInvocation: Windows .exe runs directly', () => {
  const inv = buildInvocation('C:\\Users\\a b\\.local\\bin\\claude.exe', ['plugin', 'list'], { platform: 'win32', cwd: 'C:\\x', env: { Path: 'C:\\Windows' } })

  assert.equal(inv.file, 'C:\\Users\\a b\\.local\\bin\\claude.exe')
  assert.deepEqual(inv.args, ['plugin', 'list'])
  assert.equal(inv.options.env.Path, 'C:\\Users\\a b\\.local\\bin;C:\\Windows')
  assert.equal(inv.options.env.PATH, undefined)
})

test('buildInvocation: Windows .cmd goes through cmd.exe with the shim found via PATH, not its full path', () => {
  const shim = 'C:\\Users\\O&Brien %X%\\AppData\\Roaming\\npm\\claude.cmd'
  const inv = buildInvocation(shim, ['plugin', 'marketplace', 'add', './marketplace', '--json'], {
    platform: 'win32',
    cwd: 'C:\\Users\\O&Brien %X%\\.claude-theme-switcher',
    env: { Path: 'C:\\Windows', ComSpec: 'C:\\Windows\\system32\\cmd.exe' },
  })

  assert.equal(inv.file, 'C:\\Windows\\system32\\cmd.exe')
  assert.deepEqual(inv.args, ['/d', '/s', '/c', 'claude.cmd plugin marketplace add ./marketplace --json'])
  assert.equal(inv.options.windowsVerbatimArguments, true)
  assert.ok(!inv.args.join(' ').includes('O&Brien'))
  assert.equal(inv.options.env.Path.split(';')[0], 'C:\\Users\\O&Brien %X%\\AppData\\Roaming\\npm')
})

test('buildInvocation refuses arguments that would need quoting', () => {
  for (const bad of ['a b', 'x&y', '"q"', '%PATH%', 'a|b', '^']) {
    assert.throws(() => buildInvocation('C:\\npm\\claude.cmd', ['plugin', bad], { platform: 'win32', env: {} }), /unsafe/)
  }
  assert.throws(() => buildInvocation('C:\\my tools\\cl aude.cmd', ['plugin'], { platform: 'win32', env: {} }), /unsafe/)
})

test('childEnv on macOS adds Homebrew dirs for a node-shebang claude', () => {
  const env = childEnv('/Users/a/.local/bin/claude', { PATH: '/usr/bin:/bin' }, 'darwin')

  assert.equal(env.PATH, '/Users/a/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin')
})

test('parseJsonOutput handles whole-JSON and last-line JSON', () => {
  assert.deepEqual(parseJsonOutput('[\n {"id":"x"}\n]\n'), [{ id: 'x' }])
  assert.deepEqual(parseJsonOutput('Validating\n{"outcome":"ok"}\n'), { outcome: 'ok' })
  assert.equal(parseJsonOutput(''), undefined)
  assert.equal(parseJsonOutput('nope'), undefined)
})

test('tildify shortens paths under home for display only', () => {
  const { tildify } = require('../src/paths')

  assert.equal(tildify('/Users/a/.claude/settings.json', '/Users/a', 'darwin'), '~/.claude/settings.json')
  assert.equal(tildify('/cfg/settings.json', '/Users/a', 'darwin'), '/cfg/settings.json')
  assert.equal(tildify('/Users/ab/x', '/Users/a', 'darwin'), '/Users/ab/x')
  assert.equal(tildify('C:\\Users\\a\\.claude\\settings.json', 'C:\\Users\\a', 'win32'), '~\\.claude\\settings.json')
  assert.equal(tildify(undefined, '/Users/a', 'darwin'), undefined)
})
