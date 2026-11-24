'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const { describeBackdrop } = require('../src/backdrop')
const { TINY_SCENE } = require('./fixtures')

const scene = { backdrop: { scene: true } }
const svg = body => `<svg xmlns="http://www.w3.org/2000/svg">${body}</svg>`

test('animated and context-reactive are read from the scene text', () => {
  assert.equal(describeBackdrop(scene, svg('<circle><animate attributeName="r"/></circle><g data-ctx="0.5"/>')), 'animated-reactive')
  for (const anim of ['<animate attributeName="r"/>', '<animateTransform type="rotate"/>', '<animateMotion path="M0 0"/>', '<set attributeName="x" to="1"/>', '<style>@keyframes a{}</style>', '<style>.a{animation: a 2s}</style>']) {
    assert.equal(describeBackdrop(scene, svg(anim)), 'animated', anim)
  }
  assert.equal(describeBackdrop(scene, svg('<g data-ctx="0.3"/>')), 'still-reactive')
  assert.equal(describeBackdrop(scene, svg('<style>.a{opacity:var(--ctx)}</style>')), 'still-reactive')
  assert.equal(describeBackdrop(scene, svg('<rect width="10" height="10"/>')), 'still')
  assert.equal(describeBackdrop(scene, TINY_SCENE), 'still-reactive', 'the fixture has data-ctx and no animation')
  assert.equal(describeBackdrop(scene, svg('<settings/><g data-context="1"/>')), 'still', 'no false hits on look-alike names')
})

test('no scene text yet, a solid colour, or no backdrop', () => {
  assert.equal(describeBackdrop(scene, null), 'scene')
  assert.equal(describeBackdrop(scene, undefined), 'scene')
  assert.equal(describeBackdrop(scene, ''), 'scene')
  assert.equal(describeBackdrop({ backdrop: { color: '#112233' } }, null), 'solid')
  assert.equal(describeBackdrop({}, svg('<animate/>')), 'none')
  assert.equal(describeBackdrop(null, null), 'none')
})

test('the bundled skins', () => {
  const dir = path.join(__dirname, '..', '..', 'plugin', 'skins')

  for (const ref of fs.readdirSync(dir).filter(n => n.startsWith('official.'))) {
    const text = fs.readFileSync(path.join(dir, ref, 'scene.svg'), 'utf8')

    assert.ok(['animated-reactive', 'animated', 'still-reactive', 'still'].includes(describeBackdrop(scene, text)), ref)
  }
})
