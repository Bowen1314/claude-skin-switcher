import { test, beforeEach, before } from 'node:test';
import assert from 'node:assert/strict';

import { handle, LIMITS, previewOf, newJwksCache, isReservedHandle } from '../src/handler.js';
import { FakeD1 } from './fake-d1.js';

const ADMIN = 'a'.repeat(64);
const SALT = 's'.repeat(64);
const CLIENT_ID = 'test-client.apps.googleusercontent.com';
const JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

let env;
let clock;
let jwks;
let jwksFetches;
let published;
const K = {}; // kid -> { privateKey, jwk }

async function newKey(kid) {
  const kp = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  );
  const pub = await crypto.subtle.exportKey('jwk', kp.publicKey);
  return { privateKey: kp.privateKey, jwk: { kty: 'RSA', n: pub.n, e: pub.e, kid, alg: 'RS256', use: 'sig' } };
}

before(async () => {
  for (const kid of ['k1', 'k2', 'evil']) K[kid] = await newKey(kid);
});

// Stubbed network: only Google's JWKS is reachable.
async function fakeFetch(url) {
  assert.equal(url, JWKS_URL, `unexpected fetch: ${url}`);
  jwksFetches++;
  return Response.json({ keys: published.map((kid) => K[kid].jwk) }, { headers: { 'Cache-Control': 'public, max-age=3600, must-revalidate' } });
}

const b64url = (bytes) => Buffer.from(bytes).toString('base64url');
const b64json = (v) => b64url(new TextEncoder().encode(JSON.stringify(v)));

async function mint(sub, { claims = {}, kid = 'k1', signWith = kid, header = {} } = {}) {
  const nowS = Math.floor(clock.t / 1000);
  const h = b64json({ alg: 'RS256', kid, typ: 'JWT', ...header });
  const p = b64json({ iss: 'https://accounts.google.com', aud: CLIENT_ID, sub, iat: nowS, exp: nowS + 3600, ...claims });
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', K[signWith].privateKey, new TextEncoder().encode(`${h}.${p}`));
  return `${h}.${p}.${b64url(new Uint8Array(sig))}`;
}

beforeEach(() => {
  env = { DB: new FakeD1(), ADMIN_TOKEN: ADMIN, IP_SALT: SALT, GOOGLE_CLIENT_ID: CLIENT_ID };
  clock = { t: 1_800_000_000_000 };
  jwks = newJwksCache();
  jwksFetches = 0;
  published = ['k1'];
});

// `as` mints a fresh, valid ID token for sub "sub-<as>"; `token` sends a raw one.
async function call(method, path, { as, token, body, raw, headers = {}, ip = '203.0.113.1' } = {}) {
  const h = { 'CF-Connecting-IP': ip, ...headers };
  if (as) h.Authorization = `Bearer ${await mint(`sub-${as}`)}`;
  if (token) h.Authorization = `Bearer ${token}`;
  let payload;
  if (raw !== undefined) payload = raw;
  else if (body !== undefined) {
    payload = JSON.stringify(body);
    h['Content-Type'] = 'application/json';
  }
  const res = await handle(new Request(`https://skins.example${path}`, { method, headers: h, body: payload }), env, {
    fetch: fakeFetch,
    now: () => clock.t,
    jwks,
  });
  const type = res.headers.get('Content-Type') || '';
  const data = type.startsWith('application/json') ? await res.json() : await res.text();
  return { status: res.status, data, headers: res.headers };
}

