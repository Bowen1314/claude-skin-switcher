'use strict'

// selection.json, format of docs/skin-format.md:
//   { "theme": "<ref>" | "default", "settings": { "<ref>": { ...universal, vars } } }
// Written atomically; every write goes through one read-modify-write queue so a
// debounced settings save and an Apply never overwrite each other.

const fs = require('node:fs')
const path = require('node:path')

const { writeFileAtomic } = require('./atomic')
const { ALIASES, REF } = require('./skin-render')

const selectionFile = dir => path.join(dir, 'selection.json')

const isObject = v => typeof v === 'object' && v !== null && !Array.isArray(v)

const isThemeRef = id => id === 'default' || (typeof id === 'string' && REF.test(id))

// The theme a raw value names, with the 0.1 ids mapped to their refs.
const themeOf = raw => {
  const id = typeof raw === 'string' ? (ALIASES[raw] ?? raw) : null

  return isThemeRef(id) ? id : null
}

// { exists, theme, settings }. Never writes. A missing or broken file reads as
// { exists: false } / theme null: "leave Claude's look alone".
const readSelection = async dir => {
  let text

  try {
    text = await fs.promises.readFile(selectionFile(dir), 'utf8')
  } catch {
    return { exists: false, theme: null, settings: {} }
  }
  try {
    const parsed = JSON.parse(text)
    const settings = {}

    if (isObject(parsed) && isObject(parsed.settings)) {
      for (const [ref, value] of Object.entries(parsed.settings)) {
        if (REF.test(ref) && isObject(value)) {
          settings[ref] = value
        }
      }
    }

    return { exists: true, theme: isObject(parsed) ? themeOf(parsed.theme) : null, settings }
  } catch {
    return { exists: true, theme: null, settings: {} }
  }
}

// `theme` is left out when nothing was applied yet: the bridge acts only on a
// string theme, so tuning before the first Apply never changes Claude's look.
const serialize = ({ theme, settings }) => {
  const body = theme === null ? {} : { theme }

  if (settings && Object.keys(settings).length > 0) {
    body.settings = settings
  }

  return `${JSON.stringify(body, null, 2)}\n`
}

const createSelectionStore = dir => {
  let queue = Promise.resolve()

  // fn(current) -> next { theme, settings } or null to leave the file alone.
  const mutate = fn => {
    const run = queue.then(async () => {
      const current = await readSelection(dir)
      const next = await fn(current)

      if (next === null || next === undefined) {
        return current
      }
      if (next.theme !== null && !isThemeRef(next.theme)) {
        throw new Error(`Unknown theme: ${String(next.theme)}`)
      }
      await writeFileAtomic(selectionFile(dir), serialize(next))

      return next
    })

    queue = run.catch(() => {})

    return run
  }

  return {
    read: () => readSelection(dir),
    setTheme: ref => {
      if (!isThemeRef(ref)) {
        return Promise.reject(new Error(`Unknown theme: ${String(ref)}`))
      }

      return mutate(cur => ({ theme: ref, settings: cur.settings }))
    },
    // Apply: theme and that skin's settings in one atomic write. `sparse` must
    // already be checked against the skin; an empty object removes the entry.
    applyTheme: (ref, sparse) => {
      if (!REF.test(ref)) {
        return Promise.reject(new Error(`Not a skin: ${String(ref)}`))
      }

      return mutate(cur => {
        const settings = { ...cur.settings }

        if (sparse && Object.keys(sparse).length > 0) {
          settings[ref] = sparse
        } else {
          delete settings[ref]
        }

        return { theme: ref, settings }
      })
    },
    // Settings for one ref; `normalized` must already be checked against the skin.
    setSettings: (ref, normalized) => {
      if (!REF.test(ref)) {
        return Promise.reject(new Error(`Not a skin: ${String(ref)}`))
      }

      return mutate(cur => ({ theme: cur.theme, settings: { ...cur.settings, [ref]: normalized } }))
    },
    resetSettings: ref =>
      mutate(cur => {
        if (!(ref in cur.settings)) {
          return null
        }
        const settings = { ...cur.settings }

        delete settings[ref]

        return { theme: cur.theme, settings }
      }),
    // Before a skin is deleted: back to Claude's default if it is the active
    // theme, and drop its settings, in one atomic write. Resolves to whether
    // the theme was switched.
    forget: ref => {
      let switched = false

      return mutate(cur => {
        if (cur.theme !== ref && !(ref in cur.settings)) {
          return null
        }
        const settings = { ...cur.settings }

        delete settings[ref]
        switched = cur.theme === ref

        return { theme: switched ? 'default' : cur.theme, settings }
      }).then(() => switched)
    },
    // A skin now lives under another ref (a library skin merged into its
    // upload): the theme and its settings follow it in one atomic write. The
    // old ref's settings win; settings of `to` stay when `from` has none, so a
    // repeat after a crash never drops what was already moved. Resolves to
    // whether the file changed.
    moveRef: (from, to) => {
      if (!REF.test(from) || !REF.test(to)) {
        return Promise.reject(new Error(`Not a skin: ${String(REF.test(from) ? to : from)}`))
      }
      let changed = false

      return mutate(cur => {
        if (cur.theme !== from && !(from in cur.settings)) {
          return null
        }
        const settings = { ...cur.settings }

        if (from in settings) {
          settings[to] = settings[from]
          delete settings[from]
        }
        changed = true

        return { theme: cur.theme === from ? to : cur.theme, settings }
      }).then(() => changed)
    },
    // After a skin's files change: rewrite (new mtime) only if the file exists
    // and names that skin, so the bridge reloads it.
    touchIfActive: ref => mutate(cur => (cur.exists && cur.theme === ref ? { theme: cur.theme, settings: cur.settings } : null)),
    idle: () => queue,
  }
}

module.exports = { selectionFile, readSelection, createSelectionStore, isThemeRef, themeOf }
