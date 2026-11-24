'use strict'

const path = require('node:path')

const { themeOf } = require('./selection')

const VIEWS = new Set(['library', 'tune', 'code', 'gallery', 'detail', 'upload', 'settings'])
const TABS = new Set(['overview', 'tune', 'code'])
const MIN_SIZE = { width: 860, height: 560 }
const LOCAL_URL = /^http:\/\/(127\.0\.0\.1|localhost):\d{1,5}$/

// Headless screenshot mode for docs and checks:
//   TS_SCREENSHOT=<png path>  capture the window without showing it, then quit
//   TS_SCHEME=dark|light       force the colour scheme
//   TS_SELECT=<ref>            skin shown on launch (old ids are mapped);
//                              with TS_VIEW=detail, the gallery skin to open
//   TS_VIEW=library|tune|code|gallery|detail|upload|settings
//   TS_TAB=overview|tune|code  the tab to open in the skin view (e.g. with TS_VIEW=detail)
//   TS_OPEN_PICKER=accent|<var key>  open the colour picker for that Tune control
//   TS_DELETE=confirm|menu     the delete confirmation or the library row menu (TS_SELECT skin)
//   TS_OPEN_DROPDOWN=tag|up-library  open that dropdown once the view is drawn
//   TS_SIZE=<w>x<h>            window content size (at least 860x560; default 980x640)
//   TS_GALLERY_URL / TS_GOOGLE_URL=http://127.0.0.1:<port>  local mock servers
//   TS_CLIENT_ID=none|<id>     blank the Google client id, or use a mock one (with TS_GOOGLE_URL)
//   TS_TOKEN                   a fake refresh token: signed in (only with local mocks)
//   TS_DRAFT=<json>            unapplied tuning for the TS_SELECT skin, e.g. {"dim":0.3}
// In this mode the gallery is read-only, nothing touches the keychain, and the
// token (if any) lives in memory. Returns null when TS_SCREENSHOT is unset.
const screenshotOptions = env => {
  const out = env.TS_SCREENSHOT

  if (typeof out !== 'string' || out === '') {
    return null
  }
  const local = v => (typeof v === 'string' && LOCAL_URL.test(v) ? v : null)
  const galleryUrl = local(env.TS_GALLERY_URL)
  const googleUrl = local(env.TS_GOOGLE_URL)
  const token = typeof env.TS_TOKEN === 'string' && /^[\w.-]{1,100}$/.test(env.TS_TOKEN) && galleryUrl !== null && googleUrl !== null ? env.TS_TOKEN : null

  let draft = null

  if (typeof env.TS_DRAFT === 'string' && env.TS_DRAFT.length <= 4096) {
    try {
      const parsed = JSON.parse(env.TS_DRAFT)

      draft = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
    } catch {
      draft = null
    }
  }

  const size = /^(\d{3,4})x(\d{3,4})$/.exec(typeof env.TS_SIZE === 'string' ? env.TS_SIZE : '')

  return {
    out: path.resolve(out),
    scheme: env.TS_SCHEME === 'dark' || env.TS_SCHEME === 'light' ? env.TS_SCHEME : null,
    select: themeOf(env.TS_SELECT),
    view: VIEWS.has(env.TS_VIEW) ? env.TS_VIEW : 'library',
    galleryUrl,
    googleUrl,
    // null: the build's own id. 'none': blank. Another id only with a local Google mock.
    clientId: env.TS_CLIENT_ID === 'none' ? '' : typeof env.TS_CLIENT_ID === 'string' && /^[\w.-]{1,64}$/.test(env.TS_CLIENT_ID) && googleUrl !== null ? env.TS_CLIENT_ID : null,
    token,
    draft,
    tab: TABS.has(env.TS_TAB) ? env.TS_TAB : null,
    dropdown: env.TS_OPEN_DROPDOWN === 'tag' || env.TS_OPEN_DROPDOWN === 'up-library' ? env.TS_OPEN_DROPDOWN : null,
    del: env.TS_DELETE === 'confirm' || env.TS_DELETE === 'menu' ? env.TS_DELETE : null,
    picker: typeof env.TS_OPEN_PICKER === 'string' && /^[a-z][a-z0-9-]{0,23}$/.test(env.TS_OPEN_PICKER) ? env.TS_OPEN_PICKER : null,
    size: size ? { width: Math.max(MIN_SIZE.width, Number(size[1])), height: Math.max(MIN_SIZE.height, Number(size[2])) } : null,
  }
}

module.exports = { screenshotOptions }
