'use strict'

// Names shared with the bridge mod in ../plugin and the marketplace in ../.claude-plugin.
const MARKETPLACE_NAME = 'claude-theme-switcher'
const PLUGIN_NAME = 'theme-switcher'
const PLUGIN_ID = `${PLUGIN_NAME}@${MARKETPLACE_NAME}`
const STATE_DIR_NAME = '.claude-theme-switcher'
const REPO_URL = 'https://github.com/Bowen1314/claude-theme-switcher'

// The mod writes its heartbeat every 60 s; three missed beats means no live session.
const HEARTBEAT_FRESH_MS = 3 * 60 * 1000

// The public skin gallery (server/README.md) and GitHub's device flow.
// Read these through the exported object at call time (not destructured), so a
// test driver can point them at a local mock before main.js loads.
const GALLERY_URL = 'https://claude-skins.sdigasyugfyasfgdyf.workers.dev'
const GITHUB_URL = 'https://github.com'
const GITHUB_DEVICE_PAGE = 'https://github.com/login/device'
// Public OAuth app client id (device flow, no secret). Forks may blank it: empty means uploads are not configured.
const GITHUB_CLIENT_ID = 'Ov23li9cRHzRRmxPe6lZ'
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
  GITHUB_URL,
  GITHUB_DEVICE_PAGE,
  GITHUB_CLIENT_ID,
  LOCAL_OWNER,
}
