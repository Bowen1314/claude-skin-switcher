'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const { createGallery, listItem } = require('../src/gallery')
const { exchangeCode, expiryOf, isFresh, refreshIdToken, startLoopback } = require('../src/google')
const { request } = require('../src/http')
const { createTokenStore } = require('../src/token-store')
const { bakeTuning, freeSlug, importFolder, prepareUpload } = require('../src/upload')
const { deps } = require('./deps-helper')
const { TINY_SCENE, tinySkin } = require('./fixtures')
const { tempDir } = require('./helpers')
const { startMock } = require('./mock-server')

const PAL = { surface0: '#101114', surface1: '#16181c', text: '#e8e9eb', muted: '#8b9099', accent: '#35b8c9' }
const item = extra => ({ ref: 'alice.tiny', author: 'alice', slug: 'tiny', name: 'Tiny', description: 'd', tags: ['dark'], version: 2, downloads: 5, hasScene: true, updatedAt: 1, preview: { dark: PAL }, ...extra })

test('listItem keeps text as text and drops anything that cannot be a ref', () => {
  const x = listItem(item({ name: '<img src=x onerror=alert(1)>\u0007', tags: ['ok', 'Bad Tag', 3], preview: { dark: PAL, light: { ...PAL, accent: 'red' } } }))

  assert.equal(x.name, '<img src=x onerror=alert(1)> ')
  assert.deepEqual(x.tags, ['ok'])
  assert.deepEqual(Object.keys(x.preview), ['dark'])
  assert.equal(x.ref, 'alice.tiny')
  assert.equal(listItem(item({ author: '../etc' })), null)
  assert.equal(listItem(item({ slug: 'a/b' })), null)
  assert.equal(listItem(null), null)
})

test('gallery list: query string, paging, junk filtered', async t => {
  const mock = await startMock(t, {
    'GET /api/skins': (_req, _b, url) => ({ json: { items: [item(), item({ slug: '../x' }), 'junk'], nextCursor: url.searchParams.get('cursor') ? null : 'abc_1=' } }),
  })
  const g = createGallery({ baseUrl: mock.url, deps: await deps() })
  const first = await g.list({ sort: 'popular', q: ' fire\n ', tag: 'dark', limit: 99 })

  assert.equal(first.items.length, 1)
  assert.equal(first.nextCursor, 'abc_1=')
  const qs = new URLSearchParams(mock.calls[0].search)

  assert.deepEqual(Object.fromEntries(qs), { sort: 'popular', limit: '50', q: 'fire', tag: 'dark' })
  assert.equal((await g.list({ cursor: first.nextCursor })).nextCursor, null)
  assert.equal(new URLSearchParams(mock.calls[1].search).get('cursor'), 'abc_1=')
})

test('gallery detail validates the skin and scene and checks it is the one asked for', async t => {
  const d = await deps()
  let scene = TINY_SCENE
  let author = 'alice'
  const mock = await startMock(t, {
    'GET /api/skins/alice/tiny': () => ({ json: { ...tinySkin(), author, version: 3 } }),
    'GET /api/skins/alice/tiny/scene.svg': () => ({ text: scene }),
    'GET /api/skins/alice/bad': () => ({ json: { format: 1, slug: 'bad' } }),
  })
  const g = createGallery({ baseUrl: mock.url, deps: d })
  const r = await g.detail('alice', 'tiny')

  assert.equal(r.version, 3)
  assert.equal(r.scene, TINY_SCENE)
  assert.equal(r.skin.slug, 'tiny')
  scene = '<svg viewBox="0 0 1 1"><script>alert(1)</script></svg>'
  await assert.rejects(g.detail('alice', 'tiny'), /invalid scene/)
  scene = TINY_SCENE
  author = 'mallory'
  await assert.rejects(g.detail('alice', 'tiny'), /different skin/)
  await assert.rejects(g.detail('alice', 'bad'), /invalid skin/)
  await assert.rejects(g.detail('..', 'tiny'), /Not a gallery skin name/)
  await assert.rejects(g.detail('alice', 'missing'), e => e.status === 404)
})