async function claim(as, handleName = as) {
  const r = await call('POST', '/api/me/handle', { as, body: { handle: handleName } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r;
}

function skin(slug = 'test-skin', over = {}) {
  return {
    format: 1,
    slug,
    name: `Skin ${slug}`,
    description: 'A test skin.',
    tags: ['dark'],
    colors: {
      roles: { accent: '#35b8c9' },
      dark: { anchors: { 'surface-0': '#0e1013', 'surface-1': '#14171b', 'text-primary': '#e6e9ee', 'text-muted': '#8a919c' } },
    },
    ...over,
  };
}

const SCENE = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="#123456"/></svg>';
const sceneSkin = (slug = 'scene-skin') => skin(slug, { backdrop: { scene: true, glass: { blur: 8 } } });

test('home, health, unknown routes, wrong methods', async () => {
  // The home page, privacy policy and terms live on the website now.
  const SITE = 'https://bowen1314.github.io/claude-skin-switcher/';
  for (const [path, to] of [['/', SITE], ['/privacy', `${SITE}privacy.html`], ['/terms', `${SITE}terms.html`]]) {
    for (const method of ['GET', 'HEAD']) {
      const r = await call(method, path);
      assert.equal(r.status, 301, `${method} ${path}`);
      assert.equal(r.headers.get('Location'), to, `${method} ${path}`);
    }
    assert.equal((await call('POST', path)).status, 405);
  }
  assert.equal((await call('GET', '/privacy.html')).status, 404);
  assert.equal((await call('GET', '/terms/x')).status, 404);
  const h = await call('GET', '/api/health');
  assert.deepEqual([h.status, h.data], [200, { ok: true }]);
  assert.equal(h.headers.get('Access-Control-Allow-Origin'), '*');
  assert.equal((await call('GET', '/nope')).status, 404);
  assert.equal((await call('GET', '/api/nope')).status, 404);
  assert.equal((await call('PATCH', '/api/skins')).status, 405);
  assert.equal((await call('GET', '/api/me/handle')).status, 405);
  assert.equal((await call('GET', '/api/skins/Bad_Author/x')).status, 404);
  const pre = await call('OPTIONS', '/api/skins');
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get('Access-Control-Allow-Origin'), '*');
});

test('empty list', async () => {
  const r = await call('GET', '/api/skins');
  assert.equal(r.status, 200);
  assert.deepEqual(r.data, { items: [], nextCursor: null });
  assert.equal(r.headers.get('Access-Control-Allow-Origin'), '*');
  assert.equal((await call('GET', '/api/skins?sort=hot')).status, 400);
  assert.equal((await call('GET', '/api/skins?limit=51')).status, 400);
  assert.equal((await call('GET', '/api/skins?limit=0')).status, 400);
  assert.equal((await call('GET', '/api/skins?cursor=garbage!')).status, 400);
  assert.equal((await call('GET', '/api/skins?tag=Bad%20Tag')).status, 400);
});

// ------------------------------------------------------------- Google auth

test('auth: missing header, garbage token, auth before validation', async () => {
  const none = await call('POST', '/api/skins', { body: { skin: skin() } });
  assert.equal(none.status, 401);
  assert.ok(none.data.error);
  assert.equal((await call('POST', '/api/skins', { token: 'garbage', body: { skin: { nope: 1 } } })).status, 401);
  assert.equal((await call('POST', '/api/skins', { token: 'a.b.c', body: { skin: { nope: 1 } } })).status, 401);
  assert.equal((await call('GET', '/api/me', { token: 'gho_0123456789abcdef' })).status, 401);
  assert.equal(jwksFetches, 0, 'garbage never reaches the network');
});

test('auth: a valid ID token is accepted; sub is stored only as HMAC; keys are cached', async () => {
  const me = await call('GET', '/api/me', { as: 'alice' });
  assert.deepEqual([me.status, me.data], [200, { handle: null, skins: [] }]);
  await claim('alice');
  await call('GET', '/api/me', { as: 'alice' });
  assert.equal(jwksFetches, 1, 'JWKS fetched once and cached');
  const rows = env.DB.raw('SELECT * FROM accounts');
  assert.equal(rows.length, 1);
  assert.match(rows[0].sub_hash, /^[0-9a-f]{64}$/);
  // HMAC-SHA256(key = IP_SALT, message = sub)
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(SALT), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const expect = Buffer.from(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode('sub-alice'))).toString('hex');
  assert.equal(rows[0].sub_hash, expect);
  const dump = JSON.stringify([env.DB.raw('SELECT * FROM accounts'), env.DB.raw('SELECT * FROM handle_log')]);
  assert.ok(!dump.includes('sub-alice'), 'raw sub is never stored');
  // Cache-Control max-age (3600 s) is honoured.
  clock.t += HOUR + 1000;
  await call('GET', '/api/me', { as: 'alice' });
  assert.equal(jwksFetches, 2);
});

test('auth: bad signature, wrong aud, wrong iss, expired, future iat, alg', async () => {
  const nowS = Math.floor(clock.t / 1000);
  const cases = [
    [await mint('sub-x', { kid: 'k1', signWith: 'evil' }), 'invalid token signature'],
    [await mint('sub-x', { claims: { aud: 'someone-else.apps.googleusercontent.com' } }), 'token has the wrong audience'],
    [await mint('sub-x', { claims: { aud: [CLIENT_ID] } }), 'token has the wrong audience'],
    [await mint('sub-x', { claims: { iss: 'https://evil.example' } }), 'token has the wrong issuer'],
    [await mint('sub-x', { claims: { exp: nowS - 61 } }), 'token expired'],
    [await mint('sub-x', { claims: { iat: nowS + 120 } }), 'token issued in the future'],
    [await mint('sub-x', { claims: { sub: '' } }), 'invalid token'],
    [await mint('sub-x', { header: { alg: 'HS256' } }), 'invalid token'],
    [await mint('sub-x', { header: { alg: 'none' } }), 'invalid token'],
  ];
  for (const [token, error] of cases) {
    const r = await call('GET', '/api/me', { token });
    assert.deepEqual([r.status, r.data.error], [401, error]);
  }
  // Tampered payload with the original signature.
  const good = await mint('sub-x');
  const [h, , sig] = good.split('.');
  const forged = `${h}.${b64json({ iss: 'accounts.google.com', aud: CLIENT_ID, sub: 'sub-admin', iat: nowS, exp: nowS + 3600 })}.${sig}`;
  assert.equal((await call('GET', '/api/me', { token: forged })).data.error, 'invalid token signature');
  // Within leeway: expired 30 s ago and iat 30 s ahead are accepted; plain issuer form is accepted.
  assert.equal((await call('GET', '/api/me', { token: await mint('sub-x', { claims: { exp: nowS - 30 } }) })).status, 200);
  assert.equal((await call('GET', '/api/me', { token: await mint('sub-x', { claims: { iat: nowS + 30 } }) })).status, 200);
  assert.equal((await call('GET', '/api/me', { token: await mint('sub-x', { claims: { iss: 'accounts.google.com' } }) })).status, 200);
});

test('auth: unknown kid triggers one refetch (rate limited), then rotated keys work', async () => {
  assert.equal((await call('GET', '/api/me', { as: 'alice' })).status, 200);
  assert.equal(jwksFetches, 1);
  // Google rotates: k2 is now published, but our cache still has the old set.
  published = ['k1', 'k2'];
  // Right after a fetch, an unknown kid does not refetch (cooldown).
  const early = await call('GET', '/api/me', { token: await mint('sub-alice', { kid: 'k2' }) });
  assert.deepEqual([early.status, early.data.error, jwksFetches], [401, 'unknown signing key', 1]);
  clock.t += LIMITS.jwksRefetchCooldownMs;
  const later = await call('GET', '/api/me', { token: await mint('sub-alice', { kid: 'k2' }) });
  assert.equal(later.status, 200);
  assert.equal(jwksFetches, 2, 'refetched once');
  // A kid that is never published: one refetch at most, then 401.
  clock.t += LIMITS.jwksRefetchCooldownMs;
  const bogus = await call('GET', '/api/me', { token: await mint('sub-alice', { kid: 'nope', signWith: 'evil' }) });
  assert.deepEqual([bogus.status, jwksFetches], [401, 3]);
  const again = await call('GET', '/api/me', { token: await mint('sub-alice', { kid: 'nope', signWith: 'evil' }) });
  assert.deepEqual([again.status, jwksFetches], [401, 3]);
});

