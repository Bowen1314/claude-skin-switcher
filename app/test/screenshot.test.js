'use strict'

const assert = require('node:assert/strict')
const path = require('node:path')
const test = require('node:test')

const { stringsFor, STRINGS, langFor } = require('../src/i18n')
const { screenshotOptions } = require('../src/screenshot')

test('screenshot mode is off unless TS_SCREENSHOT is set', () => {
  assert.equal(screenshotOptions({}), null)
  assert.equal(screenshotOptions({ TS_SCREENSHOT: '' }), null)
})

test('screenshot options are validated', () => {
  assert.deepEqual(screenshotOptions({ TS_SCREENSHOT: 'shot.png', TS_SCHEME: 'light', TS_SELECT: 'firefly-meadow', TS_VIEW: 'tune' }), {
    out: path.resolve('shot.png'),
    scheme: 'light',
    select: 'official.firefly-meadow',
    view: 'tune',
    galleryUrl: null,
    googleUrl: null,
    clientId: null,
    token: null,
    draft: null,
    tab: null,
    dropdown: null,
    update: null,
    del: null,
    picker: null,
    size: null,
  })
  assert.equal(screenshotOptions({ TS_SCREENSHOT: 'a.png', TS_OPEN_DROPDOWN: 'tag' }).dropdown, 'tag')
  assert.equal(screenshotOptions({ TS_SCREENSHOT: 'a.png', TS_OPEN_DROPDOWN: 'x' }).dropdown, null)
  assert.equal(screenshotOptions({ TS_SCREENSHOT: 'a.png', TS_OPEN_DROPDOWN: 'set-language' }).dropdown, 'set-language')
  assert.equal(screenshotOptions({ TS_SCREENSHOT: 'a.png', TS_UPDATE: 'available' }).update, 'available')
  assert.equal(screenshotOptions({ TS_SCREENSHOT: 'a.png', TS_UPDATE: 'downloading' }).update, 'downloading')
  assert.equal(screenshotOptions({ TS_SCREENSHOT: 'a.png', TS_UPDATE: 'installing' }).update, null)
  assert.equal(screenshotOptions({ TS_SCREENSHOT: 'a.png', TS_DELETE: 'menu' }).del, 'menu')
  assert.equal(screenshotOptions({ TS_SCREENSHOT: 'a.png', TS_DELETE: 'yes' }).del, null)
  assert.equal(screenshotOptions({ TS_SCREENSHOT: 'a.png', TS_OPEN_PICKER: 'accent' }).picker, 'accent')
  assert.equal(screenshotOptions({ TS_SCREENSHOT: 'a.png', TS_OPEN_PICKER: 'glow' }).picker, 'glow')
  assert.equal(screenshotOptions({ TS_SCREENSHOT: 'a.png', TS_OPEN_PICKER: '"]x' }).picker, null)
  for (const v of ['library', 'tune', 'code', 'gallery', 'detail', 'upload', 'settings']) {
    assert.equal(screenshotOptions({ TS_SCREENSHOT: 'a.png', TS_VIEW: v }).view, v)
  }
  assert.equal(screenshotOptions({ TS_SCREENSHOT: 'a.png', TS_VIEW: 'detail', TS_TAB: 'code' }).tab, 'code')
  assert.equal(screenshotOptions({ TS_SCREENSHOT: 'a.png', TS_TAB: 'source' }).tab, null)
  assert.deepEqual(screenshotOptions({ TS_SCREENSHOT: 'a.png', TS_SIZE: '860x560' }).size, { width: 860, height: 560 })
  assert.deepEqual(screenshotOptions({ TS_SCREENSHOT: 'a.png', TS_SIZE: '400x300' }).size, { width: 860, height: 560 }, 'never below the window minimum')
  assert.equal(screenshotOptions({ TS_SCREENSHOT: 'a.png', TS_SIZE: '860*560' }).size, null)
  assert.deepEqual(screenshotOptions({ TS_SCREENSHOT: 'a.png', TS_DRAFT: '{"dim":0.3,"vars":{"glow":"#00ff88"}}' }).draft, { dim: 0.3, vars: { glow: '#00ff88' } })
  assert.equal(screenshotOptions({ TS_SCREENSHOT: 'a.png', TS_DRAFT: '[1]' }).draft, null)
  assert.equal(screenshotOptions({ TS_SCREENSHOT: 'a.png', TS_DRAFT: '{oops' }).draft, null)
  const bad = screenshotOptions({ TS_SCREENSHOT: '/tmp/a.png', TS_SCHEME: 'blue', TS_SELECT: '../neon', TS_VIEW: 'x', TS_GALLERY_URL: 'https://evil.example', TS_TOKEN: 'abc', TS_CLIENT_ID: 'Iv1' })

  assert.equal(bad.scheme, null)
  assert.equal(bad.select, null)
  assert.equal(bad.view, 'library')
  assert.equal(bad.galleryUrl, null)
  assert.equal(bad.token, null, 'a token only goes to a local mock')
  assert.equal(bad.clientId, null)
  const mock = screenshotOptions({ TS_SCREENSHOT: 'a.png', TS_GALLERY_URL: 'http://127.0.0.1:4567', TS_GOOGLE_URL: 'http://127.0.0.1:4568', TS_TOKEN: 'fake-token', TS_CLIENT_ID: 'Iv1.test' })

  assert.equal(screenshotOptions({ TS_SCREENSHOT: 'a.png', TS_CLIENT_ID: 'none' }).clientId, '')
  assert.deepEqual([mock.galleryUrl, mock.googleUrl, mock.token, mock.clientId], ['http://127.0.0.1:4567', 'http://127.0.0.1:4568', 'fake-token', 'Iv1.test'])
})

test('zh and en string tables have the same keys', () => {
  assert.deepEqual(Object.keys(STRINGS.zh).sort(), Object.keys(STRINGS.en).sort())
  assert.equal(langFor('zh-CN'), 'zh')
  assert.equal(langFor('zh-TW'), 'zh')
  assert.equal(langFor('en-US'), 'en')
  assert.equal(langFor(undefined), 'en')
  assert.equal(stringsFor('zh').apply, '应用')
})
