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
    githubUrl: null,
    clientId: null,
    token: null,
  })
  const bad = screenshotOptions({ TS_SCREENSHOT: '/tmp/a.png', TS_SCHEME: 'blue', TS_SELECT: '../neon', TS_VIEW: 'x', TS_GALLERY_URL: 'https://evil.example', TS_TOKEN: 'abc', TS_CLIENT_ID: 'Iv1' })

  assert.equal(bad.scheme, null)
  assert.equal(bad.select, null)
  assert.equal(bad.view, 'library')
  assert.equal(bad.galleryUrl, null)
  assert.equal(bad.token, null, 'a token only goes to a local mock')
  assert.equal(bad.clientId, null)
  const mock = screenshotOptions({ TS_SCREENSHOT: 'a.png', TS_GALLERY_URL: 'http://127.0.0.1:4567', TS_GITHUB_URL: 'http://127.0.0.1:4568', TS_TOKEN: 'fake-token', TS_CLIENT_ID: 'Iv1.test' })

  assert.equal(screenshotOptions({ TS_SCREENSHOT: 'a.png', TS_CLIENT_ID: 'none' }).clientId, '')
  assert.deepEqual([mock.galleryUrl, mock.githubUrl, mock.token, mock.clientId], ['http://127.0.0.1:4567', 'http://127.0.0.1:4568', 'fake-token', 'Iv1.test'])
})

test('zh and en string tables have the same keys', () => {
  assert.deepEqual(Object.keys(STRINGS.zh).sort(), Object.keys(STRINGS.en).sort())
  assert.equal(langFor('zh-CN'), 'zh')
  assert.equal(langFor('zh-TW'), 'zh')
  assert.equal(langFor('en-US'), 'en')
  assert.equal(langFor(undefined), 'en')
  assert.equal(stringsFor('zh').apply, '应用')
})
