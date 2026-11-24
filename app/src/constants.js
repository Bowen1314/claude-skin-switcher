'use strict'

// Names shared with the bridge mod in ../plugin and the marketplace in ../.claude-plugin.
const MARKETPLACE_NAME = 'claude-theme-switcher'
const PLUGIN_NAME = 'theme-switcher'
const PLUGIN_ID = `${PLUGIN_NAME}@${MARKETPLACE_NAME}`
const STATE_DIR_NAME = '.claude-theme-switcher'
const REPO_URL = 'https://github.com/Bowen1314/claude-skin-switcher'

// The mod writes its heartbeat every 60 s; three missed beats means no live session.
const HEARTBEAT_FRESH_MS = 3 * 60 * 1000

// The public skin gallery (server/README.md) and Google sign-in.
// Read these through the exported object at call time (not destructured), so a
// test driver can point them at a local mock before main.js loads.
const GALLERY_URL = 'https://claude-skins.sdigasyugfyasfgdyf.workers.dev'
const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'
// Google "Desktop app" OAuth client. Google documents that a desktop client's
// secret is not confidential and ships inside the app, but it is kept out of the
// public repo so secret scanners don't revoke it: release builds write it to
// src/google-secret.json (git-ignored) from a GitHub Actions secret, and a local
// run can set GOOGLE_CLIENT_SECRET instead. Empty id: sign-in is not configured.
const GOOGLE_CLIENT_ID = '557060565691-aqiljt7ml6g9o2ap4bvfm10du9n8lkme.apps.googleusercontent.com'
const GOOGLE_CLIENT_SECRET = (() => {
  try {
    return String(require('./google-secret.json').secret || '')
  } catch {
    return process.env.GOOGLE_CLIENT_SECRET || ''
  }
})()
// Owner used for skins made in the app before they are uploaded.
const LOCAL_OWNER = 'local'

module.exports = {
  MARKETPLACE_NAME,
  PLUGIN_NAME,
  PLUGIN_ID,
  STATE_DIR_NAME,
  REPO_URL,
  HEARTBEAT_FRESH_MS,
  GALLERY_URL,
  GOOGLE_AUTH_URL,
  GOOGLE_TOKEN_URL,
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  LOCAL_OWNER,
}
