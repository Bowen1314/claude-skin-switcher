// Request handler for the public skin gallery (Cloudflare Worker + D1).
// Pure: everything external (D1, fetch, clock) comes in through env/deps, so
// the tests can drive it with a fake D1 and a stubbed GitHub.

import { validateSkin, validateScene } from '../../shared/skin-validate.js';

export const LIMITS = Object.freeze({
  bodyMaxBytes: 300 * 1024,
  listDefault: 24,
  listMax: 50,
  uploadsPerDay: 10,
  reportsToHide: 3,
  tokenCacheMs: 60 * 60 * 1000,
  dayMs: 24 * 60 * 60 * 1000,
  queryMaxChars: 64,
  banReasonMax: 200,
  meMax: 200,
});

const REPO_URL = 'https://github.com/Bowen1314/claude-theme-switcher';
const LOGIN_RE = /^[a-z0-9](?:[a-z0-9-]{0,38})$/;
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/;
const TAG_RE = /^[a-z0-9-]{1,20}$/;
const TOKEN_RE = /^[A-Za-z0-9_.\-]{1,255}$/;
const RESERVED_LOGINS = new Set(['official', 'default']);
const DEFAULT_ACCENT = '#d97757';

// ------------------------------------------------------------------ helpers

class HttpError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
};

function json(status, body, { cors = false, headers = {} } = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
      ...(cors ? CORS : {}),
      ...headers,
    },
  });
}

const isRecord = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

async function sha256(text) {
  return hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
}

