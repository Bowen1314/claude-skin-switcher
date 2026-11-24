'use strict'

const path = require('node:path')

const { buildInvocation, findClaude, parseJsonOutput, runInvocation } = require('./cli')
const { MARKETPLACE_NAME, PLUGIN_ID } = require('./constants')
const { installMarketplaceCopy } = require('./marketplace')
const { stateDir, userSettingsFile } = require('./paths')
const { enableInSettings, settingsSayInstalled } = require('./settings')

const SCOPES = new Set(['user', 'project', 'local'])

const marketplaceDirFor = (home, platform) => path.join(stateDir(home, platform), 'marketplace')

const manualCommands = marketplaceDir => [
  `claude plugin marketplace add "${marketplaceDir}"`,
  `claude plugin install ${PLUGIN_ID}`,
]

const formatStep = (args, r) =>
  [
    `$ claude ${args.join(' ')}`,
    r.error ? `error: ${r.error}` : `exit ${r.code}`,
    r.stdout.trim(),
    r.stderr.trim(),
  ]
    .filter(Boolean)
    .join('\n')

const findEntry = list => (Array.isArray(list) ? list.find(p => p && p.id === PLUGIN_ID) : undefined)

// Runs the CLI steps. Every step is idempotent (verified against claude 2.1.x):
// - "marketplace add" of a directory already added is a no-op, and re-adding
//   the same name from another path repoints it, so no remove is needed;
// - the plugin is then installed, enabled, or updated depending on what
//   "plugin list --json" reports.
const installViaCli = async ({ claude, cwd, env, platform, run = runInvocation }) => {
  const log = []
  const exec = async args => {
    const r = await run(buildInvocation(claude, args, { platform, cwd, env }))

    log.push(formatStep(args, r))

    return r
  }
  const done = ok => ({ ok, log: log.join('\n\n') })

  // "./marketplace" is resolved against cwd (the state dir); the CLI stores it
  // as an absolute path. Keeping the path off the command line keeps cmd.exe
  // quoting out of the picture on Windows.
  if ((await exec(['plugin', 'marketplace', 'add', './marketplace', '--json'])).code !== 0) {
    return done(false)
  }
  await exec(['plugin', 'marketplace', 'update', MARKETPLACE_NAME, '--json'])

  const listed = await exec(['plugin', 'list', '--json'])
  const entry = listed.code === 0 ? findEntry(parseJsonOutput(listed.stdout)) : undefined

  if (entry === undefined) {
    if ((await exec(['plugin', 'install', PLUGIN_ID, '--scope', 'user', '--json'])).code !== 0) {
      return done(false)
    }
  } else if (entry.enabled !== true) {
    const scope = SCOPES.has(entry.scope) ? ['--scope', entry.scope] : []

    if ((await exec(['plugin', 'enable', PLUGIN_ID, ...scope, '--json'])).code !== 0) {
      return done(false)
    }
  } else {
    await exec(['plugin', 'update', PLUGIN_ID, '--json'])
  }

  const check = await exec(['plugin', 'list', '--json'])
  const after = check.code === 0 ? findEntry(parseJsonOutput(check.stdout)) : undefined

  return done(after !== undefined && after.enabled === true)
}

// Full install: copy the bundled marketplace, then CLI or settings fallback.
// Result: { ok, method: 'cli' | 'settings', log, reason?, backup?, settingsFile?, manual? }
const installBridge = async ({
  home,
  env = process.env,
  platform = process.platform,
  sources,
  find = findClaude,
  run = runInvocation,
  now = Date.now(),
}) => {
  const dir = stateDir(home, platform)
  const marketplaceDir = marketplaceDirFor(home, platform)

  await installMarketplaceCopy({ sources, destDir: marketplaceDir })
  const copied = `Copied bridge files to ${marketplaceDir}`
  const claude = await find({ env, platform, home })

  if (claude !== null) {
    const r = await installViaCli({ claude, cwd: dir, env, platform, run })

    return {
      ok: r.ok,
      method: 'cli',
      log: `${copied}\nUsing ${claude}\n\n${r.log}`,
      manual: r.ok ? undefined : manualCommands(marketplaceDir),
    }
  }

  const settingsFile = userSettingsFile(env, home, platform)
  const r = await enableInSettings({ settingsFile, marketplaceDir, now })

  if (r.ok) {
    return {
      ok: true,
      method: 'settings',
      settingsFile,
      backup: r.backup,
      log: [copied, 'claude CLI not found.', `Updated ${settingsFile}`, r.backup ? `Backup: ${r.backup}` : 'No previous file, nothing to back up.'].join('\n'),
    }
  }

  return {
    ok: false,
    method: 'settings',
    reason: r.reason,
    settingsFile,
    manual: manualCommands(marketplaceDir),
    log: [copied, 'claude CLI not found.', `${settingsFile} left untouched (${r.reason}${r.key ? `: ${r.key}` : ''}).`].join('\n'),
  }
}

// true / false. Uses the CLI when available, else the settings file.
const checkInstalled = async ({
  home,
  env = process.env,
  platform = process.platform,
  find = findClaude,
  run = runInvocation,
}) => {
  const claude = await find({ env, platform, home })

  if (claude !== null) {
    const r = await run(buildInvocation(claude, ['plugin', 'list', '--json'], { platform, cwd: home, env, timeoutMs: 30000 }))
    const list = r.code === 0 ? parseJsonOutput(r.stdout) : undefined

    if (Array.isArray(list)) {
      return findEntry(list)?.enabled === true
    }
  }

  return settingsSayInstalled(userSettingsFile(env, home, platform))
}

module.exports = { installBridge, installViaCli, checkInstalled, manualCommands, marketplaceDirFor }
