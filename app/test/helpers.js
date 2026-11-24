'use strict'

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const tempDir = t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cts-test-'))

  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))

  return dir
}

module.exports = { tempDir }
