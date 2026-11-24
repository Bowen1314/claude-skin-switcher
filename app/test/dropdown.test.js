'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')

const { position, visibleIn } = require('../renderer/dropdown')

const rect = (top, left, height, width) => ({ top, left, bottom: top + height, right: left + width, height, width })
const view = { width: 980, height: 640 }
const size = { width: 160, height: 94 }

test('the list opens 4px under its trigger', () => {
  assert.deepEqual(position(rect(133, 300, 28, 140), size, view), { left: 300, top: 165 })
})

test('the list follows the trigger when its container scrolls', () => {
  // Settings scrolled by 50px: the trigger is at 83..111, so the list is at 115.
  assert.deepEqual(position(rect(83, 300, 28, 140), size, view), { left: 300, top: 115 })
})

test('the list flips up when only the space above fits', () => {
  assert.deepEqual(position(rect(580, 300, 28, 140), size, view), { left: 300, top: 580 - 4 - 94 })
})

test('the list stays inside the window', () => {
  assert.deepEqual(position(rect(100, 900, 28, 140), size, view), { left: 980 - 160 - 8, top: 132 })
  assert.equal(position(rect(-200, 8, 28, 140), size, view).top, 8)
})

test('a trigger is visible only inside every clipping box', () => {
  const win = rect(0, 0, 640, 980)
  const scroller = rect(76, 248, 564, 732)

  assert.equal(visibleIn(rect(133, 300, 28, 140), [win, scroller]), true)
  // Scrolled under the header: still in the window, but outside the scroller.
  assert.equal(visibleIn(rect(-3, 300, 28, 140), [win, scroller]), false)
  assert.equal(visibleIn(rect(60, 300, 28, 140), [win, scroller]), true)
  assert.equal(visibleIn(rect(700, 300, 28, 140), [win]), false)
  assert.equal(visibleIn(rect(0, 0, 0, 0), [win]), false)
})