test('gallery writes: download, report, upload, me, delete; read-only mode refuses them', async t => {
  const mock = await startMock(t, {
    'POST /api/skins/alice/tiny/download': () => ({ json: { ok: true, counted: true, downloads: 6 } }),
    'POST /api/skins/alice/tiny/report': () => ({ json: { ok: true, counted: true, hidden: false } }),
    'POST /api/skins': (req, body) => (req.headers.authorization === 'Bearer test-token' ? { status: 201, json: { ref: 'alice.tiny', version: 1, echo: JSON.parse(body) } } : { status: 401, json: { error: 'bad token' } }),
    'GET /api/me': () => ({ json: { handle: 'alice', skins: [item({ hidden: true, reports: 3 })] } }),
    'POST /api/me/handle': (req, body) => (JSON.parse(body).handle === 'taken' ? { status: 409, json: { error: 'taken' } } : { json: { handle: JSON.parse(body).handle } }),
    'DELETE /api/skins/alice/tiny': () => ({ json: { ok: true } }),
  })
  const d = await deps()
  const g = createGallery({ baseUrl: mock.url, deps: d })

  assert.equal((await g.download('alice', 'tiny')).downloads, 6)
  assert.equal((await g.report('alice', 'tiny')).hidden, false)
  assert.deepEqual(await g.upload('test-token', { skin: { slug: 'tiny' } }), { created: true, ref: 'alice.tiny', version: 1 })
  assert.equal(JSON.parse(mock.calls.at(-1).body).skin.slug, 'tiny')
  await assert.rejects(g.upload('wrong', {}), /bad token/)
  await assert.rejects(g.upload('', {}), /Not signed in/)
  const me = await g.me('test-token')

  assert.equal(me.handle, 'alice')
  assert.deepEqual(await g.claimHandle('test-token', 'new-name'), { handle: 'new-name' })
  assert.equal(JSON.parse(mock.calls.at(-1).body).handle, 'new-name')
  await assert.rejects(g.claimHandle('test-token', 'taken'), e => e.status === 409 && /taken/.test(e.message))
  await assert.rejects(g.claimHandle('test-token', 'Bad Name'), e => e.code === 'bad-handle')
  assert.equal(me.skins[0].hidden, true)
  assert.equal(me.skins[0].reports, 3)
  assert.deepEqual(await g.remove('test-token', 'alice', 'tiny'), { ok: true })

  const before = mock.calls.length
  const ro = createGallery({ baseUrl: mock.url, deps: d, readOnly: true })

  for (const p of [ro.download('alice', 'tiny'), ro.report('alice', 'tiny'), ro.upload('t', {}), ro.remove('t', 'alice', 'tiny')]) {
    await assert.rejects(p, /read-only/)
  }
  assert.equal(mock.calls.length, before)
})

test('http: timeouts and size caps', async t => {
  const mock = await startMock(t, {
    'GET /slow': () => ({ hang: true }),
    'GET /big': () => ({ text: 'x'.repeat(5000) }),
  })

  await assert.rejects(request(`${mock.url}/slow`, { timeoutMs: 150 }), e => e.code === 'timeout')
  await assert.rejects(request(`${mock.url}/big`, { maxBytes: 1000 }), e => e.code === 'too-large')
  await assert.rejects(request('http://127.0.0.1:1/x', { timeoutMs: 1000 }), e => e.code === 'network')
})

// A fake id token: header.payload.signature, payload { exp } (seconds).
const idTok = (expMs, tag = 'x') => `h.${Buffer.from(JSON.stringify({ exp: Math.floor(expMs / 1000), sub: tag })).toString('base64url')}.s`

