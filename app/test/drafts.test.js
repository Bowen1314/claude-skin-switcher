'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')

const { createDrafts } = require('../src/drafts')
const { parseSkin, sparseSettings } = require('../src/skin-render')
const { tinySkin } = require('./fixtures')

const skin = parseSkin(tinySkin())
const REF = 'alice.tiny'

test('a draft exists only while it differs from what was applied', () => {
  const d = createDrafts(sparseSettings)
  const applied = { [REF]: { dim: 0.2 } }

  assert.deepEqual(d.current(REF, applied), { dim: 0.2 })
  assert.equal(d.button(REF, REF), 'applied')
  assert.equal(d.set(REF, { dim: 0.4 }, skin, applied), true)
  assert.deepEqual(d.current(REF, applied), { dim: 0.4 })
  assert.equal(d.button(REF, REF), 'apply-changes')
  // Dragging back to the applied value clears the draft again.
  assert.equal(d.set(REF, { dim: 0.2 }, skin, applied), false)
  assert.equal(d.button(REF, REF), 'applied')
  // Unknown keys and out-of-range values compare as they would be written.
  assert.equal(d.set(REF, { dim: 0.2, nope: 1, vars: { ghost: 1 } }, skin, applied), false)
})

test('the button: not active, applied, pending changes; Discard reverts', () => {
  const d = createDrafts(sparseSettings)

  assert.equal(d.button(REF, 'official.graphite-circuit'), 'apply')
  d.set(REF, { vars: { glow: '#00ff88' } }, skin, {})
  assert.equal(d.button(REF, 'official.graphite-circuit'), 'apply', 'a non-active skin is "Apply" with or without a draft')
  assert.deepEqual(d.refs(), [REF])
  assert.equal(d.button(REF, REF), 'apply-changes')
  d.discard(REF)
  assert.equal(d.button(REF, REF), 'applied')
  assert.deepEqual(d.current(REF, {}), {})
})

test('Reset to defaults only changes the draft', () => {
  const d = createDrafts(sparseSettings)
  const applied = { [REF]: { dim: 0.3, vars: { size: 2 } } }

  assert.equal(d.reset(REF, skin, applied), true)
  assert.deepEqual(d.current(REF, applied), {})
  assert.deepEqual(applied[REF], { dim: 0.3, vars: { size: 2 } }, 'applied settings untouched')
  assert.equal(d.button(REF, REF), 'apply-changes')
  // Resetting a skin that has nothing applied is no change at all.
  assert.equal(d.reset('bob.other', skin, {}), false)
})
