// Unapplied tuning, one draft per skin, held in the window's memory only.
// Nothing here writes anything: Apply sends the draft to main, which writes
// selection.json. Loads under require() in tests and as a plain <script> in
// the renderer (window.Drafts). Takes SkinRender's sparseSettings so a draft
// and the applied settings are compared the way they would be written.
;(function (root, factory) {
  const api = factory()

  if (typeof module === 'object' && module.exports) {
    module.exports = api
  } else {
    root.Drafts = api
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict'

  const sortKeys = v =>
    v !== null && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.keys(v).sort().map(k => [k, sortKeys(v[k])]))
      : v

  // sparseSettings(raw, parsedSkin) -> only the keys a person set, clamped.
  function createDrafts(sparseSettings) {
    const drafts = new Map() // ref -> raw settings

    const canonical = (raw, skin) => JSON.stringify(sortKeys(sparseSettings(raw ?? {}, skin)))
    const appliedRaw = (ref, applied) => (applied && applied[ref]) || {}

    const api = {
      // What the window should show and tune: the draft, else what was applied.
      current: (ref, applied) => (drafts.has(ref) ? drafts.get(ref) : appliedRaw(ref, applied)),
      has: ref => drafts.has(ref),
      refs: () => [...drafts.keys()],

      // Keep a draft only while it differs from what was applied.
      set: (ref, raw, skin, applied) => {
        if (canonical(raw, skin) === canonical(appliedRaw(ref, applied), skin)) {
          drafts.delete(ref)
        } else {
          drafts.set(ref, raw)
        }

        return drafts.has(ref)
      },

      // "Reset to defaults": a draft with nothing set (still needs Apply).
      reset: (ref, skin, applied) => api.set(ref, {}, skin, applied),

      // "Discard", or after a successful Apply.
      discard: ref => drafts.delete(ref),

      // The primary button: 'apply' | 'applied' | 'apply-changes'.
      button: (ref, activeRef) => (ref !== activeRef ? 'apply' : drafts.has(ref) ? 'apply-changes' : 'applied'),
    }

    return api
  }

  return { createDrafts }
})