test('loopback sign-in: openid only, PKCE S256, a wrong state is refused, the right one is taken once', async () => {
  let opened = null
  const flow = await startLoopback({ authUrl: 'https://accounts.example/o/oauth2/v2/auth', clientId: 'cid.apps', openExternal: async url => { opened = new URL(url) } })
  const q = opened.searchParams

  assert.equal(opened.origin + opened.pathname, 'https://accounts.example/o/oauth2/v2/auth')
  assert.deepEqual(
    [q.get('client_id'), q.get('response_type'), q.get('scope'), q.get('code_challenge_method'), q.get('access_type'), q.get('prompt')],
    ['cid.apps', 'code', 'openid', 'S256', 'offline', 'consent'],
  )
  assert.match(q.get('redirect_uri'), /^http:\/\/127\.0\.0\.1:\d+$/)
  assert.equal(q.get('redirect_uri'), flow.redirectUri)
  const crypto = require('node:crypto')

  assert.equal(q.get('code_challenge'), crypto.createHash('sha256').update(flow.verifier).digest('base64url'))
  // The browser comes back: first with a forged state, then a stray path, then the real redirect.
  const forged = await fetch(`${flow.redirectUri}/?code=evil&state=nope`)

  assert.equal(forged.status, 400)
  assert.equal((await fetch(`${flow.redirectUri}/favicon.ico`)).status, 404)
  const ok = await fetch(`${flow.redirectUri}/?code=good-code&state=${q.get('state')}`)

  assert.equal(ok.status, 200)
  assert.match(await ok.text(), /close this tab/)
  assert.deepEqual(await flow.result, { code: 'good-code' })
  await assert.rejects(fetch(`${flow.redirectUri}/?code=again&state=${q.get('state')}`), 'the listener is gone after one redirect')
})

test('loopback sign-in: not configured, denied, cancelled, timed out', async () => {
  await assert.rejects(startLoopback({ authUrl: 'https://a.example', clientId: '', openExternal: async () => {} }), e => e.code === 'not-configured')
  let state = null
  const denied = await startLoopback({ authUrl: 'https://a.example', clientId: 'c', openExternal: async url => { state = new URL(url).searchParams.get('state') } })

  await fetch(`${denied.redirectUri}/?error=access_denied&state=${state}`)
  assert.deepEqual(await denied.result, { error: 'access_denied' })
  const cancelled = await startLoopback({ authUrl: 'https://a.example', clientId: 'c', openExternal: async () => {} })

  cancelled.cancel()
  assert.deepEqual(await cancelled.result, { error: 'cancelled' })
  const slow = await startLoopback({ authUrl: 'https://a.example', clientId: 'c', openExternal: async () => {}, timeoutMs: 50 })

  assert.deepEqual(await slow.result, { error: 'timeout' })
})

