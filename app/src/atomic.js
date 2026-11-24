'use strict'

const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

// Windows can refuse a rename for a moment while another process (a Claude
// session polling the file, an antivirus scan) has the target open.
const RETRY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES'])

const renameWithRetry = async (from, to, tries = 8) => {
  for (let i = 0; ; i++) {
    try {
      await fs.promises.rename(from, to)

      return
    } catch (error) {
      if (i >= tries - 1 || !RETRY_CODES.has(error.code)) {
        throw error
      }
      await sleep(25 * (i + 1))
    }
  }
}

const tempSibling = (file, tag) =>
  path.join(path.dirname(file), `.${path.basename(file)}.${tag}-${process.pid}-${crypto.randomBytes(4).toString('hex')}`)

// Write to a temp file in the same folder, then rename over the target, so a
// reader never sees a half-written file.
const writeFileAtomic = async (file, data) => {
  await fs.promises.mkdir(path.dirname(file), { recursive: true })
  const tmp = tempSibling(file, 'tmp')

  try {
    await fs.promises.writeFile(tmp, data)
    await renameWithRetry(tmp, file)
  } catch (error) {
    await fs.promises.rm(tmp, { force: true }).catch(() => {})
    throw error
  }
}

module.exports = { writeFileAtomic, renameWithRetry, tempSibling }
