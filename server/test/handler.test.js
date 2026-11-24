import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { handle, LIMITS, previewOf } from '../src/handler.js';
import { FakeD1 } from './fake-d1.js';

const ADMIN = 'a'.repeat(64);
const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

let env;
let clock;
let githubCalls;

// Stubbed GitHub: token -> login, or a status code.
const TOKENS = { 'gho_alice': 'Alice', 'gho_bob': 'bob', 'gho_official': 'official', 'gho_carol': 'carol', 'gho_bad': 401, 'gho_down': 500 };

async function fakeFetch(url, init) {
  assert.equal(url, 'https://api.github.com/user');
  assert.equal(init.headers['User-Agent'], 'claude-skins');
  assert.equal(init.headers.Accept, 'application/vnd.github+json');
  githubCalls++;
  const token = init.headers.Authorization.replace(/^Bearer /, '');
  const v = TOKENS[token];
  if (v === undefined || v === 401) return new Response('{"message":"Bad credentials"}', { status: 401 });
  if (typeof v === 'number') return new Response('oops', { status: v });
  return Response.json({ login: v, id: 1 });
}

beforeEach(() => {
  env = { DB: new FakeD1(), ADMIN_TOKEN: ADMIN, IP_SALT: 's'.repeat(64) };
  clock = { t: 1_800_000_000_000 };
  githubCalls = 0;
});

async function call(method, path, { token, body, raw, headers = {}, ip = '203.0.113.1' } = {}) {
  const h = { 'CF-Connecting-IP': ip, ...headers };
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
  });
  const type = res.headers.get('Content-Type') || '';
  const data = type.startsWith('application/json') ? await res.json() : await res.text();
  return { status: res.status, data, headers: res.headers };
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
  const home = await call('GET', '/');
  assert.equal(home.status, 200);
  assert.match(home.data, /Theme Switcher for Claude/);
  assert.match(home.data, /https:\/\/github\.com\/Bowen1314\/claude-theme-switcher/);
  assert.match(home.data, /Not affiliated with Anthropic\./);
  const h = await call('GET', '/api/health');
  assert.deepEqual([h.status, h.data], [200, { ok: true }]);
  assert.equal(h.headers.get('Access-Control-Allow-Origin'), '*');
  assert.equal((await call('GET', '/nope')).status, 404);
  assert.equal((await call('GET', '/api/nope')).status, 404);
  assert.equal((await call('PATCH', '/api/skins')).status, 405);
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

test('auth: missing, bogus, GitHub down; auth happens before validation', async () => {
  const none = await call('POST', '/api/skins', { body: { skin: skin() } });
  assert.equal(none.status, 401);
  assert.ok(none.data.error);
  const bogus = await call('POST', '/api/skins', { token: 'gho_bad', body: { skin: { nope: 1 } } });
  assert.equal(bogus.status, 401);
  const weird = await call('POST', '/api/skins', { token: 'tokén', body: { skin: skin() } });
  assert.equal(weird.status, 401);
  const down = await call('POST', '/api/skins', { token: 'gho_down', body: { skin: skin() } });
  assert.equal(down.status, 502);
  assert.equal(env.DB.raw('SELECT COUNT(*) AS n FROM token_cache')[0].n, 0, 'failures are not cached');
});

test('upload creates, bumps, lower-cases login, caches token for 1 h without storing it', async () => {
  const a = await call('POST', '/api/skins', { token: 'gho_alice', body: { skin: { ...skin(), author: 'mallory', version: 99 } } });
  assert.deepEqual([a.status, a.data], [201, { ref: 'alice.test-skin', version: 1 }]);
  const b = await call('POST', '/api/skins', { token: 'gho_alice', body: { skin: skin('test-skin', { name: 'Renamed' }) } });
  assert.deepEqual([b.status, b.data], [200, { ref: 'alice.test-skin', version: 2 }]);
  assert.equal(githubCalls, 1, 'second call used the cache');

  const d = await call('GET', '/api/skins/alice/test-skin');
  assert.equal(d.status, 200);
  assert.equal(d.data.author, 'alice');
  assert.equal(d.data.version, 2);
  assert.equal(d.data.name, 'Renamed');
  assert.equal(d.data.slug, 'test-skin');
  assert.equal(d.headers.get('Access-Control-Allow-Origin'), '*');

  const cache = env.DB.raw('SELECT * FROM token_cache');
  assert.equal(cache.length, 1);
  assert.equal(cache[0].login, 'alice');
  assert.match(cache[0].token_hash, /^[0-9a-f]{64}$/);
  assert.ok(!JSON.stringify(env.DB.raw('SELECT * FROM skins')).includes('gho_alice'));

  clock.t += HOUR + 1;
  await call('GET', '/api/me', { token: 'gho_alice' });
  assert.equal(githubCalls, 2, 'cache expired after 1 h');

  const created = env.DB.raw('SELECT created_at, updated_at FROM skins')[0];
  assert.ok(created.updated_at >= created.created_at);
});