async function safeEqual(a, b) {
  const [x, y] = await Promise.all([sha256(a), sha256(b)]);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

function b64urlEncode(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(text) {
  if (!/^[A-Za-z0-9_-]{1,400}$/.test(text)) throw new Error('bad cursor');
  const bin = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
  return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

async function readJsonBody(request, maxBytes) {
  const declared = request.headers.get('Content-Length');
  if (declared !== null && Number(declared) > maxBytes) throw new HttpError(413, `body is larger than ${maxBytes} bytes`);
  if (!request.body) throw new HttpError(400, 'a JSON body is required');
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new HttpError(413, `body is larger than ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  const buf = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    buf.set(c, off);
    off += c.byteLength;
  }
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    throw new HttpError(400, 'body must be UTF-8');
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, 'body must be valid JSON');
  }
}

// Mix two #rrggbb colors: t=0 gives a, t=1 gives b.
function mix(a, b, t) {
  const c = (h, i) => parseInt(h.slice(i, i + 2), 16);
  const out = [1, 3, 5].map((i) => Math.round(c(a, i) + (c(b, i) - c(a, i)) * t));
  return `#${out.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

export function previewOf(colors) {
  const preview = {};
  if (!isRecord(colors)) return preview;
  const accent = colors.roles?.accent ?? DEFAULT_ACCENT;
  for (const mode of ['dark', 'light']) {
    const a = colors[mode]?.anchors;
    if (!isRecord(a) || !a['surface-0'] || !a['text-primary']) continue;
    const surface0 = a['surface-0'];
    const text = a['text-primary'];
    preview[mode] = {
      surface0,
      surface1: a['surface-1'] ?? a['surface-2'] ?? mix(surface0, text, 0.06),
      text,
      muted: a['text-muted'] ?? a['text-secondary'] ?? mix(text, surface0, 0.45),
      accent,
    };
  }
  return preview;
}

function listItem(row) {
  let colors = null;
  try {
    colors = JSON.parse(row.colors);
  } catch {
    colors = null;
  }
  let tags = [];
  try {
    tags = JSON.parse(row.tags);
  } catch {
    tags = [];
  }
  return {
    ref: `${row.author}.${row.slug}`,
    author: row.author,
    slug: row.slug,
    name: row.name,
    description: row.description,
    tags,
    version: row.version,
    downloads: row.downloads,
    hasScene: row.has_scene === 1,
    updatedAt: row.updated_at,
    preview: previewOf(colors),
  };
}

const LIST_COLUMNS = `author, slug, name, description, tags, version, downloads, updated_at, hidden, reports,
  (scene IS NOT NULL) AS has_scene, json_extract(skin_json, '$.colors') AS colors`;

// ------------------------------------------------------------------ auth

async function resolveLogin(request, env, deps) {
  const header = request.headers.get('Authorization') || '';
  const m = /^Bearer\s+(\S+)\s*$/i.exec(header);
  if (!m) throw new HttpError(401, 'sign in with GitHub: Authorization: Bearer <token>');
  const token = m[1];
  if (!TOKEN_RE.test(token)) throw new HttpError(401, 'invalid token');
  const now = deps.now();
  const tokenHash = await sha256(token);

  let login = await env.DB.prepare('SELECT login FROM token_cache WHERE token_hash = ? AND expires_at > ?')
    .bind(tokenHash, now)
    .first('login');

  if (!login) {
    let res;
    try {
      res = await deps.fetch('https://api.github.com/user', {
        headers: {
          Authorization: `Bearer ${token}`,
          'User-Agent': 'claude-skins',
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
      });
    } catch {
      throw new HttpError(502, 'could not reach GitHub');
    }
    if (res.status === 401) throw new HttpError(401, 'invalid token');
    if (!res.ok) throw new HttpError(502, `GitHub answered ${res.status}`);
    let data;
    try {
      data = await res.json();
    } catch {
      throw new HttpError(502, 'GitHub sent an unreadable answer');
    }
    login = typeof data?.login === 'string' ? data.login.toLowerCase() : '';
    if (!LOGIN_RE.test(login)) throw new HttpError(502, 'GitHub sent an unexpected login');
    await env.DB.batch([
      env.DB.prepare('DELETE FROM token_cache WHERE expires_at <= ?').bind(now),
      env.DB.prepare('INSERT OR REPLACE INTO token_cache (token_hash, login, expires_at) VALUES (?, ?, ?)').bind(
        tokenHash,
        login,
        now + LIMITS.tokenCacheMs,
      ),
    ]);
  }

  const banned = await env.DB.prepare('SELECT 1 AS x FROM bans WHERE login = ?').bind(login).first('x');
  if (banned) throw new HttpError(403, 'this account is banned from the gallery');
  return login;
}

async function requireAdmin(request, env) {
  const given = request.headers.get('X-Admin-Token');
  const secret = env.ADMIN_TOKEN;
  if (typeof secret !== 'string' || secret.length < 32) throw new HttpError(403, 'admin is disabled');
  if (!given) throw new HttpError(401, 'X-Admin-Token required');
  if (!(await safeEqual(given, secret))) throw new HttpError(403, 'wrong admin token');
}

async function clientHash(request, env) {
  const salt = env.IP_SALT;
  if (typeof salt !== 'string' || salt.length < 16) throw new HttpError(500, 'server is not configured');
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  return sha256(`${salt}:${ip}`);
}

// ------------------------------------------------------------------ skins

function checkPayload(body, { pathSlug } = {}) {
  if (!isRecord(body) || !('skin' in body)) throw new HttpError(400, 'body must be { "skin": {...}, "scene"?: "<svg..." }');
  const v = validateSkin(body.skin);
  if (!v.ok) throw new HttpError(400, 'invalid skin', { errors: v.errors });
  const skin = v.skin;
  let scene = null;
  if (body.scene !== undefined && body.scene !== null) {
    const s = validateScene(body.scene);
    if (!s.ok) throw new HttpError(400, 'invalid scene', { errors: s.errors });
    scene = body.scene;
  }
  const wantsScene = skin.backdrop?.scene === true;
  if (wantsScene && scene === null) throw new HttpError(400, 'backdrop.scene is true, so a scene is required');
  if (!wantsScene && scene !== null) throw new HttpError(400, 'a scene was sent but backdrop.scene is not true');
  if (pathSlug !== undefined && pathSlug !== skin.slug) throw new HttpError(400, `skin.slug "${skin.slug}" does not match the URL slug "${pathSlug}"`);
  return { skin, scene };
}

function upsertStatement(env, author, skin, scene, now) {
  return env.DB.prepare(
    `INSERT INTO skins (author, slug, name, description, tags, version, skin_json, scene, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?)
     ON CONFLICT (author, slug) DO UPDATE SET
       name = excluded.name, description = excluded.description, tags = excluded.tags,
       skin_json = excluded.skin_json, scene = excluded.scene,
       version = skins.version + 1, updated_at = excluded.updated_at
     RETURNING version`,
  ).bind(author, skin.slug, skin.name, skin.description, JSON.stringify(skin.tags), JSON.stringify(skin), scene, now, now);
}

function savedResponse(author, slug, version) {
  return json(version === 1 ? 201 : 200, { ref: `${author}.${slug}`, version });
}

async function getVisible(env, author, slug, columns) {
  const row = await env.DB.prepare(`SELECT ${columns} FROM skins WHERE author = ? AND slug = ? AND hidden = 0`).bind(author, slug).first();
  if (!row) throw new HttpError(404, 'skin not found');
  return row;
}

async function listSkins(url, env) {
  const p = url.searchParams;
  const sort = p.get('sort') || 'new';
  if (sort !== 'new' && sort !== 'popular') throw new HttpError(400, 'sort must be new or popular');
  let limit = LIMITS.listDefault;
  if (p.has('limit')) {
    limit = Number(p.get('limit'));
    if (!Number.isInteger(limit) || limit < 1 || limit > LIMITS.listMax) throw new HttpError(400, `limit must be 1 to ${LIMITS.listMax}`);
  }
  const where = ['hidden = 0'];
  const binds = [];
  const q = (p.get('q') || '').trim().toLowerCase();
  if (q) {
    if (q.length > LIMITS.queryMaxChars) throw new HttpError(400, `q must be at most ${LIMITS.queryMaxChars} characters`);
    where.push(`instr(lower(name || ' ' || description || ' ' || author || ' ' || slug), ?) > 0`);
    binds.push(q);
  }
  const tag = p.get('tag');
  if (tag) {
    if (!TAG_RE.test(tag)) throw new HttpError(400, 'tag must match ^[a-z0-9-]{1,20}$');
    where.push('EXISTS (SELECT 1 FROM json_each(skins.tags) WHERE json_each.value = ?)');
    binds.push(tag);
  }
  const keyCols = sort === 'new' ? ['updated_at', 'author', 'slug'] : ['downloads', 'updated_at', 'author', 'slug'];
  const cursor = p.get('cursor');
  if (cursor) {
    let values;
    try {
      values = JSON.parse(b64urlDecode(cursor));
    } catch {
      throw new HttpError(400, 'bad cursor');
    }
    const okShape =
      Array.isArray(values) &&
      values.length === keyCols.length &&
      values.every((v, i) => (keyCols[i] === 'author' || keyCols[i] === 'slug' ? typeof v === 'string' : Number.isSafeInteger(v)));
    if (!okShape) throw new HttpError(400, 'bad cursor');
    where.push(`(${keyCols.join(', ')}) < (${keyCols.map(() => '?').join(', ')})`);
    binds.push(...values);
  }
  const sql = `SELECT ${LIST_COLUMNS} FROM skins WHERE ${where.join(' AND ')}
    ORDER BY ${keyCols.map((c) => `${c} DESC`).join(', ')} LIMIT ?`;
  const { results } = await env.DB.prepare(sql).bind(...binds, limit + 1).all();
  const rows = results.slice(0, limit);
  let nextCursor = null;
  if (results.length > limit) {
    const last = rows[rows.length - 1];
    nextCursor = b64urlEncode(JSON.stringify(keyCols.map((c) => last[c])));
  }
  return json(200, { items: rows.map(listItem), nextCursor }, { cors: true });
}

// ------------------------------------------------------------------ routes

const HOME = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Theme Switcher for Claude: skin gallery</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:40rem;margin:4rem auto;padding:0 1rem;color:#222}a{color:#b5552f}</style>
</head><body>
<h1>Theme Switcher for Claude</h1>
<p>This is the public skin gallery API that the Theme Switcher app browses, installs and shares skins through.</p>
<p><a href="${REPO_URL}">${REPO_URL}</a></p>
<p><small>Not affiliated with Anthropic.</small></p>
</body></html>
`;

async function route(request, env, deps) {
  const url = new URL(request.url);
  const method = request.method.toUpperCase();
  const parts = url.pathname.split('/').filter(Boolean).map((s) => {
    try {
      return decodeURIComponent(s);
    } catch {
      return '\u0000';
    }
  });
  const allow = (...methods) => {
    if (method === 'OPTIONS' && methods.includes('GET')) return 'preflight';
    if (!methods.includes(method)) throw new HttpError(405, `use ${methods.join(' or ')}`);
    return method;
  };
  const ref = (author, slug) => {
    if (!LOGIN_RE.test(author) || !SLUG_RE.test(slug)) throw new HttpError(404, 'skin not found');
  };
  const preflight = () => new Response(null, { status: 204, headers: CORS });

  if (parts.length === 0) {
    if (allow('GET') === 'preflight') return preflight();
    return new Response(HOME, {
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
        'X-Content-Type-Options': 'nosniff',
      },
    });
  }
  if (parts[0] !== 'api') throw new HttpError(404, 'not found');
  const [, a, b, c, d, e] = parts;
  const n = parts.length;

  // /api/health
  if (n === 2 && a === 'health') {
    if (allow('GET') === 'preflight') return preflight();
    return json(200, { ok: true }, { cors: true });
  }

  // /api/me
  if (n === 2 && a === 'me') {
    allow('GET');
    const login = await resolveLogin(request, env, deps);
    const { results } = await env.DB.prepare(`SELECT ${LIST_COLUMNS} FROM skins WHERE author = ? ORDER BY updated_at DESC LIMIT ?`)
      .bind(login, LIMITS.meMax)
      .all();
    return json(200, {
      login,
      skins: results.map((r) => ({ ...listItem(r), hidden: r.hidden === 1, reports: r.reports })),
    });
  }

  // /api/skins
  if (n === 2 && a === 'skins') {
    const m = allow('GET', 'POST');
    if (m === 'preflight') return preflight();
    if (m === 'GET') return listSkins(url, env);
    const login = await resolveLogin(request, env, deps);
    if (RESERVED_LOGINS.has(login)) throw new HttpError(403, `the login "${login}" is reserved`);
    const body = await readJsonBody(request, LIMITS.bodyMaxBytes);
    const { skin, scene } = checkPayload(body);
    const now = deps.now();
    const recent = await env.DB.prepare('SELECT COUNT(*) AS n FROM upload_log WHERE login = ? AND created_at > ?')
      .bind(login, now - LIMITS.dayMs)
      .first('n');
    if (recent >= LIMITS.uploadsPerDay) {
      throw new HttpError(429, `at most ${LIMITS.uploadsPerDay} uploads per 24 hours`);
    }
    const [saved] = await env.DB.batch([
      upsertStatement(env, login, skin, scene, now),
      env.DB.prepare('INSERT INTO upload_log (login, created_at) VALUES (?, ?)').bind(login, now),
      env.DB.prepare('DELETE FROM upload_log WHERE created_at <= ?').bind(now - LIMITS.dayMs),
    ]);
    return savedResponse(login, skin.slug, saved.results[0].version);
  }

  // /api/skins/:author/:slug[/scene.svg|/download|/report]
  if (a === 'skins' && n >= 4 && n <= 5) {
    ref(b, c);
    if (n === 4) {
      const m = allow('GET', 'DELETE');
      if (m === 'preflight') return preflight();
      if (m === 'GET') {
        const row = await getVisible(env, b, c, 'skin_json, version');
        const skin = JSON.parse(row.skin_json);
        return json(200, { ...skin, author: b, version: row.version }, { cors: true, headers: { 'Cache-Control': 'public, max-age=60' } });
      }
      const login = await resolveLogin(request, env, deps);
      if (login !== b) throw new HttpError(403, 'you can only delete your own skins');
      const [del] = await env.DB.batch(deleteStatements(env, b, c));
      if (!del.meta?.changes) throw new HttpError(404, 'skin not found');
      return json(200, { ok: true, ref: `${b}.${c}` });
    }
    if (d === 'scene.svg') {
      if (allow('GET') === 'preflight') return preflight();
      const row = await getVisible(env, b, c, 'scene');
      if (row.scene === null) throw new HttpError(404, 'this skin has no scene');
      return new Response(row.scene, {
        headers: {
          'Content-Type': 'image/svg+xml; charset=utf-8',
          'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
          'X-Content-Type-Options': 'nosniff',
          'Cache-Control': 'public, max-age=60',
          ...CORS,
        },
      });
    }
    if (d === 'download') {
      allow('POST');
      await getVisible(env, b, c, '1 AS x');
      const ipHash = await clientHash(request, env);
      const day = Math.floor(deps.now() / LIMITS.dayMs);
      const [seen] = await env.DB.batch([
        env.DB.prepare('INSERT OR IGNORE INTO download_seen (author, slug, ip_hash, day) VALUES (?, ?, ?, ?)').bind(b, c, ipHash, day),
        env.DB.prepare('DELETE FROM download_seen WHERE day < ?').bind(day - 1),
      ]);
      const counted = (seen.meta?.changes ?? 0) > 0;
      let downloads;
      if (counted) {
        downloads = await env.DB.prepare('UPDATE skins SET downloads = downloads + 1 WHERE author = ? AND slug = ? RETURNING downloads')
          .bind(b, c)
          .first('downloads');
      } else {
        downloads = await env.DB.prepare('SELECT downloads FROM skins WHERE author = ? AND slug = ?').bind(b, c).first('downloads');
      }
      return json(200, { ok: true, counted, downloads });
    }
    if (d === 'report') {
      allow('POST');
      await getVisible(env, b, c, '1 AS x');
      const reporter = await clientHash(request, env);
      const now = deps.now();
      const [ins, upd] = await env.DB.batch([
        env.DB.prepare('INSERT OR IGNORE INTO reports (author, slug, reporter_hash, created_at) VALUES (?, ?, ?, ?)').bind(b, c, reporter, now),
        env.DB.prepare(
          `UPDATE skins SET
             reports = (SELECT COUNT(*) FROM reports WHERE author = ?1 AND slug = ?2),
             hidden = CASE WHEN (SELECT COUNT(*) FROM reports WHERE author = ?1 AND slug = ?2) >= ?3 THEN 1 ELSE hidden END
           WHERE author = ?1 AND slug = ?2
           RETURNING reports, hidden`,
        ).bind(b, c, LIMITS.reportsToHide),
      ]);
      const row = upd.results[0];
      return json(200, { ok: true, counted: (ins.meta?.changes ?? 0) > 0, hidden: row.hidden === 1 });
    }
    throw new HttpError(404, 'not found');
  }

  // /api/admin/...
  if (a === 'admin') {
    await requireAdmin(request, env);
    if (n === 3 && b === 'bans') {
      allow('POST');
      const body = await readJsonBody(request, LIMITS.bodyMaxBytes);
      const login = typeof body?.login === 'string' ? body.login.trim().toLowerCase() : '';
      if (!LOGIN_RE.test(login) || RESERVED_LOGINS.has(login)) throw new HttpError(400, 'login must be a GitHub login');
      const reason = body.reason === undefined ? '' : body.reason;
      if (typeof reason !== 'string' || reason.length > LIMITS.banReasonMax) throw new HttpError(400, `reason must be a string of at most ${LIMITS.banReasonMax} characters`);
      const [, hid] = await env.DB.batch([
        env.DB.prepare('INSERT INTO bans (login, reason, created_at) VALUES (?, ?, ?) ON CONFLICT (login) DO UPDATE SET reason = excluded.reason')
          .bind(login, reason, deps.now()),
        env.DB.prepare('UPDATE skins SET hidden = 1 WHERE author = ?').bind(login),
      ]);
      return json(200, { ok: true, login, hiddenSkins: hid.meta?.changes ?? 0 });
    }
    if (b === 'skins' && (n === 5 || n === 6)) {
      ref(c, d);
      if (n === 5) {
        const m = allow('PUT', 'DELETE');
        if (m === 'PUT') {
          const body = await readJsonBody(request, LIMITS.bodyMaxBytes);
          const { skin, scene } = checkPayload(body, { pathSlug: d });
          const [saved] = await env.DB.batch([upsertStatement(env, c, skin, scene, deps.now())]);
          return savedResponse(c, skin.slug, saved.results[0].version);
        }
        const [del] = await env.DB.batch(deleteStatements(env, c, d));
        if (!del.meta?.changes) throw new HttpError(404, 'skin not found');
        return json(200, { ok: true, ref: `${c}.${d}` });
      }
      if (e === 'unhide') {
        allow('POST');
        const [upd] = await env.DB.batch([
          env.DB.prepare('UPDATE skins SET hidden = 0, reports = 0 WHERE author = ? AND slug = ?').bind(c, d),
          env.DB.prepare('DELETE FROM reports WHERE author = ? AND slug = ?').bind(c, d),
        ]);
        if (!upd.meta?.changes) throw new HttpError(404, 'skin not found');
        return json(200, { ok: true, ref: `${c}.${d}` });
      }
    }
    throw new HttpError(404, 'not found');
  }

  throw new HttpError(404, 'not found');
}

function deleteStatements(env, author, slug) {
  return [
    env.DB.prepare('DELETE FROM skins WHERE author = ? AND slug = ?').bind(author, slug),
    env.DB.prepare('DELETE FROM reports WHERE author = ? AND slug = ?').bind(author, slug),
    env.DB.prepare('DELETE FROM download_seen WHERE author = ? AND slug = ?').bind(author, slug),
  ];
}

/**
 * Handle one request.
 * @param {Request} request
 * @param {{ DB: D1Database, ADMIN_TOKEN?: string, IP_SALT?: string }} env
 * @param {{ fetch?: typeof fetch, now?: () => number }} [deps]
 */
export async function handle(request, env, deps = {}) {
  const d = { fetch: deps.fetch ?? ((...args) => fetch(...args)), now: deps.now ?? (() => Date.now()) };
  try {
    return await route(request, env, d);
  } catch (err) {
    if (err instanceof HttpError) {
      const body = { error: err.message, ...(err.extra || {}) };
      const headers = err.status === 429 ? { 'Retry-After': '3600' } : {};
      return json(err.status, body, { cors: request.method === 'GET', headers });
    }
    // Never log request headers or bodies: they may carry tokens.
    console.error('unhandled error:', err && err.message ? err.message : String(err));
    return json(500, { error: 'internal error' });
  }
}
