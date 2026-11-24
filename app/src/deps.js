'use strict'

const path = require('node:path')
const { pathToFileURL } = require('node:url')

// The skin validator (shared/) and the design system's makeColors (plugin/)
// are plain ESM files outside app/. In a packaged build electron-builder copies
// them into <resources>/shared/ as .mjs so they always load as ESM.
const depPaths = ({ isPackaged = false, resourcesPath, appDir }) => {
  if (isPackaged) {
    return {
      validator: path.join(resourcesPath, 'shared', 'skin-validate.mjs'),
      makeColors: path.join(resourcesPath, 'shared', 'make-colors.mjs'),
    }
  }
  const root = path.resolve(appDir, '..')

  return {
    validator: path.join(root, 'shared', 'skin-validate.js'),
    makeColors: path.join(root, 'plugin', 'hooks', 'make-colors.js'),
  }
}

// import() needs a file URL: a bare "C:\..." path is read as a URL scheme.
const importFile = file => import(pathToFileURL(file).href)

const loadDeps = async opts => {
  const paths = depPaths(opts)
  const [validator, colors] = await Promise.all([importFile(paths.validator), importFile(paths.makeColors)])

  return {
    validateSkin: validator.validateSkin,
    validateScene: validator.validateScene,
    SKIN_LIMITS: validator.SKIN_LIMITS,
    makeColors: colors.makeColors,
  }
}

module.exports = { depPaths, importFile, loadDeps }
