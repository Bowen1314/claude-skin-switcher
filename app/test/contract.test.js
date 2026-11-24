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
const { deps: deps_ } = require('./deps-helper')
const { TINY_SCENE, tinySkin } = require('./fixtures')

const SERVER = path.join(__dirname, '..', '..', 'server')
let sqlite = true

try {
  require('node:sqlite')
} catch {
  sqlite = false
}

const skip = !fs.existsSync(path.join(SERVER, 'src', 'handler.js')) || !sqlite ? 'needs ../server and node:sqlite' : false
const CLIENT_ID = 'contract.apps.googleusercontent.com'
const b64json = v => Buffer.from(JSON.stringify(v)).toString('base64url')

const setup = async () => {
  const { handle, LIMITS, newJwksCache } = await import(pathToFileURL(path.join(SERVER, 'src', 'handler.js')).href)
  const { FakeD1 } = await import(pathToFileURL(path.join(SERVER, 'test', 'fake-d1.js')).href)
  const env = { DB: new FakeD1(), ADMIN_TOKEN: 'a'.repeat(64), IP_SALT: 's'.repeat(64), GOOGLE_CLIENT_ID: CLIENT_ID }
  const clock = { t: 1_800_000_000_000 }
  const kp = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify'])
  const pub = await crypto.subtle.exportKey('jwk', kp.publicKey)
  const jwk = { kty: 'RSA', n: pub.n, e: pub.e, kid: 'k1', alg: 'RS256', use: 'sig' }
  // What Google would sign for an openid-only sign-in: an opaque `sub`, no email or name.
  const mint = async sub => {
    const nowS = Math.floor(clock.t / 1000)
    const signed = `${b64json({ alg: 'RS256', kid: 'k1', typ: 'JWT' })}.${b64json({ iss: 'https://accounts.google.com', aud: CLIENT_ID, sub, iat: nowS, exp: nowS + 3600 })}`
    const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', kp.privateKey, new TextEncoder().encode(signed))

    return `${signed}.${Buffer.from(sig).toString('base64url')}`
  }
  const google = async () => Response.json({ keys: [jwk] }, { headers: { 'Cache-Control': 'public, max-age=3600' } })
  const deps = { fetch: google, now: () => clock.t, jwks: newJwksCache() }
  const fetchImpl = (url, init) => {
    const headers = { 'CF-Connecting-IP': '203.0.113.9', ...(init.headers ?? {}) }

    return handle(new Request(url, { method: init.method, headers, body: init.body }), env, deps)
  }
  const d = await deps_()

  return { LIMITS, clock, mint, g: createGallery({ baseUrl: 'https://skins.example', fetchImpl, deps: d }), d }
}

test('Google ID token: public name, upload, list, detail, me, download, report and delete against the real handler', { skip }, async () => {
  const { LIMITS, g, d, mint } = await setup()
  const alice = await mint('google-sub-alice')
  const bob = await mint('google-sub-bob')

  assert.equal(UPLOAD_MAX_BYTES, LIMITS.bodyMaxBytes, 'the app checks the same body limit the server enforces')
  assert.deepEqual(await g.me(alice), { handle: null, skins: [] })
  const prep = prepareUpload({ skin: tinySkin(), scene: TINY_SCENE, deps: d })

  assert.equal(prep.ok, true, prep.errors.join('\n'))
  await assert.rejects(g.upload(alice, prep.payload), e => e.status === 409 && /no handle/.test(e.message), 'uploads need a public name')
  await assert.rejects(g.claimHandle(alice, 'official-x'), e => e.status === 409 && /reserved/.test(e.message))
  assert.deepEqual(await g.claimHandle(alice, 'alice'), { handle: 'alice' })
  await assert.rejects(g.claimHandle(bob, 'alice'), e => e.status === 409 && /taken/.test(e.message))

  assert.deepEqual(await g.upload(alice, prep.payload), { created: true, ref: 'alice.tiny', version: 1 })
  assert.deepEqual(await g.upload(alice, prep.payload), { created: false, ref: 'alice.tiny', version: 2 })
  await assert.rejects(g.upload('not-a-jwt', prep.payload), e => e.status === 401)
  await assert.rejects(g.claimHandle(alice, 'alice-two'), e => e.status === 409 && /locked/.test(e.message), 'the name is locked once it has skins')

  const list = await g.list({ sort: 'new' })

  assert.deepEqual(list.items.map(i => i.ref), ['alice.tiny'])
  assert.equal(list.items[0].version, 2)
  assert.ok(list.items[0].preview.dark && list.items[0].preview.light, 'preview palettes for the cards')
  const detail = await g.detail('alice', 'tiny')

  assert.equal(detail.version, 2)
  assert.equal(detail.scene, TINY_SCENE)
  const me = await g.me(alice)

  assert.equal(me.handle, 'alice')
  assert.deepEqual(me.skins.map(s => [s.ref, s.hidden, s.reports]), [['alice.tiny', false, 0]], 'My skins items carry author and slug')
  assert.equal((await g.download('alice', 'tiny')).ok, true)
  assert.equal((await g.report('alice', 'tiny')).ok, true)
  await g.claimHandle(bob, 'bob')
  await assert.rejects(g.remove(bob, 'alice', 'tiny'), e => e.status === 403 || e.status === 404)
  await g.remove(alice, 'alice', 'tiny')
  assert.deepEqual((await g.list()).items, [])
  await assert.rejects(g.detail('alice', 'tiny'), e => e.status === 404)
})

test('a scene for a skin without backdrop.scene is never sent (the server refuses it)', { skip }, async () => {
  const { g, d, mint } = await setup()
  const bob = await mint('google-sub-bob')
  const { backdrop, ...plain } = tinySkin({ slug: 'flat' })
  const prep = prepareUpload({ skin: plain, scene: TINY_SCENE, deps: d })

  assert.ok(backdrop)
  assert.equal(prep.payload.scene, undefined)
  await g.claimHandle(bob, 'bob')
  assert.equal((await g.upload(bob, prep.payload)).ref, 'bob.flat')
})

test('another author\'s recolored copy gets 409 naming the original; a declared remix goes through and is listed', { skip }, async () => {
  const { g, d, mint } = await setup()
  const alice = await mint('google-sub-alice')
  const bob = await mint('google-sub-bob')

  await g.claimHandle(alice, 'alice')
  await g.claimHandle(bob, 'bob')
  await g.upload(alice, prepareUpload({ skin: tinySkin(), scene: TINY_SCENE, deps: d }).payload)
  const copy = prepareUpload({ skin: tinySkin({ slug: 'mine', name: 'Mine' }), scene: TINY_SCENE.replace('#ffffff', '#123456'), deps: d }).payload

  await assert.rejects(g.upload(bob, copy), e => e.status === 409 && e.message === 'already in the gallery' && e.data.original === 'alice.tiny' && e.data.name === 'Tiny')
  await assert.rejects(g.upload(bob, { ...copy, basedOn: 'alice.other' }), e => e.status === 409)
  assert.deepEqual(await g.upload(bob, { ...copy, basedOn: 'alice.tiny' }), { created: true, ref: 'bob.mine', version: 1 })
  const item = (await g.list()).items.find(i => i.ref === 'bob.mine')

  assert.deepEqual([item.basedOn, item.basedOnName], ['alice.tiny', 'Tiny'])
  const detail = await g.detail('bob', 'mine')

  assert.deepEqual([detail.basedOn, detail.basedOnName], ['alice.tiny', 'Tiny'])
})