test('upload validation: invalid skin, refused svg, scene mismatch, oversized, bad JSON, reserved login', async () => {
  const bad = await call('POST', '/api/skins', { token: 'gho_alice', body: { skin: skin('x') } });
  assert.equal(bad.status, 400);
  assert.equal(bad.data.error, 'invalid skin');
  assert.ok(bad.data.errors.some((e) => e.startsWith('$.slug')));

  const svg = await call('POST', '/api/skins', {
    token: 'gho_alice',
    body: { skin: sceneSkin(), scene: '<svg viewBox="0 0 1 1"><ScRiPt>alert(1)</ScRiPt></svg>' },
  });
  assert.equal(svg.status, 400);
  assert.equal(svg.data.error, 'invalid scene');

  assert.equal((await call('POST', '/api/skins', { token: 'gho_alice', body: { skin: sceneSkin() } })).status, 400);
  assert.equal((await call('POST', '/api/skins', { token: 'gho_alice', body: { skin: skin(), scene: SCENE } })).status, 400);
  assert.equal((await call('POST', '/api/skins', { token: 'gho_alice', body: { nope: true } })).status, 400);
  assert.equal((await call('POST', '/api/skins', { token: 'gho_alice', raw: '{not json' })).status, 400);

  const huge = JSON.stringify({ skin: skin(), pad: 'x'.repeat(LIMITS.bodyMaxBytes) });
  assert.equal((await call('POST', '/api/skins', { token: 'gho_alice', raw: huge })).status, 413);
  // No Content-Length (streamed): the byte cap still applies.
  const stream = new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode(huge));
      c.close();
    },
  });
  const res = await handle(
    new Request('https://skins.example/api/skins', { method: 'POST', headers: { Authorization: 'Bearer gho_alice' }, body: stream, duplex: 'half' }),
    env,
    { fetch: fakeFetch, now: () => clock.t },
  );
  assert.equal(res.status, 413);

  const off = await call('POST', '/api/skins', { token: 'gho_official', body: { skin: skin() } });
  assert.equal(off.status, 403);

  assert.equal(env.DB.raw('SELECT COUNT(*) AS n FROM skins')[0].n, 0);
});

test('scene upload and scene.svg endpoint headers', async () => {
  const up = await call('POST', '/api/skins', { token: 'gho_alice', body: { skin: sceneSkin(), scene: SCENE } });
  assert.equal(up.status, 201);
  const s = await call('GET', '/api/skins/alice/scene-skin/scene.svg');
  assert.equal(s.status, 200);
  assert.equal(s.data, SCENE);
  assert.match(s.headers.get('Content-Type'), /^image\/svg\+xml/);
  assert.equal(s.headers.get('Content-Security-Policy'), "default-src 'none'; style-src 'unsafe-inline'");
  assert.equal(s.headers.get('X-Content-Type-Options'), 'nosniff');
  await call('POST', '/api/skins', { token: 'gho_alice', body: { skin: skin('plain-skin') } });
  assert.equal((await call('GET', '/api/skins/alice/plain-skin/scene.svg')).status, 404);
  const list = await call('GET', '/api/skins');
  const byRef = Object.fromEntries(list.data.items.map((i) => [i.ref, i]));
  assert.equal(byRef['alice.scene-skin'].hasScene, true);
  assert.equal(byRef['alice.plain-skin'].hasScene, false);
});

test('rate limit: 10 uploads per login per 24 h', async () => {
  for (let i = 0; i < 10; i++) {
    const r = await call('POST', '/api/skins', { token: 'gho_alice', body: { skin: skin(`skin-${i}`) } });
    assert.equal(r.status, 201, `upload ${i}`);
    clock.t += 1000;
  }
  const over = await call('POST', '/api/skins', { token: 'gho_alice', body: { skin: skin('skin-10') } });
  assert.equal(over.status, 429);
  assert.ok(over.headers.get('Retry-After'));
  // Another login is unaffected.
  assert.equal((await call('POST', '/api/skins', { token: 'gho_bob', body: { skin: skin('skin-10') } })).status, 201);
  clock.t += DAY;
  assert.equal((await call('POST', '/api/skins', { token: 'gho_alice', body: { skin: skin('skin-10') } })).status, 201);
});

