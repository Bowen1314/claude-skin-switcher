'use strict'

// The Google refresh token, encrypted with Electron's safeStorage in userData.
// safeStorage is touched lazily: only when a token file exists or a token is
// being saved, so people who never sign in never reach the keychain.

const fs = require('node:fs')
const path = require('node:path')

const { writeFileAtomic } = require('./atomic')

const createTokenStore = ({ file, getSafeStorage }) => {
  let memo // undefined = not loaded yet

  return {
    // The token, or null. Never throws.
    load: async () => {
      if (memo !== undefined) {
        return memo
      }
      if (!fs.existsSync(file)) {
        memo = null

        return memo
      }
      try {
        const safe = getSafeStorage()

        memo = safe.isEncryptionAvailable() ? safe.decryptString(await fs.promises.readFile(file)) || null : null
      } catch {
        memo = null
      }

      return memo
    },
    // { ok, persisted }. Without OS encryption the token is kept for this run only.
    save: async token => {
      memo = token
      const safe = getSafeStorage()

      if (!safe.isEncryptionAvailable()) {
        return { ok: true, persisted: false }
      }
      await fs.promises.mkdir(path.dirname(file), { recursive: true })
      await writeFileAtomic(file, safe.encryptString(token))
      await fs.promises.chmod(file, 0o600).catch(() => {})

      return { ok: true, persisted: true }
    },
    // Sign out: forget the token and remove our encrypted copy.
    clear: async () => {
      memo = null
      await fs.promises.rm(file, { force: true })
    },
  }
}

module.exports = { createTokenStore }
