'use strict'

// The app's gallery client against the real Worker handler (server/src) with
// its fake D1, so the two sides cannot drift apart unnoticed. No network.

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const test = require('node:test')

const { createGallery } = require('../src/gallery')
const { prepareUpload, UPLOAD_MAX_BYTES } = require('../src/upload')
const { deps } = require('./deps-helper')
const { TINY_SCENE, tinySkin } = require('./fixtures')

const SERVER = path.join(__dirname, '..', '..', 'server')
let sqlite = true

try {
  require('node:sqlite')
} catch {
  sqlite = false
}

const skip = !fs.existsSync(path.join(SERVER, 'src', 'handler.js')) || !sqlite ? 'needs ../server and node:sqlite' : false
const TOKENS = { gho_alice: 'Alice', gho_bob: 'bob' }

const setup = async () => {
  const { handle, LIMITS } = await import(pathToFileURL(path.join(SERVER, 'src', 'handler.js')).href)
  const { FakeD1 } = await import(pathToFileURL(path.join(SERVER, 'test', 'fake-d1.js')).href)
  const env = { DB: new FakeD1(), ADMIN_TOKEN: 'a'.repeat(64), IP_SALT: 's'.repeat(64) }
  const clock = { t: 1_800_000_000_000 }
  const github = async (url, init) => {
    const login = TOKENS[init.headers.Authorization.replace(/^Bearer /, '')]

    return login ? Response.json({ login, id: 1 }) : new Response('{"message":"Bad credentials"}', { status: 401 })
  }
  const fetchImpl = (url, init) => {
    const headers = { 'CF-Connecting-IP': '203.0.113.9', ...(init.headers ?? {}) }

    return handle(new Request(url, { method: init.method, headers, body: init.body }), env, { fetch: github, now: () => clock.t })
  }
  const d = await deps()

  return { LIMITS, clock, g: createGallery({ baseUrl: 'https://skins.example', fetchImpl, deps: d }), d }
}

test('upload, list, detail, me, download, report and delete against the real handler', { skip }, async () => {
  const { LIMITS, g, d } = await setup()

  assert.equal(UPLOAD_MAX_BYTES, LIMITS.bodyMaxBytes, 'the app checks the same body limit the server enforces')
  const prep = prepareUpload({ skin: tinySkin(), scene: TINY_SCENE, deps: d })

  assert.equal(prep.ok, true, prep.errors.join('\n'))
  assert.deepEqual(await g.upload('gho_alice', prep.payload), { created: true, ref: 'alice.tiny', version: 1 })
  assert.deepEqual(await g.upload('gho_alice', prep.payload), { created: false, ref: 'alice.tiny', version: 2 })
  await assert.rejects(g.upload('gho_nobody', prep.payload), e => e.status === 401)

  const list = await g.list({ sort: 'new' })

  assert.deepEqual(list.items.map(i => i.ref), ['alice.tiny'])
  assert.equal(list.items[0].version, 2)
  assert.ok(list.items[0].preview.dark && list.items[0].preview.light, 'preview palettes for the cards')
  const detail = await g.detail('alice', 'tiny')

  assert.equal(detail.version, 2)
  assert.equal(detail.scene, TINY_SCENE)

  const me = await g.me('gho_alice')

  assert.equal(me.login, 'alice')
  assert.deepEqual(me.skins.map(s => [s.ref, s.hidden, s.reports]), [['alice.tiny', false, 0]], 'My skins items carry author and slug')

  assert.equal((await g.download('alice', 'tiny')).ok, true)
  assert.equal((await g.report('alice', 'tiny')).ok, true)
  await assert.rejects(g.remove('gho_bob', 'alice', 'tiny'), e => e.status === 403 || e.status === 404)
  await g.remove('gho_alice', 'alice', 'tiny')
  assert.deepEqual((await g.list()).items, [])
  await assert.rejects(g.detail('alice', 'tiny'), e => e.status === 404)
})

test('a scene for a skin without backdrop.scene is never sent (the server refuses it)', { skip }, async () => {
  const { g, d } = await setup()
  const { backdrop, ...plain } = tinySkin({ slug: 'flat' })
  const prep = prepareUpload({ skin: plain, scene: TINY_SCENE, deps: d })

  assert.ok(backdrop)
  assert.equal(prep.payload.scene, undefined)
  assert.equal((await g.upload('gho_bob', prep.payload)).ref, 'bob.flat')
})