test('auth: JWKS outage gives 502', async () => {
  const res = await handle(
    new Request('https://skins.example/api/me', { headers: { Authorization: `Bearer ${await mint('sub-a')}` } }),
    env,
    { fetch: async () => new Response('down', { status: 500 }), now: () => clock.t, jwks },
  );
  assert.equal(res.status, 502);
});

test('sign-in not configured: empty GOOGLE_CLIENT_ID gives 503 on authenticated calls; garbage still 401', async () => {
  env.GOOGLE_CLIENT_ID = '';
  const token = await mint('sub-alice');
  for (const [method, path, body] of [
    ['GET', '/api/me'],
    ['POST', '/api/me/handle', { handle: 'alice' }],
    ['POST', '/api/skins', { skin: skin() }],
    ['DELETE', '/api/skins/alice/test-skin'],
  ]) {
    const r = await call(method, path, { token, body });
    assert.deepEqual([r.status, r.data.error], [503, 'sign-in not configured'], `${method} ${path}`);
  }
  assert.equal((await call('GET', '/api/me', { token: 'garbage' })).status, 401);
  assert.equal((await call('GET', '/api/me')).status, 401);
  assert.equal(jwksFetches, 0);
  delete env.GOOGLE_CLIENT_ID;
  assert.equal((await call('GET', '/api/me', { token })).status, 503);
});

// ------------------------------------------------------------------ handles

test('handle claim: pattern, reserved, normalize, idempotent, conflict, change, lock', async () => {
  for (const bad of ['ab', '-abc', 'abc-', 'a_b_c', 'x'.repeat(33), 42, '']) {
    const r = await call('POST', '/api/me/handle', { as: 'alice', body: { handle: bad } });
    assert.equal(r.status, 400, String(bad));
  }
  assert.equal((await call('POST', '/api/me/handle', { as: 'alice', body: {} })).status, 400);
  for (const reserved of ['official', 'default', 'local', 'admin', 'root', 'support', 'anthropic', 'claude', 'gallery', 'api', 'official-fan', 'officialx']) {
    const r = await call('POST', '/api/me/handle', { as: 'alice', body: { handle: reserved } });
    assert.deepEqual([r.status, r.data.error], [409, 'handle reserved'], reserved);
  }
  assert.equal(isReservedHandle('unofficial'), false);

  const first = await call('POST', '/api/me/handle', { as: 'alice', body: { handle: '  Alice  ' } });
  assert.deepEqual([first.status, first.data], [200, { handle: 'alice' }]);
  const same = await call('POST', '/api/me/handle', { as: 'alice', body: { handle: 'alice' } });
  assert.deepEqual([same.status, same.data], [200, { handle: 'alice' }]);

  const taken = await call('POST', '/api/me/handle', { as: 'bob', body: { handle: 'alice' } });
  assert.deepEqual([taken.status, taken.data.error], [409, 'handle taken']);

  // Change while the account has no skins.
  await claim('alice', 'alice-two');
  assert.equal((await call('GET', '/api/me', { as: 'alice' })).data.handle, 'alice-two');
  await claim('bob', 'alice'); // freed
  // After an upload the handle is locked; re-claiming the same value still works.
  assert.equal((await call('POST', '/api/skins', { as: 'alice', body: { skin: skin() } })).status, 201);
  const locked = await call('POST', '/api/me/handle', { as: 'alice', body: { handle: 'alice-three' } });
  assert.deepEqual([locked.status, locked.data.error], [409, 'handle locked']);
  assert.equal((await call('POST', '/api/me/handle', { as: 'alice', body: { handle: 'alice-two' } })).status, 200);
  // Deleting the last skin unlocks it.
  assert.equal((await call('DELETE', '/api/skins/alice-two/test-skin', { as: 'alice' })).status, 200);
  await claim('alice', 'alice-three');
});

test('handle claim: author names used by admin-placed skins count as taken', async () => {
  await call('PUT', '/api/admin/skins/someone/test-skin', { body: { skin: skin() }, headers: { 'X-Admin-Token': ADMIN } });
  const r = await call('POST', '/api/me/handle', { as: 'alice', body: { handle: 'someone' } });
  assert.deepEqual([r.status, r.data.error], [409, 'handle taken']);
});

test('handle claim: rate limited', async () => {
  for (let i = 0; i < LIMITS.handleClaimsPerDay; i++) await claim('alice', `name-${i}`);
  const over = await call('POST', '/api/me/handle', { as: 'alice', body: { handle: 'name-x' } });
  assert.equal(over.status, 429);
  // Idempotent re-claims don't count and still succeed.
  assert.equal((await call('POST', '/api/me/handle', { as: 'alice', body: { handle: `name-${LIMITS.handleClaimsPerDay - 1}` } })).status, 200);
  clock.t += DAY;
  await claim('alice', 'name-x');
});

// ------------------------------------------------------------------ uploads

test('upload without a handle is refused', async () => {
  const r = await call('POST', '/api/skins', { as: 'alice', body: { skin: skin() } });
  assert.deepEqual([r.status, r.data.error], [409, 'no handle']);
});

