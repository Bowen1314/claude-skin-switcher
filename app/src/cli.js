'use strict'

const { spawn } = require('node:child_process')
const fs = require('node:fs')

const { pathFor } = require('./paths')

// ---------- discovery ----------

const defaultExists = (file, platform = process.platform) => {
  try {
    if (!fs.statSync(file).isFile()) {
      return false
    }
    if (platform !== 'win32') {
      fs.accessSync(file, fs.constants.X_OK)
    }

    return true
  } catch {
    return false
  }
}

// Environment keys are case-insensitive on Windows ("Path" vs "PATH").
const envKey = (env, name, platform) => {
  if (platform !== 'win32') {
    return name
  }
  const found = Object.keys(env).find(k => k.toUpperCase() === name.toUpperCase())

  return found ?? name
}

const getEnv = (env, name, platform) => env[envKey(env, name, platform)]

const executableNames = platform => (platform === 'win32' ? ['claude.exe', 'claude.cmd'] : ['claude'])

const pathCandidates = (env, platform) => {
  const p = pathFor(platform)
  const raw = getEnv(env, 'PATH', platform) ?? ''
  const dirs = raw
    .split(platform === 'win32' ? ';' : ':')
    .map(d => d.trim().replace(/^"(.*)"$/, '$1'))
    .filter(d => d !== '' && p.isAbsolute(d))
  const out = []

  for (const dir of dirs) {
    for (const name of executableNames(platform)) {
      out.push(p.join(dir, name))
    }
  }

  return out
}

const commonCandidates = (env, platform, home) => {
  const p = pathFor(platform)

  if (platform === 'win32') {
    const out = []

    if (home) {
      out.push(p.join(home, '.local', 'bin', 'claude.exe'))
    }
    const appData = getEnv(env, 'APPDATA', platform)

    if (appData) {
      out.push(p.join(appData, 'npm', 'claude.cmd'))
    }

    return out
  }
  const out = []

  if (home) {
    out.push(p.join(home, '.local', 'bin', 'claude'))
  }
  out.push('/opt/homebrew/bin/claude', '/usr/local/bin/claude')

  return out
}

// Finder-launched apps on macOS get a minimal PATH, so ask the user's login
// shell where claude lives. The command string is fixed; nothing user-supplied.
const defaultLoginShellLookup = env =>
  new Promise(resolve => {
    const shell = env.SHELL && env.SHELL.startsWith('/') ? env.SHELL : '/bin/zsh'
    const child = spawn(shell, ['-lc', 'command -v claude'], {
      env,
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
    })
    let out = ''

    child.stdout.on('data', d => {
      out += d
    })
    child.on('error', () => resolve(null))
    child.on('close', () => {
      const line = out.trim().split('\n').pop() ?? ''

      resolve(line.startsWith('/') ? line : null)
    })
  })

const findClaude = async ({
  env = process.env,
  platform = process.platform,
  home,
  exists = file => defaultExists(file, platform),
  loginShellLookup = defaultLoginShellLookup,
} = {}) => {
  for (const file of [...pathCandidates(env, platform), ...commonCandidates(env, platform, home)]) {
    if (exists(file)) {
      return file
    }
  }
  if (platform === 'darwin') {
    const found = await loginShellLookup(env)

    if (found && exists(found)) {
      return found
    }
  }

  return null
}

// ---------- invocation ----------

// Arguments we pass to claude are fixed words plus "./marketplace" and the
// plugin id. Anything else is refused rather than quoted for cmd.exe.
const SAFE_ARG = /^[A-Za-z0-9@._/:=-]+$/

const isBatch = file => /\.(cmd|bat)$/i.test(file)

const childEnv = (claudePath, env, platform) => {
  const p = pathFor(platform)
  const key = envKey(env, 'PATH', platform)
  const sep = platform === 'win32' ? ';' : ':'
  const extra = [p.dirname(claudePath)]

  if (platform === 'darwin') {
    // An npm-installed claude is a "#!/usr/bin/env node" script; give it a PATH
    // where Homebrew's node can be found.
    extra.push('/opt/homebrew/bin', '/usr/local/bin')
  }

  return { ...env, [key]: [...extra, env[key] ?? ''].filter(Boolean).join(sep) }
}

// Builds { file, args, options } for spawn. On Windows a .cmd shim cannot be
// spawned directly, so it runs through cmd.exe with only safe, unquoted words
// on the command line: the shim is called by its bare name and found through
// PATH (its folder is prepended), and paths are relative to cwd.
const buildInvocation = (claudePath, args, { platform = process.platform, cwd, env = process.env, timeoutMs = 120000 } = {}) => {
  for (const a of args) {
    if (!SAFE_ARG.test(a)) {
      throw new Error(`Refusing unsafe argument: ${a}`)
    }
  }
  const options = {
    cwd,
    env: childEnv(claudePath, env, platform),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    timeoutMs,
  }

  if (platform === 'win32' && isBatch(claudePath)) {
    const name = pathFor(platform).basename(claudePath)

    if (!SAFE_ARG.test(name)) {
      throw new Error(`Refusing unsafe command name: ${name}`)
    }
    const comspec = getEnv(env, 'ComSpec', platform)

    return {
      file: comspec && pathFor(platform).isAbsolute(comspec) ? comspec : 'cmd.exe',
      args: ['/d', '/s', '/c', [name, ...args].join(' ')],
      options: { ...options, windowsVerbatimArguments: true },
    }
  }

  return { file: claudePath, args: args.slice(), options }
}

const runInvocation = ({ file, args, options }) =>
  new Promise(resolve => {
    const { timeoutMs, ...spawnOptions } = options
    let stdout = ''
    let stderr = ''
    let settled = false
    let child

    const finish = result => {
      if (!settled) {
        settled = true
        clearTimeout(timer)
        resolve({ stdout, stderr, ...result })
      }
    }
    const timer = setTimeout(() => {
      child?.kill()
      finish({ code: null, error: `Timed out after ${Math.round(timeoutMs / 1000)} s` })
    }, timeoutMs)

    try {
      child = spawn(file, args, spawnOptions)
    } catch (error) {
      finish({ code: null, error: String(error.message ?? error) })

      return
    }
    child.stdout.on('data', d => {
      stdout += d
    })
    child.stderr.on('data', d => {
      stderr += d
    })
    child.on('error', error => finish({ code: null, error: String(error.message ?? error) }))
    child.on('close', code => finish({ code, error: null }))
  })

// --json output from the CLI: either the whole stdout is JSON (list commands)
// or the last line is (add/install/update).
const parseJsonOutput = stdout => {
  const text = String(stdout ?? '').trim()

  if (text === '') {
    return undefined
  }
  try {
    return JSON.parse(text)
  } catch {
    const last = text.split(/\r?\n/).pop()

    try {
      return JSON.parse(last)
    } catch {
      return undefined
    }
  }
}

module.exports = {
  defaultExists,
  pathCandidates,
  commonCandidates,
  findClaude,
  buildInvocation,
  runInvocation,
  parseJsonOutput,
  childEnv,
}
