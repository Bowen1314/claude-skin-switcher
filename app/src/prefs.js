'use strict'

// The app's own preferences (language, automatic update checks), kept in a
// small JSON file under Electron's userData. Main process only.

const fs = require('node:fs')

const { writeFileAtomic } = require('./atomic')

const LANGUAGES = new Set(['system', 'en', 'zh'])
const DEFAULTS = Object.freeze({ language: 'system', autoUpdate: true })

const normalizePrefs = raw => {
  const p = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}

  return {
    language: LANGUAGES.has(p.language) ? p.language : DEFAULTS.language,
    autoUpdate: typeof p.autoUpdate === 'boolean' ? p.autoUpdate : DEFAULTS.autoUpdate,
  }
}

// 'system' follows the first preferred system language that is English or
// Chinese; anything else (or nothing) is English.
const resolveLang = (choice, preferred) => {
  if (choice === 'en' || choice === 'zh') {
    return choice
  }
  for (const tag of Array.isArray(preferred) ? preferred : []) {
    const t = String(tag).toLowerCase()

    if (t.startsWith('zh')) {
      return 'zh'
    }
    if (t.startsWith('en')) {
      return 'en'
    }
  }

  return 'en'
}

// file === null keeps everything in memory (screenshot runs).
const createPrefs = ({ file, initial } = {}) => {
  let current = null
  let loading = null
  let writing = Promise.resolve()

  // Read once; later calls share the first read.
  const load = () => {
    loading ??= (async () => {
      let raw = initial ?? null

      if (file) {
        try {
          raw = JSON.parse(await fs.promises.readFile(file, 'utf8'))
        } catch {
          raw = null
        }
      }
      current ??= normalizePrefs(raw)

      return current
    })()

    return loading.then(() => current)
  }

  return {
    load,
    get: () => current ?? normalizePrefs(initial ?? null),
    // Merge, normalize, write atomically (writes are serialized). Returns the new prefs.
    set: async patch => {
      await load()
      // Read `current` after the await, so overlapping calls build on each other.
      const next = normalizePrefs({ ...current, ...patch })

      current = next
      if (file) {
        const text = `${JSON.stringify(next, null, 2)}\n`

        writing = writing.catch(() => {}).then(() => writeFileAtomic(file, text))
        await writing
      }

      return next
    },
  }
}

module.exports = { DEFAULTS, normalizePrefs, resolveLang, createPrefs }