test('upload creates and bumps under the handle', async () => {
  await claim('alice');
  const a = await call('POST', '/api/skins', { as: 'alice', body: { skin: { ...skin(), author: 'mallory', version: 99 } } });
  assert.deepEqual([a.status, a.data], [201, { ref: 'alice.test-skin', version: 1 }]);
  const b = await call('POST', '/api/skins', { as: 'alice', body: { skin: skin('test-skin', { name: 'Renamed' }) } });
  assert.deepEqual([b.status, b.data], [200, { ref: 'alice.test-skin', version: 2 }]);

  const d = await call('GET', '/api/skins/alice/test-skin');
  assert.equal(d.status, 200);
  assert.equal(d.data.author, 'alice');
  assert.equal(d.data.version, 2);
  assert.equal(d.data.name, 'Renamed');
  assert.equal(d.headers.get('Access-Control-Allow-Origin'), '*');

  const me = await call('GET', '/api/me', { as: 'alice' });
  assert.equal(me.data.handle, 'alice');
  assert.deepEqual(me.data.skins.map((s) => [s.ref, s.version, s.hidden, s.reports]), [['alice.test-skin', 2, false, 0]]);
  const created = env.DB.raw('SELECT created_at, updated_at FROM skins')[0];
  assert.ok(created.updated_at >= created.created_at);
});

test('upload validation: invalid skin, refused svg, scene mismatch, oversized, bad JSON', async () => {
  await claim('alice');
  const bad = await call('POST', '/api/skins', { as: 'alice', body: { skin: skin('x') } });
  assert.equal(bad.status, 400);
  assert.equal(bad.data.error, 'invalid skin');
  assert.ok(bad.data.errors.some((e) => e.startsWith('$.slug')));

  const svg = await call('POST', '/api/skins', {
    as: 'alice',
    body: { skin: sceneSkin(), scene: '<svg viewBox="0 0 1 1"><ScRiPt>alert(1)</ScRiPt></svg>' },
  });
  assert.equal(svg.status, 400);
  assert.equal(svg.data.error, 'invalid scene');

  assert.equal((await call('POST', '/api/skins', { as: 'alice', body: { skin: sceneSkin() } })).status, 400);
  assert.equal((await call('POST', '/api/skins', { as: 'alice', body: { skin: skin(), scene: SCENE } })).status, 400);
  assert.equal((await call('POST', '/api/skins', { as: 'alice', body: { nope: true } })).status, 400);
  assert.equal((await call('POST', '/api/skins', { as: 'alice', raw: '{not json' })).status, 400);

  const huge = JSON.stringify({ skin: skin(), pad: 'x'.repeat(LIMITS.bodyMaxBytes) });
  assert.equal((await call('POST', '/api/skins', { as: 'alice', raw: huge })).status, 413);
  // No Content-Length (streamed): the byte cap still applies.
  const stream = new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode(huge));
      c.close();
    },
  });
  const res = await handle(
    new Request('https://skins.example/api/skins', {
      method: 'POST',
      headers: { Authorization: `Bearer ${await mint('sub-alice')}` },
      body: stream,
      duplex: 'half',
    }),
    env,
    { fetch: fakeFetch, now: () => clock.t, jwks },
  );
  assert.equal(res.status, 413);
  assert.equal(env.DB.raw('SELECT COUNT(*) AS n FROM skins')[0].n, 0);
});

test('scene upload and scene.svg endpoint headers', async () => {
  await claim('alice');
  const up = await call('POST', '/api/skins', { as: 'alice', body: { skin: sceneSkin(), scene: SCENE } });
  assert.equal(up.status, 201);
  const s = await call('GET', '/api/skins/alice/scene-skin/scene.svg');
  assert.equal(s.status, 200);
  assert.equal(s.data, SCENE);
  assert.match(s.headers.get('Content-Type'), /^image\/svg\+xml/);
  assert.equal(s.headers.get('Content-Security-Policy'), "default-src 'none'; style-src 'unsafe-inline'");
  assert.equal(s.headers.get('X-Content-Type-Options'), 'nosniff');
  await call('POST', '/api/skins', { as: 'alice', body: { skin: skin('plain-skin') } });
  assert.equal((await call('GET', '/api/skins/alice/plain-skin/scene.svg')).status, 404);
  const list = await call('GET', '/api/skins');
  const byRef = Object.fromEntries(list.data.items.map((i) => [i.ref, i]));
  assert.equal(byRef['alice.scene-skin'].hasScene, true);
  assert.equal(byRef['alice.plain-skin'].hasScene, false);
});

test('rate limit: 10 uploads per account per 24 h', async () => {
  await claim('alice');
  await claim('bob');
  for (let i = 0; i < 10; i++) {
    const r = await call('POST', '/api/skins', { as: 'alice', body: { skin: skin(`skin-${i}`) } });
    assert.equal(r.status, 201, `upload ${i}`);
    clock.t += 1000;
  }
  const over = await call('POST', '/api/skins', { as: 'alice', body: { skin: skin('skin-10') } });
  assert.equal(over.status, 429);
  assert.ok(over.headers.get('Retry-After'));
  // skin() gives every slug the same palette, and identical palette-only skins share a fingerprint.
  assert.equal((await call('POST', '/api/skins', { as: 'bob', body: { skin: skin('skin-10', { style: { UserMessage: { radius: 7 } } }) } })).status, 201);
  clock.t += DAY;
  assert.equal((await call('POST', '/api/skins', { as: 'alice', body: { skin: skin('skin-10') } })).status, 201);
});