test('listing: pagination with ties, popular sort, q, tag, preview', async () => {
  // Five skins, three of them sharing one updated_at to exercise tie-breakers.
  const plan = [
    ['gho_alice', 'aaa', 0],
    ['gho_bob', 'bbb', 0],
    ['gho_carol', 'ccc', 0],
    ['gho_alice', 'ddd', 5],
    ['gho_bob', 'eee', 9],
  ];
  for (const [tok, slug, dt] of plan) {
    clock.t = 1_800_000_000_000 + dt;
    const extra = slug === 'ddd' ? { tags: ['light', 'cozy'], description: 'Warm Fireflies' } : {};
    assert.equal((await call('POST', '/api/skins', { token: tok, body: { skin: skin(slug, extra) } })).status, 201);
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

  // popular: downloads first
  await call('POST', '/api/skins/alice/aaa/download', { ip: '198.51.100.1' });
  await call('POST', '/api/skins/alice/aaa/download', { ip: '198.51.100.2' });
  await call('POST', '/api/skins/carol/ccc/download', { ip: '198.51.100.1' });
  const pop = await call('GET', '/api/skins?sort=popular&limit=3');
  assert.deepEqual(pop.data.items.map((i) => [i.ref, i.downloads]), [['alice.aaa', 2], ['carol.ccc', 1], ['bob.eee', 0]]);
  const pop2 = await call('GET', `/api/skins?sort=popular&limit=3&cursor=${pop.data.nextCursor}`);
  assert.deepEqual(pop2.data.items.map((i) => i.ref), ['alice.ddd', 'bob.bbb']);
  assert.equal(pop2.data.nextCursor, null);
  // A "new" cursor is refused by "popular" (different shape).
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
  await call('POST', '/api/skins', { token: 'gho_alice', body: { skin: skin() } });
  assert.equal((await call('DELETE', '/api/skins/alice/test-skin')).status, 401);
  assert.equal((await call('DELETE', '/api/skins/alice/test-skin', { token: 'gho_bob' })).status, 403);
  const ok = await call('DELETE', '/api/skins/alice/test-skin', { token: 'gho_alice' });
  assert.deepEqual([ok.status, ok.data], [200, { ok: true, ref: 'alice.test-skin' }]);
  assert.equal((await call('DELETE', '/api/skins/alice/test-skin', { token: 'gho_alice' })).status, 404);
  assert.equal((await call('GET', '/api/skins/alice/test-skin')).status, 404);
});

test('downloads are deduped per salted IP per skin per day', async () => {
  await call('POST', '/api/skins', { token: 'gho_alice', body: { skin: skin() } });
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
  await call('POST', '/api/skins', { token: 'gho_alice', body: { skin: sceneSkin(), scene: SCENE } });
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

  const me = await call('GET', '/api/me', { token: 'gho_alice' });
  assert.equal(me.data.login, 'alice');
  assert.equal(me.data.skins.length, 1);
  assert.equal(me.data.skins[0].hidden, true);
  assert.equal(me.data.skins[0].reports, 3);

  const bump = await call('POST', '/api/skins', { token: 'gho_alice', body: { skin: sceneSkin(), scene: SCENE } });
  assert.equal(bump.data.version, 2);
  assert.equal((await call('GET', '/api/skins/alice/scene-skin')).status, 404, 'bump does not unhide');

  const un = await call('POST', '/api/admin/skins/alice/scene-skin/unhide', { headers: { 'X-Admin-Token': ADMIN } });
  assert.equal(un.status, 200);
  assert.equal((await call('GET', '/api/skins/alice/scene-skin')).status, 200);
  // Reports were cleared, so one new report does not re-hide.
  const again = await call('POST', '/api/skins/alice/scene-skin/report', { ip: '192.0.2.1' });
  assert.deepEqual(again.data, { ok: true, counted: true, hidden: false });
});

test('ban: banned login gets 403 even with a cached token, and their skins are hidden', async () => {
  await call('POST', '/api/skins', { token: 'gho_bob', body: { skin: skin() } });
  const ban = await call('POST', '/api/admin/bans', { headers: { 'X-Admin-Token': ADMIN }, body: { login: 'Bob', reason: 'spam' } });
  assert.deepEqual([ban.status, ban.data], [200, { ok: true, login: 'bob', hiddenSkins: 1 }]);
  assert.equal((await call('POST', '/api/skins', { token: 'gho_bob', body: { skin: skin('other-skin') } })).status, 403);
  assert.equal((await call('GET', '/api/me', { token: 'gho_bob' })).status, 403);
  assert.equal((await call('DELETE', '/api/skins/bob/test-skin', { token: 'gho_bob' })).status, 403);
  assert.equal((await call('GET', '/api/skins/bob/test-skin')).status, 404);
  assert.equal((await call('POST', '/api/admin/bans', { headers: { 'X-Admin-Token': ADMIN }, body: { login: 'not a login' } })).status, 400);
});

test('admin auth and admin skin management', async () => {
  const body = { skin: sceneSkin('firefly-meadow'), scene: SCENE };
  assert.equal((await call('PUT', '/api/admin/skins/official/firefly-meadow', { body })).status, 401);
  assert.equal((await call('PUT', '/api/admin/skins/official/firefly-meadow', { body, headers: { 'X-Admin-Token': 'wrong' } })).status, 403);
  assert.equal((await call('POST', '/api/admin/bans', { body: { login: 'x' }, headers: { 'X-Admin-Token': `${ADMIN}x` } })).status, 403);

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

  // Admin uploads are not rate limited.
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
    const r = await call('POST', '/api/admin/bans', { body: { login: 'bob' }, headers: { 'X-Admin-Token': value ?? '' } });
    assert.equal(r.status, 403);
  }
});

test('report/download need IP_SALT', async () => {
  await call('POST', '/api/skins', { token: 'gho_alice', body: { skin: skin() } });
  env.IP_SALT = undefined;
  assert.equal((await call('POST', '/api/skins/alice/test-skin/report')).status, 500);
});
