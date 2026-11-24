'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const { checkInstalled, installBridge, installViaCli } = require('../src/installer')
const { installMarketplaceCopy, marketplaceSources } = require('../src/marketplace')
const { tempDir } = require('./helpers')

const ID = 'theme-switcher@claude-theme-switcher'
const APP_DIR = path.join(__dirname, '..')
const devSources = () => marketplaceSources({ isPackaged: false, appDir: APP_DIR })

// A fake claude CLI that keeps state like the real one (behaviour recorded
// from claude 2.1.327 in an isolated config dir).
const fakeCli = ({ plugin = null, failOn = null } = {}) => {
  const calls = []
  const state = { plugin }
  const ok = stdout => ({ code: 0, stdout, stderr: '', error: null })
  const run = async inv => {
    const args = inv.args[0] === '/d' ? inv.args[3].split(' ').slice(1) : inv.args
    const line = args.join(' ')

    calls.push(line)
    if (failOn && line.startsWith(failOn)) {
      return { code: 1, stdout: '', stderr: 'boom', error: null }
    }
    if (line.startsWith('plugin list')) {
      return ok(JSON.stringify(state.plugin ? [{ id: ID, scope: 'user', ...state.plugin }] : []))
    }
    if (line.startsWith('plugin install')) {
      state.plugin = { enabled: true }
    }
    if (line.startsWith('plugin enable')) {
      state.plugin.enabled = true
    }

    return ok('{"outcome":"ok"}')
  }

  return { run, calls, state }
}

test('fresh install: add, refresh, list, install, verify', async () => {
  const cli = fakeCli()
  const r = await installViaCli({ claude: '/bin/claude', cwd: '/tmp/s', env: {}, platform: 'darwin', run: cli.run })

  assert.equal(r.ok, true)
  assert.deepEqual(cli.calls, [
    'plugin marketplace add ./marketplace --json',
    'plugin marketplace update claude-theme-switcher --json',
    'plugin list --json',
    `plugin install ${ID} --scope user --json`,
    'plugin list --json',
  ])
  assert.match(r.log, /\$ claude plugin install/)
})

test('already installed and enabled: update instead of install', async () => {
  const cli = fakeCli({ plugin: { enabled: true } })
  const r = await installViaCli({ claude: '/bin/claude', cwd: '/tmp/s', env: {}, platform: 'darwin', run: cli.run })

  assert.equal(r.ok, true)
  assert.ok(cli.calls.includes(`plugin update ${ID} --json`))
  assert.ok(!cli.calls.some(c => c.startsWith('plugin install')))
})

test('installed but disabled: enable in its scope', async () => {
  const cli = fakeCli({ plugin: { enabled: false } })
  const r = await installViaCli({ claude: '/bin/claude', cwd: '/tmp/s', env: {}, platform: 'darwin', run: cli.run })

  assert.equal(r.ok, true)
  assert.ok(cli.calls.includes(`plugin enable ${ID} --scope user --json`))
})

test('a failing marketplace add stops and reports', async () => {
  const cli = fakeCli({ failOn: 'plugin marketplace add' })
  const r = await installViaCli({ claude: '/bin/claude', cwd: '/tmp/s', env: {}, platform: 'darwin', run: cli.run })

  assert.equal(r.ok, false)
  assert.equal(cli.calls.length, 1)
  assert.match(r.log, /boom/)
})

test('Windows .cmd path runs through cmd.exe with the same steps', async () => {
  const cli = fakeCli()
  const r = await installViaCli({ claude: 'C:\\npm\\claude.cmd', cwd: 'C:\\h\\.claude-theme-switcher', env: { Path: 'C:\\Windows' }, platform: 'win32', run: cli.run })

  assert.equal(r.ok, true)
  assert.equal(cli.calls[0], 'plugin marketplace add ./marketplace --json')
})