test('listing: pagination with ties, popular sort, q, tag, preview', async () => {
  for (const who of ['alice', 'bob', 'carol']) await claim(who);
  const plan = [
    ['alice', 'aaa', 0],
    ['bob', 'bbb', 0],
    ['carol', 'ccc', 0],
    ['alice', 'ddd', 5],
    ['bob', 'eee', 9],
  ];
  for (const [i, [who, slug, dt]] of plan.entries()) {
    clock.t = 1_800_000_000_000 + dt;
    // skin() gives every slug the same palette; make each one different so no two authors share a fingerprint.
    const extra = { style: { UserMessage: { radius: i } }, ...(slug === 'ddd' ? { tags: ['light', 'cozy'], description: 'Warm Fireflies' } : {}) };
    assert.equal((await call('POST', '/api/skins', { as: who, body: { skin: skin(slug, extra) } })).status, 201);
  }
  const seen = [];
  let cursor = null;
  let pages = 0;
  do {
    const r = await call('GET', `/api/skins?limit=2${cursor ? `&cursor=${cursor}` : ''}`);
    assert.equal(r.status, 200);
    assert.ok(r.data.items.length <= 2);
    seen.push(...r.data.items.map((i) => i.ref));
    cursor = r.data.nextCursor;
    pages++;
  } while (cursor && pages < 10);
  assert.equal(pages, 3);
  assert.deepEqual(seen, ['bob.eee', 'alice.ddd', 'carol.ccc', 'bob.bbb', 'alice.aaa']);

  await call('POST', '/api/skins/alice/aaa/download', { ip: '198.51.100.1' });
  await call('POST', '/api/skins/alice/aaa/download', { ip: '198.51.100.2' });
  await call('POST', '/api/skins/carol/ccc/download', { ip: '198.51.100.1' });
  const pop = await call('GET', '/api/skins?sort=popular&limit=3');
  assert.deepEqual(pop.data.items.map((i) => [i.ref, i.downloads]), [['alice.aaa', 2], ['carol.ccc', 1], ['bob.eee', 0]]);
  const pop2 = await call('GET', `/api/skins?sort=popular&limit=3&cursor=${pop.data.nextCursor}`);
  assert.deepEqual(pop2.data.items.map((i) => i.ref), ['alice.ddd', 'bob.bbb']);
  assert.equal(pop2.data.nextCursor, null);
  assert.equal((await call('GET', `/api/skins?sort=new&cursor=${pop.data.nextCursor}`)).status, 400);

  assert.deepEqual((await call('GET', '/api/skins?q=FIREFLIES')).data.items.map((i) => i.ref), ['alice.ddd']);
  assert.deepEqual((await call('GET', '/api/skins?q=carol')).data.items.map((i) => i.ref), ['carol.ccc']);
  assert.deepEqual((await call('GET', '/api/skins?q=%25')).data.items, []);
  assert.deepEqual((await call('GET', '/api/skins?tag=cozy')).data.items.map((i) => i.ref), ['alice.ddd']);

  const item = (await call('GET', '/api/skins?limit=1')).data.items[0];
  assert.deepEqual(Object.keys(item).sort(), ['author', 'description', 'downloads', 'hasScene', 'name', 'preview', 'ref', 'slug', 'tags', 'updatedAt', 'version'].sort());
  assert.deepEqual(item.preview, { dark: { surface0: '#0e1013', surface1: '#14171b', text: '#e6e9ee', muted: '#8a919c', accent: '#35b8c9' } });
});

