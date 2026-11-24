'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')

const C = require('../src/color')

test('parseHex accepts 3 or 6 digits, with or without #, and nothing else', () => {
  assert.equal(C.parseHex('#ABC'), '#aabbcc')
  assert.equal(C.parseHex('abc'), '#aabbcc')
  assert.equal(C.parseHex(' #35B8C9 '), '#35b8c9')
  assert.equal(C.parseHex('35b8c9'), '#35b8c9')
  for (const bad of ['', '#', '#abcd', '#35b8c9ff', 'ggg', '#12345', 'red', null, undefined, 42, '##abc']) {
    assert.equal(C.parseHex(bad), null, String(bad))
  }
})

test('hex <-> rgb', () => {
  assert.deepEqual(C.hexToRgb('#ff8000'), { r: 255, g: 128, b: 0 })
  assert.equal(C.hexToRgb('nope'), null)
  assert.equal(C.rgbToHex({ r: 255, g: 128, b: 0 }), '#ff8000')
  assert.equal(C.rgbToHex({ r: 300, g: -5, b: 15.6 }), '#ff0010', 'clamped and rounded')
})

test('rgb <-> hsv on known colours', () => {
  assert.deepEqual(C.rgbToHsv({ r: 255, g: 0, b: 0 }), { h: 0, s: 1, v: 1 })
  assert.deepEqual(C.rgbToHsv({ r: 0, g: 255, b: 0 }), { h: 120, s: 1, v: 1 })
  assert.deepEqual(C.rgbToHsv({ r: 0, g: 0, b: 255 }), { h: 240, s: 1, v: 1 })
  assert.deepEqual(C.rgbToHsv({ r: 0, g: 0, b: 0 }), { h: 0, s: 0, v: 0 })
  assert.deepEqual(C.rgbToHsv({ r: 255, g: 255, b: 255 }), { h: 0, s: 0, v: 1 })
  assert.deepEqual(C.hsvToRgb({ h: 60, s: 1, v: 1 }), { r: 255, g: 255, b: 0 })
  assert.deepEqual(C.hsvToRgb({ h: 360, s: 1, v: 1 }), { r: 255, g: 0, b: 0 }, 'hue wraps')
  assert.deepEqual(C.hsvToRgb({ h: -120, s: 1, v: 1 }), { r: 0, g: 0, b: 255 })
  assert.deepEqual(C.hsvToRgb({ h: 200, s: 0, v: 0.5 }), { r: 128, g: 128, b: 128 })
})

test('every 6-digit colour on a grid survives hex -> hsv -> hex', () => {
  for (let r = 0; r < 256; r += 17) {
    for (let g = 0; g < 256; g += 15) {
      for (let b = 0; b < 256; b += 51) {
        const hex = C.rgbToHex({ r, g, b })

        assert.equal(C.hsvToHex(C.hexToHsv(hex)), hex)
      }
    }
  }
})
