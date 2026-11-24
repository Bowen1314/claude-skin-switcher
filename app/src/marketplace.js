'use strict'

const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const { renameWithRetry } = require('./atomic')

// Where the bundled marketplace comes from.
// Packaged: electron-builder's extraResources put it in <resources>/marketplace.
// Dev (npm start): assemble it from the repo, applying the same tests exclusion.
const marketplaceSources = ({ isPackaged, resourcesPath, appDir }) => {
  if (isPackaged) {
    return [{ from: path.join(resourcesPath, 'marketplace'), to: '.' }]
  }
  const root = path.resolve(appDir, '..')

  return [
    { from: path.join(root, '.claude-plugin'), to: '.claude-plugin' },
    { from: path.join(root, 'plugin'), to: 'plugin' },
  ]
}

// The bundled official skins: <marketplace>/plugin/skins.
const bundledSkinsDir = ({ isPackaged, resourcesPath, appDir }) =>
  isPackaged ? path.join(resourcesPath, 'marketplace', 'plugin', 'skins') : path.resolve(appDir, '..', 'plugin', 'skins')

// Skip the plugin's own test folder (and stray OS files) wherever it appears
// directly under a source root.
const keep = (root, src) => {
  const rel = path.relative(root, src)

  if (rel === '') {
    return true
  }
  const parts = rel.split(path.sep)

  if (parts[0] === 'tests' || (parts[0] === 'plugin' && parts[1] === 'tests')) {
    return false
  }

  return !['.DS_Store', 'Thumbs.db'].includes(parts[parts.length - 1])
}

const rand = () => crypto.randomBytes(4).toString('hex')

// Copy into a sibling staging folder, then swap it in by rename, so a Claude
// session starting meanwhile sees the old copy or the new one, never half.
const installMarketplaceCopy = async ({ sources, destDir }) => {
  const parent = path.dirname(destDir)
  const base = path.basename(destDir)
  const staging = path.join(parent, `.${base}.staging-${rand()}`)

  await fs.promises.mkdir(parent, { recursive: true })
  try {
    for (const { from, to } of sources) {
      if (!fs.existsSync(path.join(from))) {
        throw new Error(`Bundled marketplace is missing: ${from}`)
      }
      await fs.promises.cp(from, path.join(staging, to), {
        recursive: true,
        filter: src => keep(from, src),
      })
    }
    if (!fs.existsSync(path.join(staging, '.claude-plugin', 'marketplace.json'))) {
      throw new Error('Bundled marketplace has no .claude-plugin/marketplace.json')
    }
    let old = null

    if (fs.existsSync(destDir)) {
      old = path.join(parent, `.${base}.old-${rand()}`)
      await renameWithRetry(destDir, old)
    }
    try {
      await renameWithRetry(staging, destDir)
    } catch (error) {
      if (old !== null) {
        await renameWithRetry(old, destDir).catch(() => {})
      }
      throw error
    }
    if (old !== null) {
      // Our own previous copy of the bundled files.
      await fs.promises.rm(old, { recursive: true, force: true }).catch(() => {})
    }
  } finally {
    await fs.promises.rm(staging, { recursive: true, force: true }).catch(() => {})
  }

  return destDir
}

module.exports = { bundledSkinsDir, marketplaceSources, installMarketplaceCopy }
