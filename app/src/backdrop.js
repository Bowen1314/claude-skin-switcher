// What a skin's backdrop actually is, read from the scene text itself.
// Loads under require() in tests and as a plain <script> in the renderer
// (window.Backdrop). Pure, no DOM.
;(function (root, factory) {
  const api = factory()

  if (typeof module === 'object' && module.exports) {
    module.exports = api
  } else {
    root.Backdrop = api
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict'

  const ANIMATED = /<animate\b|<animateTransform\b|<animateMotion\b|<set\b|@keyframes\b|animation\s*:/i
  const REACTIVE = /data-ctx="|var\(--ctx/

  // -> 'animated-reactive' | 'animated' | 'still-reactive' | 'still'
  //    | 'scene' (declared, text not loaded or missing) | 'solid' | 'none'
  const describeBackdrop = (skin, sceneText) => {
    const b = skin?.backdrop

    if (b === null || typeof b !== 'object') {
      return 'none'
    }
    if (typeof b.color === 'string') {
      return 'solid'
    }
    if (b.scene !== true) {
      return 'none'
    }
    if (typeof sceneText !== 'string' || sceneText === '') {
      return 'scene'
    }
    const animated = ANIMATED.test(sceneText)
    const reactive = REACTIVE.test(sceneText)

    return animated ? (reactive ? 'animated-reactive' : 'animated') : reactive ? 'still-reactive' : 'still'
  }

  return { describeBackdrop }
})