test('token endpoint: code exchange sends the PKCE verifier; refresh; invalid_grant', async t => {
  const now = 1_800_000_000_000
  let revoked = false
  const mock = await startMock(t, {
    'POST /token': (_req, body) => {
      const f = new URLSearchParams(body)

      if (f.get('grant_type') === 'authorization_code') {
        return f.get('code_verifier') === 'the-verifier' && f.get('client_secret') === 'sec' && f.get('redirect_uri') === 'http://127.0.0.1:5555'
          ? { json: { refresh_token: 'r1', id_token: idTok(now + 3600_000, 'a'), expires_in: 3599 } }
          : { status: 400, json: { error: 'invalid_request' } }
      }

      return revoked ? { status: 400, json: { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' } } : { json: { id_token: idTok(now + 3600_000, 'b'), expires_in: 3599 } }
    },
  })
  const base = { tokenUrl: `${mock.url}/token`, clientId: 'cid', clientSecret: 'sec', now: () => now }
  const first = await exchangeCode({ ...base, code: 'c', verifier: 'the-verifier', redirectUri: 'http://127.0.0.1:5555' })

  assert.equal(first.refreshToken, 'r1')
  assert.equal(first.expiresAt, now + 3600_000 - ((now + 3600_000) % 1000))
  await assert.rejects(exchangeCode({ ...base, code: 'c', verifier: 'wrong', redirectUri: 'http://127.0.0.1:5555' }), e => e.code === 'invalid_request')
  const fresh = await refreshIdToken({ ...base, refreshToken: 'r1' })

  assert.equal(JSON.parse(Buffer.from(fresh.idToken.split('.')[1], 'base64url')).sub, 'b')
  assert.equal(new URLSearchParams(mock.calls.at(-1).body).get('grant_type'), 'refresh_token')
  assert.equal(isFresh(fresh, now), true)
  assert.equal(isFresh(fresh, fresh.expiresAt - 4 * 60_000), false, 'refreshed 5 minutes before exp')
  assert.equal(expiryOf('garbage'), null)
  revoked = true
  await assert.rejects(refreshIdToken({ ...base, refreshToken: 'r1' }), e => e.code === 'invalid_grant')
})

test('token store: lazy, encrypted, cleared on sign-out', async t => {
  const dir = tempDir(t)
  const file = path.join(dir, 'auth', 'google-refresh-token.bin')
  let touched = 0
  const fake = {
    isEncryptionAvailable: () => true,
    encryptString: s => Buffer.from(`enc:${Buffer.from(s).toString('base64')}`),
    decryptString: b => Buffer.from(String(b).slice(4), 'base64').toString(),
  }
  const store = createTokenStore({ file, getSafeStorage: () => { touched++; return fake } })

  assert.equal(await store.load(), null)
  assert.equal(touched, 0)
  assert.deepEqual(await store.save('gho_fake'), { ok: true, persisted: true })
  assert.ok(!fs.readFileSync(file, 'utf8').includes('gho_fake'))
  const again = createTokenStore({ file, getSafeStorage: () => fake })

  assert.equal(await again.load(), 'gho_fake')
  await again.clear()
  assert.equal(fs.existsSync(file), false)
  assert.equal(await again.load(), null)

  const plain = createTokenStore({ file, getSafeStorage: () => ({ isEncryptionAvailable: () => false }) })

  assert.deepEqual(await plain.save('gho_fake'), { ok: true, persisted: false })
  assert.equal(fs.existsSync(file), false)
  assert.equal(await plain.load(), 'gho_fake')
})

test('importFolder and prepareUpload run the gallery checks before anything is sent', async t => {
  const d = await deps()
  const dir = tempDir(t)

  assert.match((await importFolder(dir)).errors[0], /no skin.json/)
  fs.writeFileSync(path.join(dir, 'skin.json'), '{nope')
  assert.match((await importFolder(dir)).errors[0], /not valid JSON/)
  fs.writeFileSync(path.join(dir, 'skin.json'), JSON.stringify({ ...tinySkin(), author: 'x', version: 9 }))
  let imported = await importFolder(dir)

  assert.equal(imported.scene, null)
  let prep = prepareUpload({ ...imported, deps: d })

  assert.equal(prep.ok, false)
  assert.match(prep.errors[0], /no scene.svg/)
  fs.writeFileSync(path.join(dir, 'scene.svg'), TINY_SCENE)
  imported = await importFolder(dir)
  prep = prepareUpload({ ...imported, deps: d })
  assert.equal(prep.ok, true, prep.errors.join('\n'))
  assert.equal(prep.payload.scene, TINY_SCENE)
  assert.equal(prep.payload.skin.author, undefined)
  assert.equal(prep.payload.skin.version, undefined)

  // No backdrop.scene: the scene must not be sent (the gallery refuses it).
  const { backdrop, ...plain } = tinySkin()

  assert.equal(prepareUpload({ skin: plain, scene: TINY_SCENE, deps: d }).payload.scene, undefined)
  assert.equal(prepareUpload({ skin: { format: 1 }, scene: null, deps: d }).ok, false)
  assert.match(prepareUpload({ skin: tinySkin(), scene: '<svg><script/></svg>', deps: d }).errors[0], /^scene: /)
  const murky = { ...plain, colors: { dark: { anchors: { 'surface-0': '#101114', 'text-primary': '#141518' } } } }

  assert.match(prepareUpload({ skin: murky, scene: null, deps: d }).errors[0], /^colors: /)
  assert.ok(backdrop)
})

test('bakeTuning writes current values as defaults under a new slug', async () => {
  const d = await deps()
  const base = d.validateSkin({ ...tinySkin(), author: 'alice', version: 3 }).skin
  const baked = bakeTuning(base, { glow: '#00FF88', size: 1.234, stars: false, ghost: 1 }, { slug: 'tiny-mine', name: '  Mine ' })

  assert.equal(baked.slug, 'tiny-mine')
  assert.equal(baked.name, 'Mine')
  assert.equal(baked.author, undefined)
  assert.deepEqual(baked.variables.map(v => v.default), ['#00ff88', 1.2, false])
  assert.equal(base.variables[0].default, '#f5c24a')
  assert.equal(d.validateSkin(baked).ok, true)
  assert.throws(() => bakeTuning(base, {}, { slug: 'Bad Slug' }), /a-z/)
  assert.equal(freeSlug('Tiny', new Set(['tiny-2'])), 'tiny-3')
})
