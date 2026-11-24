// The sidebar update icon and its popover, as plain rules over the updater
// state. Loads under require() in tests and as a plain <script> in the
// renderer (window.UpdateBadge). Pure, no DOM.
;(function (root, factory) {
  const api = factory()

  if (typeof module === 'object' && module.exports) {
    module.exports = api
  } else {
    root.UpdateBadge = api
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict'

  const WORKING = new Set(['downloading', 'installing'])
  // 'checking' keeps a version already found (the 6-hourly recheck), so the icon doesn't blink.
  const KNOWN = new Set(['available', 'checking', 'downloading', 'installing'])

  // Show the icon when a newer version is known, unless "Not now" was chosen
  // for that version in this session. An update in progress always shows it.
  const showBadge = (state, dismissed = null) => {
    const latest = state?.latest

    if (!latest || !KNOWN.has(state.status)) {
      return false
    }

    return WORKING.has(state.status) || latest !== dismissed
  }

  // What the popover shows for a state:
  //   phase: 'available' | 'downloading' | 'installing'
  //   canUpdate: the Update button is enabled
  const popoverView = state => {
    const phase = WORKING.has(state?.status) ? state.status : 'available'

    return {
      phase,
      canUpdate: state?.status === 'available',
      progress: phase === 'downloading' ? Math.round((state.progress ?? 0) * 100) : null,
      error: state?.error?.during === 'update' ? state.error : null,
    }
  }

  return { showBadge, popoverView }
})
