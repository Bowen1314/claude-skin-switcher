'use strict'

const path = require('node:path')

const { loadDeps } = require('../src/deps')

let cached
const deps = () => (cached ??= loadDeps({ isPackaged: false, appDir: path.join(__dirname, '..') }))

module.exports = { deps }
