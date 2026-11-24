// Colour maths for the in-app picker: hex parsing and HSV <-> RGB.
// Loads under require() in tests and as a plain <script> in the renderer
// (window.ColorMath). Pure functions, no DOM.
;(function (root, factory) {
  const api = factory()

  if (typeof module === 'object' && module.exports) {
    module.exports = api
  } else {
    root.ColorMath = api
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict'

  // "#abc", "abc", " #AABBCC " -> "#aabbcc"; anything else -> null.
  const parseHex = text => {
    if (typeof text !== 'string') {
      return null
    }
    const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(text.trim())

    if (m === null) {
      return null
    }
    const h = m[1].toLowerCase()

    return `#${h.length === 3 ? [...h].map(c => c + c).join('') : h}`
  }

  const hexToRgb = hex => {
    const h = parseHex(hex)

    if (h === null) {
      return null
    }

    return { r: parseInt(h.slice(1, 3), 16), g: parseInt(h.slice(3, 5), 16), b: parseInt(h.slice(5, 7), 16) }
  }

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))
  const byte = v => clamp(Math.round(v), 0, 255)

  const rgbToHex = ({ r, g, b }) => `#${[r, g, b].map(v => byte(v).toString(16).padStart(2, '0')).join('')}`

  // h in [0, 360), s and v in [0, 1].
  const rgbToHsv = ({ r, g, b }) => {
    const [R, G, B] = [r, g, b].map(x => byte(x) / 255)
    const max = Math.max(R, G, B)
    const d = max - Math.min(R, G, B)
    let h = 0

    if (d !== 0) {
      if (max === R) {
        h = ((G - B) / d) % 6
      } else if (max === G) {
        h = (B - R) / d + 2
      } else {
        h = (R - G) / d + 4
      }
      h *= 60
      if (h < 0) {
        h += 360
      }
    }

    return { h, s: max === 0 ? 0 : d / max, v: max }
  }

  const hsvToRgb = ({ h, s, v }) => {
    const H = (((h % 360) + 360) % 360) / 60
    const S = clamp(s, 0, 1)
    const V = clamp(v, 0, 1)
    const c = V * S
    const x = c * (1 - Math.abs((H % 2) - 1))
    const m = V - c
    const [r, g, b] = H < 1 ? [c, x, 0] : H < 2 ? [x, c, 0] : H < 3 ? [0, c, x] : H < 4 ? [0, x, c] : H < 5 ? [x, 0, c] : [c, 0, x]

    return { r: byte((r + m) * 255), g: byte((g + m) * 255), b: byte((b + m) * 255) }
  }

  const hexToHsv = hex => {
    const rgb = hexToRgb(hex)

    return rgb === null ? null : rgbToHsv(rgb)
  }

  const hsvToHex = hsv => rgbToHex(hsvToRgb(hsv))

  return { parseHex, hexToRgb, rgbToHex, rgbToHsv, hsvToRgb, hexToHsv, hsvToHex, clamp }
})
