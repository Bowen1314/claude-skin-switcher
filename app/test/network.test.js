'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const { createGallery, listItem } = require('../src/gallery')
const { pollForToken, requestDeviceCode, GRANT } = require('../src/github')
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
    'GET /api/me': () => ({ json: { login: 'Alice', skins: [item({ hidden: true, reports: 3 })] } }),
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

  assert.equal(me.login, 'alice')
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

test('device flow: code, pending, slow_down uses the returned interval, then a token', async t => {
  const answers = [{ error: 'authorization_pending' }, { error: 'slow_down', interval: 10 }, { error: 'authorization_pending' }, { access_token: 'gho_fake', token_type: 'bearer' }]
  const mock = await startMock(t, {
    'POST /login/device/code': (_r, body) => ({ json: { device_code: 'dev123', user_code: 'ABCD-1234', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 5, echo: body } }),
    'POST /login/oauth/access_token': () => ({ status: 200, json: answers.shift() }),
  })

  await assert.rejects(requestDeviceCode({ githubUrl: mock.url, clientId: '' }), e => e.code === 'not-configured')
  assert.equal(mock.calls.length, 0)
  const code = await requestDeviceCode({ githubUrl: mock.url, clientId: 'Iv1.test' })

  assert.deepEqual(code, { deviceCode: 'dev123', userCode: 'ABCD-1234', verificationUri: 'https://github.com/login/device', interval: 5, expiresIn: 900 })
  assert.equal(new URLSearchParams(mock.calls[0].body).get('client_id'), 'Iv1.test')
  assert.equal(new URLSearchParams(mock.calls[0].body).get('scope'), null)
  assert.equal(mock.calls[0].headers.accept, 'application/json')

  const waits = []
  let clock = 0
  const r = await pollForToken({ githubUrl: mock.url, clientId: 'Iv1.test', deviceCode: 'dev123', interval: 5, expiresIn: 900, sleep: async ms => { waits.push(ms); clock += ms }, now: () => clock })

  assert.deepEqual(r, { token: 'gho_fake' })
  assert.deepEqual(waits, [5000, 5000, 10000, 10000])
  const poll = new URLSearchParams(mock.calls[1].body)

  assert.equal(poll.get('grant_type'), GRANT)
  assert.equal(poll.get('device_code'), 'dev123')
})

test('device flow: expiry, denial, cancel, and errors in a 4xx body', async t => {
  let answer = { error: 'authorization_pending' }
  const mock = await startMock(t, {
    'POST /login/oauth/access_token': () => ({ status: 400, json: answer }),
  })
  let clock = 0
  const base = { githubUrl: mock.url, clientId: 'Iv1.test', deviceCode: 'd', interval: 5, sleep: async ms => { clock += ms }, now: () => clock }

  assert.deepEqual(await pollForToken({ ...base, expiresIn: 12 }), { error: 'expired_token' })
  answer = { error: 'access_denied' }
  assert.deepEqual(await pollForToken({ ...base, expiresIn: 900 }), { error: 'access_denied' })
  answer = { error: 'authorization_pending' }
  let cancelled = false
  const p = pollForToken({ ...base, expiresIn: 900, sleep: async () => { cancelled = true }, isCancelled: () => cancelled })

  assert.deepEqual(await p, { error: 'cancelled' })
})

test('token store: lazy, encrypted, cleared on sign-out', async t => {
  const dir = tempDir(t)
  const file = path.join(dir, 'auth', 'github.bin')
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