test('installBridge copies the marketplace (without plugin tests) and uses the CLI', async t => {
  const home = tempDir(t)
  const cli = fakeCli()
  const r = await installBridge({ home, env: {}, platform: process.platform, sources: devSources(), find: async () => '/bin/claude', run: cli.run })
  const market = path.join(home, '.claude-theme-switcher', 'marketplace')

  assert.equal(r.ok, true)
  assert.equal(r.method, 'cli')
  assert.ok(fs.existsSync(path.join(market, '.claude-plugin', 'marketplace.json')))
  assert.ok(fs.existsSync(path.join(market, 'plugin', '.claude-plugin', 'plugin.json')))
  assert.ok(fs.existsSync(path.join(market, 'plugin', 'hooks', 'register.tsx')))
  assert.equal(fs.existsSync(path.join(market, 'plugin', 'tests')), false)
  assert.deepEqual(fs.readdirSync(path.join(home, '.claude-theme-switcher')), ['marketplace'])
})

test('reinstall replaces an older copy completely', async t => {
  const home = tempDir(t)
  const market = path.join(home, '.claude-theme-switcher', 'marketplace')

  fs.mkdirSync(path.join(market, 'plugin'), { recursive: true })
  fs.writeFileSync(path.join(market, 'plugin', 'stale.txt'), 'old')
  await installMarketplaceCopy({ sources: devSources(), destDir: market })
  assert.equal(fs.existsSync(path.join(market, 'plugin', 'stale.txt')), false)
  assert.ok(fs.existsSync(path.join(market, 'plugin', 'hooks', 'register.tsx')))
  assert.deepEqual(fs.readdirSync(path.dirname(market)), ['marketplace'])
})

test('no CLI: falls back to settings.json in the temp home', async t => {
  const home = tempDir(t)
  const env = process.platform === 'win32' ? { USERPROFILE: home } : { HOME: home }
  const r = await installBridge({ home, env, platform: process.platform, sources: devSources(), find: async () => null, run: assert.fail })
  const settingsFile = path.join(home, '.claude', 'settings.json')

  assert.equal(r.ok, true)
  assert.equal(r.method, 'settings')
  assert.equal(r.settingsFile, settingsFile)
  const s = JSON.parse(fs.readFileSync(settingsFile, 'utf8'))

  assert.deepEqual(s.extraKnownMarketplaces['claude-theme-switcher'].source, {
    source: 'directory',
    path: path.join(home, '.claude-theme-switcher', 'marketplace'),
  })
  assert.equal(s.enabledPlugins[ID], true)
  assert.equal(await checkInstalled({ home, env, platform: process.platform, find: async () => null }), true)
})

test('no CLI and broken settings.json: untouched, manual commands offered', async t => {
  const home = tempDir(t)
  const settingsFile = path.join(home, '.claude', 'settings.json')

  fs.mkdirSync(path.dirname(settingsFile))
  fs.writeFileSync(settingsFile, '{,}')
  const r = await installBridge({ home, env: {}, platform: process.platform, sources: devSources(), find: async () => null, run: assert.fail })

  assert.equal(r.ok, false)
  assert.equal(r.reason, 'invalid-json')
  assert.equal(fs.readFileSync(settingsFile, 'utf8'), '{,}')
  assert.equal(r.manual.length, 2)
  assert.match(r.manual[0], /^claude plugin marketplace add ".+marketplace"$/)
  assert.equal(r.manual[1], `claude plugin install ${ID}`)
})

test('checkInstalled reads plugin list --json when the CLI exists', async () => {
  assert.equal(await checkInstalled({ home: '/h', env: {}, platform: 'darwin', find: async () => '/bin/claude', run: fakeCli({ plugin: { enabled: true } }).run }), true)
  assert.equal(await checkInstalled({ home: '/h', env: {}, platform: 'darwin', find: async () => '/bin/claude', run: fakeCli({ plugin: { enabled: false } }).run }), false)
  assert.equal(await checkInstalled({ home: '/h', env: {}, platform: 'darwin', find: async () => '/bin/claude', run: fakeCli().run }), false)
})
