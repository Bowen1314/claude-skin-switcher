'use strict'

// Red-team cases for what the app writes to disk and shows from the gallery.

const assert = require('node:assert/strict')
const test = require('node:test')

const { listItem } = require('../src/gallery')
const { makeRef } = require('../src/library')

test('makeRef refuses Windows device names as the folder name', () => {
  for (const owner of ['con', 'CON', 'prn', 'aux', 'nul', 'com1', 'com9', 'lpt1', 'lpt0']) {
    assert.equal(makeRef(owner, 'tiny'), null, owner)
  }
  // Only the part before the first dot names a device, and only exactly.
  assert.equal(makeRef('console', 'tiny'), 'console.tiny')
  assert.equal(makeRef('com10', 'tiny'), 'com10.tiny')
  assert.equal(makeRef('alice', 'con'), 'alice.con')
})

test('gallery list text drops invisible and text-direction characters', () => {
  const item = listItem({
    author: 'alice',
    slug: 'tiny',
    name: 'Firefly\u202e wodaeM',
    description: 'a\u2066b\u200bc\u0085d\u2028e\ufeff',
  })
  assert.doesNotMatch(item.name, /[\u202e]/)
  assert.doesNotMatch(item.description, /[\u2066\u200b\u0085\u2028\ufeff]/)
  assert.equal(listItem({ author: 'alice', slug: 'tiny', name: '👩\u200d💻 Night' }).name, '👩\u200d💻 Night')
})
