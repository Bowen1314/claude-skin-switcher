'use strict'

const path = require('node:path')

const { themeOf } = require('./selection')

const VIEWS = new Set(['library', 'tune', 'gallery', 'detail', 'upload'])
const LOCAL_URL = /^http:\/\/(127\.0\.0\.1|localhost):\d{1,5}$/

// Headless screenshot mode for docs and checks:
//   TS_SCREENSHOT=<png path>  capture the window without showing it, then quit
//   TS_SCHEME=dark|light       force the colour scheme
//   TS_SELECT=<ref>            skin shown on launch (old ids are mapped);
//                              with TS_VIEW=detail, the gallery skin to open
//   TS_VIEW=library|tune|gallery|detail|upload
//   TS_GALLERY_URL / TS_GITHUB_URL=http://127.0.0.1:<port>  a local mock server
//   TS_CLIENT_ID=none|<id>     blank the client id, or use a mock one (with TS_GITHUB_URL)
//   TS_TOKEN                   pretend to be signed in (only with a local TS_GALLERY_URL)
// In this mode the gallery is read-only, nothing touches the keychain, and the
// token (if any) lives in memory. Returns null when TS_SCREENSHOT is unset.
const screenshotOptions = env => {
  const out = env.TS_SCREENSHOT

  if (typeof out !== 'string' || out === '') {
    return null
  }
  const local = v => (typeof v === 'string' && LOCAL_URL.test(v) ? v : null)
  const galleryUrl = local(env.TS_GALLERY_URL)
  const githubUrl = local(env.TS_GITHUB_URL)
  const token = typeof env.TS_TOKEN === 'string' && /^[\w.-]{1,100}$/.test(env.TS_TOKEN) && galleryUrl !== null ? env.TS_TOKEN : null

  return {
    out: path.resolve(out),
    scheme: env.TS_SCHEME === 'dark' || env.TS_SCHEME === 'light' ? env.TS_SCHEME : null,
    select: themeOf(env.TS_SELECT),
    view: VIEWS.has(env.TS_VIEW) ? env.TS_VIEW : 'library',
    galleryUrl,
    githubUrl,
    // null: the build's own id. 'none': pretend a fork blanked it. Another id only with a local GitHub mock.
    clientId: env.TS_CLIENT_ID === 'none' ? '' : typeof env.TS_CLIENT_ID === 'string' && /^[\w.-]{1,64}$/.test(env.TS_CLIENT_ID) && githubUrl !== null ? env.TS_CLIENT_ID : null,
    token,
  }
}

module.exports = { screenshotOptions }