test('preview fallbacks', () => {
  const p = previewOf({ light: { anchors: { 'surface-0': '#ffffff', 'text-primary': '#000000', 'text-secondary': '#333333' } } });
  assert.deepEqual(Object.keys(p), ['light']);
  assert.equal(p.light.muted, '#333333');
  assert.equal(p.light.accent, '#d97757');
  assert.match(p.light.surface1, /^#[0-9a-f]{6}$/);
  const q = previewOf({ dark: { anchors: { 'surface-0': '#000000', 'text-primary': '#ffffff' } } });
  assert.match(q.dark.muted, /^#[0-9a-f]{6}$/);
  assert.deepEqual(previewOf(null), {});
});

test('owner-only delete', async () => {
  await claim('alice');
  await claim('bob');
  await call('POST', '/api/skins', { as: 'alice', body: { skin: skin() } });
  assert.equal((await call('DELETE', '/api/skins/alice/test-skin')).status, 401);
  assert.equal((await call('DELETE', '/api/skins/alice/test-skin', { as: 'bob' })).status, 403);
  assert.equal((await call('DELETE', '/api/skins/alice/test-skin', { as: 'dave' })).status, 403, 'no handle, not the owner');
  const ok = await call('DELETE', '/api/skins/alice/test-skin', { as: 'alice' });
  assert.deepEqual([ok.status, ok.data], [200, { ok: true, ref: 'alice.test-skin' }]);
  assert.equal((await call('DELETE', '/api/skins/alice/test-skin', { as: 'alice' })).status, 404);
  assert.equal((await call('GET', '/api/skins/alice/test-skin')).status, 404);
});

test('downloads are deduped per salted IP per skin per day', async () => {
  await claim('alice');
  await call('POST', '/api/skins', { as: 'alice', body: { skin: skin() } });
  const a = await call('POST', '/api/skins/alice/test-skin/download');
  assert.deepEqual(a.data, { ok: true, counted: true, downloads: 1 });
  const b = await call('POST', '/api/skins/alice/test-skin/download');
  assert.deepEqual(b.data, { ok: true, counted: false, downloads: 1 });
  const c = await call('POST', '/api/skins/alice/test-skin/download', { ip: '203.0.113.2' });
  assert.equal(c.data.downloads, 2);
  clock.t += DAY;
  const d = await call('POST', '/api/skins/alice/test-skin/download');
  assert.equal(d.data.downloads, 3);
  assert.equal((await call('POST', '/api/skins/alice/nope-skin/download')).status, 404);
  assert.ok(!JSON.stringify(env.DB.raw('SELECT * FROM download_seen')).includes('203.0.113'));
});

test('report -> hide at 3 distinct reporters; owner still sees it; bump keeps it hidden; admin unhide', async () => {
  await claim('alice');
  await call('POST', '/api/skins', { as: 'alice', body: { skin: sceneSkin(), scene: SCENE } });
  const r1 = await call('POST', '/api/skins/alice/scene-skin/report', { ip: '192.0.2.1' });
  assert.deepEqual(r1.data, { ok: true, counted: true, hidden: false });
  const dup = await call('POST', '/api/skins/alice/scene-skin/report', { ip: '192.0.2.1' });
  assert.deepEqual(dup.data, { ok: true, counted: false, hidden: false });
  await call('POST', '/api/skins/alice/scene-skin/report', { ip: '192.0.2.2' });
  const r3 = await call('POST', '/api/skins/alice/scene-skin/report', { ip: '192.0.2.3' });
  assert.deepEqual(r3.data, { ok: true, counted: true, hidden: true });
  assert.ok(!JSON.stringify(env.DB.raw('SELECT * FROM reports')).includes('192.0.2'), 'raw IPs are not stored');

  assert.equal((await call('GET', '/api/skins/alice/scene-skin')).status, 404);
  assert.equal((await call('GET', '/api/skins/alice/scene-skin/scene.svg')).status, 404);
  assert.equal((await call('POST', '/api/skins/alice/scene-skin/download')).status, 404);
  assert.equal((await call('POST', '/api/skins/alice/scene-skin/report', { ip: '192.0.2.9' })).status, 404);
  assert.deepEqual((await call('GET', '/api/skins')).data.items, []);

  const me = await call('GET', '/api/me', { as: 'alice' });
  assert.equal(me.data.handle, 'alice');
  assert.equal(me.data.skins.length, 1);
  assert.equal(me.data.skins[0].hidden, true);
  assert.equal(me.data.skins[0].reports, 3);

  const bump = await call('POST', '/api/skins', { as: 'alice', body: { skin: sceneSkin(), scene: SCENE } });
  assert.equal(bump.data.version, 2);
  assert.equal((await call('GET', '/api/skins/alice/scene-skin')).status, 404, 'bump does not unhide');

  const un = await call('POST', '/api/admin/skins/alice/scene-skin/unhide', { headers: { 'X-Admin-Token': ADMIN } });
  assert.equal(un.status, 200);
  assert.equal((await call('GET', '/api/skins/alice/scene-skin')).status, 200);
  const again = await call('POST', '/api/skins/alice/scene-skin/report', { ip: '192.0.2.1' });
  assert.deepEqual(again.data, { ok: true, counted: true, hidden: false });
});

test('ban by handle: 403 on every authenticated call, skins hidden', async () => {
  await claim('bob');
  await call('POST', '/api/skins', { as: 'bob', body: { skin: skin() } });
  const ban = await call('POST', '/api/admin/bans', { headers: { 'X-Admin-Token': ADMIN }, body: { handle: 'Bob', reason: 'spam' } });
  assert.equal(ban.status, 200);
  assert.equal(ban.data.handle, 'bob');
  assert.equal(ban.data.hiddenSkins, 1);
  assert.match(ban.data.subHash, /^[0-9a-f]{64}$/);
  assert.equal((await call('POST', '/api/skins', { as: 'bob', body: { skin: skin('other-skin') } })).status, 403);
  assert.equal((await call('GET', '/api/me', { as: 'bob' })).status, 403);
  assert.equal((await call('POST', '/api/me/handle', { as: 'bob', body: { handle: 'bobby' } })).status, 403);
  assert.equal((await call('DELETE', '/api/skins/bob/test-skin', { as: 'bob' })).status, 403);
  assert.equal((await call('GET', '/api/skins/bob/test-skin')).status, 404);
  // Bad requests
  const adm = { 'X-Admin-Token': ADMIN };
  assert.equal((await call('POST', '/api/admin/bans', { headers: adm, body: { handle: 'nobody-here' } })).status, 404);
  assert.equal((await call('POST', '/api/admin/bans', { headers: adm, body: { handle: 'x y' } })).status, 400);
  assert.equal((await call('POST', '/api/admin/bans', { headers: adm, body: { handle: 'bob', sub_hash: 'a'.repeat(64) } })).status, 400);
  assert.equal((await call('POST', '/api/admin/bans', { headers: adm, body: {} })).status, 400);
  assert.equal((await call('POST', '/api/admin/bans', { headers: adm, body: { sub_hash: 'xyz' } })).status, 400);
});

test('ban by sub_hash works before the account has a handle', async () => {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(SALT), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const subHash = Buffer.from(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode('sub-eve'))).toString('hex');
  const ban = await call('POST', '/api/admin/bans', { headers: { 'X-Admin-Token': ADMIN }, body: { sub_hash: subHash } });
  assert.deepEqual(ban.data, { ok: true, subHash, handle: null, hiddenSkins: 0 });
  assert.equal((await call('POST', '/api/me/handle', { as: 'eve', body: { handle: 'eve' } })).status, 403);
});

test('admin auth and admin skin management', async () => {
  const body = { skin: sceneSkin('firefly-meadow'), scene: SCENE };
  assert.equal((await call('PUT', '/api/admin/skins/official/firefly-meadow', { body })).status, 401);
  assert.equal((await call('PUT', '/api/admin/skins/official/firefly-meadow', { body, headers: { 'X-Admin-Token': 'wrong' } })).status, 403);
  assert.equal((await call('POST', '/api/admin/bans', { body: { handle: 'x' }, headers: { 'X-Admin-Token': `${ADMIN}x` } })).status, 403);

  const put = await call('PUT', '/api/admin/skins/official/firefly-meadow', { body, headers: { 'X-Admin-Token': ADMIN } });
  assert.deepEqual([put.status, put.data], [201, { ref: 'official.firefly-meadow', version: 1 }]);
  const put2 = await call('PUT', '/api/admin/skins/official/firefly-meadow', { body, headers: { 'X-Admin-Token': ADMIN } });
  assert.deepEqual([put2.status, put2.data.version], [200, 2]);
  const d = await call('GET', '/api/skins/official/firefly-meadow');
  assert.equal(d.data.author, 'official');

  const mismatch = await call('PUT', '/api/admin/skins/official/other-slug', { body, headers: { 'X-Admin-Token': ADMIN } });
  assert.equal(mismatch.status, 400);
  const invalid = await call('PUT', '/api/admin/skins/official/firefly-meadow', { body: { skin: { format: 1 } }, headers: { 'X-Admin-Token': ADMIN } });
  assert.equal(invalid.status, 400);

  for (let i = 0; i < 12; i++) {
    const r = await call('PUT', `/api/admin/skins/official/bulk-${i}`, { body: { skin: skin(`bulk-${i}`) }, headers: { 'X-Admin-Token': ADMIN } });
    assert.equal(r.status, 201);
  }

  const del = await call('DELETE', '/api/admin/skins/official/firefly-meadow', { headers: { 'X-Admin-Token': ADMIN } });
  assert.equal(del.status, 200);
  assert.equal((await call('DELETE', '/api/admin/skins/official/firefly-meadow', { headers: { 'X-Admin-Token': ADMIN } })).status, 404);
  assert.equal((await call('POST', '/api/admin/skins/official/firefly-meadow/unhide', { headers: { 'X-Admin-Token': ADMIN } })).status, 404);
});

test('admin is disabled when ADMIN_TOKEN is missing or short (empty header never matches)', async () => {
  for (const value of [undefined, '', 'short']) {
    env.ADMIN_TOKEN = value;
    const r = await call('POST', '/api/admin/bans', { body: { handle: 'bob' }, headers: { 'X-Admin-Token': value ?? '' } });
    assert.equal(r.status, 403);
  }
});

test('report/download and sign-in need IP_SALT', async () => {
  await call('PUT', '/api/admin/skins/official/test-skin', { body: { skin: skin() }, headers: { 'X-Admin-Token': ADMIN } });
  env.IP_SALT = undefined;
  assert.equal((await call('POST', '/api/skins/official/test-skin/report')).status, 500);
  assert.equal((await call('GET', '/api/me', { as: 'alice' })).status, 500);
});

// ------------------------------------------------------------------ copies and remixes

const DRAWING = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><style>svg{--v-glow:#ffcc00}.a{fill:var(--v-glow)}</style><rect width="10" height="10" fill="#123456"/><circle class="a" cx="5" cy="5" r="2"/></svg>';
// The same drawing, recolored and reformatted.
const RECOLORED = DRAWING.replace('#ffcc00', '#00ffcc').replace('#123456', 'rgb(1, 2, 3)').replace('><rect', '>\n  <!-- mine -->\n  <rect');
const fp = (r) => env.DB.raw('SELECT fingerprint FROM skins WHERE author = ? AND slug = ?', ...r.split('.'))[0]?.fingerprint;

test('upload: another author\'s copy is refused with 409 naming the original; hidden originals count', async () => {
  await claim('alice');
  await claim('bob');
  assert.equal((await call('POST', '/api/skins', { as: 'alice', body: { skin: sceneSkin('meadow'), scene: DRAWING } })).status, 201);
  assert.match(fp('alice.meadow'), /^[0-9a-f]{64}$/);
  const copy = skin('my-meadow', { name: 'My Meadow', description: 'Mine.', backdrop: { scene: true }, colors: { roles: { accent: '#ff0000' }, dark: { anchors: { 'surface-0': '#000000', 'text-primary': '#ffffff' } } } });
  const r = await call('POST', '/api/skins', { as: 'bob', body: { skin: copy, scene: RECOLORED } });
  assert.equal(r.status, 409);
  assert.deepEqual(r.data, { error: 'already in the gallery', original: 'alice.meadow', name: 'Skin meadow' });
  assert.equal(env.DB.raw('SELECT COUNT(*) AS n FROM skins WHERE author = ?', 'bob')[0].n, 0);
  assert.equal(env.DB.raw('SELECT COUNT(*) AS n FROM upload_log')[0].n, 1, 'a refused copy does not use up the daily uploads');
  // Hidden (reported) originals still block.
  env.DB.raw("UPDATE skins SET hidden = 1 WHERE author = 'alice'");
  assert.equal((await call('POST', '/api/skins', { as: 'bob', body: { skin: copy, scene: RECOLORED } })).status, 409);
  // A different drawing is fine.
  assert.equal((await call('POST', '/api/skins', { as: 'bob', body: { skin: copy, scene: RECOLORED.replace('r="2"', 'r="3"') } })).status, 201);
});

test('upload: the same author may publish new versions and other slugs of the same drawing', async () => {
  await claim('alice');
  assert.equal((await call('POST', '/api/skins', { as: 'alice', body: { skin: sceneSkin('meadow'), scene: DRAWING } })).status, 201);
  const v2 = await call('POST', '/api/skins', { as: 'alice', body: { skin: sceneSkin('meadow'), scene: RECOLORED } });
  assert.deepEqual([v2.status, v2.data.version], [200, 2]);
  assert.equal((await call('POST', '/api/skins', { as: 'alice', body: { skin: sceneSkin('meadow-night'), scene: RECOLORED } })).status, 201);
});

test('upload: official skins placed by the admin are protected too', async () => {
  const put = await call('PUT', '/api/admin/skins/official/meadow', { body: { skin: sceneSkin('meadow'), scene: DRAWING }, headers: { 'X-Admin-Token': ADMIN } });
  assert.equal(put.status, 201);
  assert.match(fp('official.meadow'), /^[0-9a-f]{64}$/, 'admin PUT stores the fingerprint');
  await claim('bob');
  const r = await call('POST', '/api/skins', { as: 'bob', body: { skin: sceneSkin('meadow'), scene: RECOLORED } });
  assert.deepEqual([r.status, r.data.original], [409, 'official.meadow']);
});

test('upload: basedOn allows a declared remix, is stored and listed; naming the wrong skin is refused', async () => {
  await claim('alice');
  await claim('bob');
  await claim('carol');
  await call('POST', '/api/skins', { as: 'alice', body: { skin: sceneSkin('meadow'), scene: DRAWING } });
  await call('POST', '/api/skins', { as: 'alice', body: { skin: sceneSkin('other'), scene: DRAWING.replace('r="2"', 'r="4"') } });

  const wrong = await call('POST', '/api/skins', { as: 'bob', body: { skin: sceneSkin('remix'), scene: RECOLORED, basedOn: 'alice.other' } });
  assert.deepEqual([wrong.status, wrong.data.original], [409, 'alice.meadow']);
  const missing = await call('POST', '/api/skins', { as: 'bob', body: { skin: sceneSkin('remix'), scene: RECOLORED, basedOn: 'nobody.nothing' } });
  assert.equal(missing.status, 409);
  const bad = await call('POST', '/api/skins', { as: 'bob', body: { skin: sceneSkin('remix'), scene: RECOLORED, basedOn: 'not a ref' } });
  assert.deepEqual([bad.status, bad.data.error], [400, 'basedOn must be "<author>.<slug>"']);
  const inside = await call('POST', '/api/skins', { as: 'bob', body: { skin: { ...sceneSkin('remix'), basedOn: 'alice.meadow' }, scene: RECOLORED } });
  assert.equal(inside.status, 409, 'basedOn counts only as a top-level field, not inside skin.json');

  const ok = await call('POST', '/api/skins', { as: 'bob', body: { skin: sceneSkin('remix'), scene: RECOLORED, basedOn: 'alice.meadow' } });
  assert.deepEqual([ok.status, ok.data], [201, { ref: 'bob.remix', version: 1 }]);
  assert.equal(env.DB.raw("SELECT based_on FROM skins WHERE author = 'bob'")[0].based_on, 'alice.meadow');
  // A new version keeps the credit without sending it again.
  assert.equal((await call('POST', '/api/skins', { as: 'bob', body: { skin: sceneSkin('remix'), scene: DRAWING } })).status, 200);

  const list = await call('GET', '/api/skins');
  const item = list.data.items.find((i) => i.ref === 'bob.remix');
  assert.deepEqual([item.basedOn, item.basedOnName], ['alice.meadow', 'Skin meadow']);
  assert.equal(list.data.items.find((i) => i.ref === 'alice.meadow').basedOn, undefined);
  const detail = await call('GET', '/api/skins/bob/remix');
  assert.deepEqual([detail.data.basedOn, detail.data.basedOnName], ['alice.meadow', 'Skin meadow']);
  const me = await call('GET', '/api/me', { as: 'bob' });
  assert.equal(me.data.skins[0].basedOn, 'alice.meadow');

  // A remix of the remix may name either one that holds the drawing.
  assert.equal((await call('POST', '/api/skins', { as: 'carol', body: { skin: sceneSkin('again'), scene: RECOLORED, basedOn: 'bob.remix' } })).status, 201);
  // Once the original is hidden, the remix still lists its ref but not its name.
  env.DB.raw("UPDATE skins SET hidden = 1 WHERE author = 'alice' AND slug = 'meadow'");
  const after = (await call('GET', '/api/skins')).data.items.find((i) => i.ref === 'bob.remix');
  assert.deepEqual([after.basedOn, after.basedOnName], ['alice.meadow', null]);
});

test('upload: palette-only skins collide only when identical apart from name, slug, description and tags', async () => {
  await claim('alice');
  await claim('bob');
  assert.equal((await call('POST', '/api/skins', { as: 'alice', body: { skin: skin('warm') } })).status, 201);
  const other = skin('cool', { colors: { roles: { accent: '#ff8800' }, dark: { anchors: { 'surface-0': '#fafafa', 'surface-1': '#ffffff', 'text-primary': '#111111', 'text-muted': '#444444' } } } });
  assert.equal((await call('POST', '/api/skins', { as: 'bob', body: { skin: other } })).status, 201, 'a different palette is a different skin');
  const same = skin('mine', { name: 'Mine', description: 'Totally mine.', tags: ['light'] });
  const r = await call('POST', '/api/skins', { as: 'bob', body: { skin: same } });
  assert.deepEqual([r.status, r.data.original], [409, 'alice.warm']);
});

test('admin backfill fills missing fingerprints page by page; dry run writes nothing', async () => {
  await claim('alice');
  for (const [i, slug] of ['aaa', 'bbb', 'ccc'].entries()) {
    await call('POST', '/api/skins', { as: 'alice', body: { skin: sceneSkin(slug), scene: DRAWING.replace('r="2"', `r="${i + 1}"`) } });
  }
  const want = env.DB.raw('SELECT slug, fingerprint FROM skins ORDER BY slug');
  env.DB.raw('UPDATE skins SET fingerprint = NULL');
  env.DB.raw("UPDATE skins SET skin_json = 'not json' WHERE slug = 'bbb'");
  const admin = (body) => call('POST', '/api/admin/fingerprints', { body, headers: { 'X-Admin-Token': ADMIN } });

  assert.equal((await call('POST', '/api/admin/fingerprints', { body: {} })).status, 401);
  assert.equal((await admin({ limit: 0 })).status, 400);
  assert.equal((await admin({ after: 'x' })).status, 400);
  const dry = await admin({ dryRun: true });
  assert.deepEqual([dry.status, dry.data.updated, dry.data.computed, dry.data.remaining], [200, 0, 2, 3]);

  const p1 = await admin({ limit: 2 });
  assert.deepEqual([p1.data.updated, p1.data.failed, p1.data.next, p1.data.remaining], [1, ['alice.bbb'], 'alice.bbb', 2]);
  const p2 = await admin({ limit: 2, after: p1.data.next });
  assert.deepEqual([p2.data.updated, p2.data.next, p2.data.remaining], [1, null, 1]);
  const got = env.DB.raw('SELECT slug, fingerprint FROM skins ORDER BY slug');
  assert.equal(got[0].fingerprint, want[0].fingerprint, 'backfill computes what an upload computes');
  assert.equal(got[1].fingerprint, null);
  assert.equal(got[2].fingerprint, want[2].fingerprint);
});
