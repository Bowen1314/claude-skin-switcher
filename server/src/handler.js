// Request handler for the public skin gallery (Cloudflare Worker + D1).
// Pure: everything external (D1, fetch, clock) comes in through env/deps, so
// the tests can drive it with a fake D1 and a stubbed Google JWKS.
//
// Sign-in: `Authorization: Bearer <Google ID token>` (openid scope only). The
// account key is HMAC-SHA256(sub, IP_SALT); the raw sub is never stored, and
// no email or name is ever requested, stored or logged.

import { validateSkin, validateScene } from '../../shared/skin-validate.js';
import { skinFingerprint } from '../../shared/fingerprint.js';

export const LIMITS = Object.freeze({
  bodyMaxBytes: 300 * 1024,
  smallBodyMaxBytes: 1024,
  listDefault: 24,
  listMax: 50,
  uploadsPerDay: 10,
  handleClaimsPerDay: 10,
  reportsToHide: 3,
  dayMs: 24 * 60 * 60 * 1000,
  queryMaxChars: 64,
  banReasonMax: 200,
  meMax: 200,
  tokenMaxChars: 4096,
  clockLeewayS: 60,
  jwksDefaultMaxAgeS: 3600,
  jwksMinMaxAgeS: 60,
  jwksMaxMaxAgeS: 24 * 3600,
  jwksRefetchCooldownMs: 60 * 1000,
  backfillDefault: 5,
  backfillMax: 50,
  fingerprintHolders: 20,
});

const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const GOOGLE_ISSUERS = new Set(['accounts.google.com', 'https://accounts.google.com']);
// Public author names: handles, plus "official" for the built-ins (admin only).
const HANDLE_RE = /^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])$/;
const AUTHOR_RE = HANDLE_RE;
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/;
const TAG_RE = /^[a-z0-9-]{1,20}$/;
const REF_RE = /^([a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9]))\.([a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9]))$/;
const SUB_HASH_RE = /^[0-9a-f]{64}$/;
const JWT_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const RESERVED_HANDLES = new Set(['official', 'default', 'local', 'admin', 'root', 'support', 'anthropic', 'claude', 'gallery', 'api']);
// Windows device names too: the app saves skins in a folder named <handle>.<slug>.
export const isReservedHandle = (h) => RESERVED_HANDLES.has(h) || h.startsWith('official') || /^(?:con|prn|aux|nul|com\d|lpt\d)$/.test(h);
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
    ...basedOnFields(row),
  };
}

// A declared remix: the original's ref, and its name while it is visible.
function basedOnFields(row) {
  if (typeof row.based_on !== 'string' || !REF_RE.test(row.based_on)) return {};
  return { basedOn: row.based_on, basedOnName: typeof row.based_on_name === 'string' ? row.based_on_name : null };
}

// The original's name for a remix, looked up by primary key.
const BASED_ON_NAME = `(SELECT o.name FROM skins o
    WHERE o.author = substr(skins.based_on, 1, instr(skins.based_on, '.') - 1)
      AND o.slug = substr(skins.based_on, instr(skins.based_on, '.') + 1) AND o.hidden = 0) AS based_on_name`;

const LIST_COLUMNS = `author, slug, name, description, tags, version, downloads, updated_at, hidden, reports,
  (scene IS NOT NULL) AS has_scene, json_extract(skin_json, '$.colors') AS colors, based_on, ${BASED_ON_NAME}`;

// ------------------------------------------------------------------ auth

// Google's signing keys, cached per isolate by kid. Tests pass their own cache.
export function newJwksCache() {
  return { keys: new Map(), expiresAt: 0, fetchedAt: Number.NEGATIVE_INFINITY };
}
const sharedJwksCache = newJwksCache();

function b64urlBytes(s) {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

function b64urlJson(s) {
  const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(b64urlBytes(s)));
  if (!isRecord(value)) throw new Error('not an object');
  return value;
}

function parseJwt(token) {
  if (token.length > LIMITS.tokenMaxChars || !JWT_RE.test(token)) throw new HttpError(401, 'invalid token');
  const [h, p, s] = token.split('.');
  let header;
  let payload;
  let signature;
  try {
    header = b64urlJson(h);
    payload = b64urlJson(p);
    signature = b64urlBytes(s);
  } catch {
    throw new HttpError(401, 'invalid token');
  }
  if (header.alg !== 'RS256' || typeof header.kid !== 'string' || header.kid === '' || header.kid.length > 128) {
    throw new HttpError(401, 'invalid token');
  }
  return { header, payload, signature, signingInput: new TextEncoder().encode(`${h}.${p}`) };
}

async function refreshJwks(cache, deps) {
  let res;
  try {
    res = await deps.fetch(GOOGLE_JWKS_URL, { headers: { Accept: 'application/json' } });
  } catch {
    throw new HttpError(502, 'could not fetch Google signing keys');
  }
  if (!res.ok) throw new HttpError(502, `Google signing keys answered ${res.status}`);
  let data;
  try {
    data = await res.json();
  } catch {
    throw new HttpError(502, 'Google signing keys were unreadable');
  }
  const keys = new Map();
  for (const jwk of Array.isArray(data?.keys) ? data.keys : []) {
    if (!isRecord(jwk) || jwk.kty !== 'RSA' || typeof jwk.kid !== 'string' || typeof jwk.n !== 'string' || typeof jwk.e !== 'string') continue;
    if (jwk.alg !== undefined && jwk.alg !== 'RS256') continue;
    if (jwk.use !== undefined && jwk.use !== 'sig') continue;
    try {
      const key = await crypto.subtle.importKey(
        'jwk',
        { kty: 'RSA', n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
        { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
        false,
        ['verify'],
      );
      keys.set(jwk.kid, key);
    } catch {
      // Skip keys WebCrypto refuses.
    }
  }
  const m = /max-age=(\d+)/i.exec(res.headers.get('Cache-Control') || '');
  const maxAge = Math.min(LIMITS.jwksMaxMaxAgeS, Math.max(LIMITS.jwksMinMaxAgeS, m ? Number(m[1]) : LIMITS.jwksDefaultMaxAgeS));
  const now = deps.now();
  cache.keys = keys;
  cache.fetchedAt = now;
  cache.expiresAt = now + maxAge * 1000;
}

async function signingKey(kid, deps) {
  const cache = deps.jwks;
  if (deps.now() >= cache.expiresAt) await refreshJwks(cache, deps);
  let key = cache.keys.get(kid);
  // Unknown kid: Google may have rotated keys. Refetch once, but not more than
  // once a minute, so garbage kids cannot turn into a fetch per request.
  if (!key && deps.now() - cache.fetchedAt >= LIMITS.jwksRefetchCooldownMs) {
    await refreshJwks(cache, deps);
    key = cache.keys.get(kid);
  }
  if (!key) throw new HttpError(401, 'unknown signing key');
  return key;
}

// Verify a Google ID token and return its `sub`.
async function verifyGoogleToken(token, env, deps) {
  const jwt = parseJwt(token);
  const clientId = env.GOOGLE_CLIENT_ID;
  if (typeof clientId !== 'string' || clientId === '') throw new HttpError(503, 'sign-in not configured');
  const key = await signingKey(jwt.header.kid, deps);
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, jwt.signature, jwt.signingInput);
  if (!ok) throw new HttpError(401, 'invalid token signature');
  const c = jwt.payload;
  const nowS = deps.now() / 1000;
  if (typeof c.iss !== 'string' || !GOOGLE_ISSUERS.has(c.iss)) throw new HttpError(401, 'token has the wrong issuer');
  if (c.aud !== clientId) throw new HttpError(401, 'token has the wrong audience');
  if (typeof c.exp !== 'number' || !Number.isFinite(c.exp) || c.exp + LIMITS.clockLeewayS <= nowS) throw new HttpError(401, 'token expired');
  if (typeof c.iat !== 'number' || !Number.isFinite(c.iat) || c.iat - LIMITS.clockLeewayS > nowS) throw new HttpError(401, 'token issued in the future');
  if (typeof c.sub !== 'string' || c.sub === '' || c.sub.length > 255) throw new HttpError(401, 'invalid token');
  return c.sub;
}

function requireSalt(env) {
  const salt = env.IP_SALT;
  if (typeof salt !== 'string' || salt.length < 16) throw new HttpError(500, 'server is not configured');
  return salt;
}

async function hmacHex(secret, message) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message)));
}

// Resolve the caller to { subHash, handle|null }. Banned accounts get 403.
async function resolveAccount(request, env, deps) {
  const header = request.headers.get('Authorization') || '';
  const m = /^Bearer\s+(\S+)\s*$/i.exec(header);
  if (!m) throw new HttpError(401, 'sign in with Google: Authorization: Bearer <ID token>');
  const sub = await verifyGoogleToken(m[1], env, deps);
  const subHash = await hmacHex(requireSalt(env), sub);
  const banned = await env.DB.prepare('SELECT 1 AS x FROM bans WHERE sub_hash = ?').bind(subHash).first('x');
  if (banned) throw new HttpError(403, 'this account is banned from the gallery');
  const handle = await env.DB.prepare('SELECT handle FROM accounts WHERE sub_hash = ?').bind(subHash).first('handle');
  return { subHash, handle: handle ?? null };
}

async function requireAdmin(request, env) {
  const given = request.headers.get('X-Admin-Token');
  const secret = env.ADMIN_TOKEN;
  if (typeof secret !== 'string' || secret.length < 32) throw new HttpError(403, 'admin is disabled');
  if (!given) throw new HttpError(401, 'X-Admin-Token required');
  if (!(await safeEqual(given, secret))) throw new HttpError(403, 'wrong admin token');
}

async function clientHash(request, env) {
  const salt = requireSalt(env);
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

function upsertStatement(env, author, skin, scene, now, { fingerprint, basedOn }) {
  return env.DB.prepare(
    `INSERT INTO skins (author, slug, name, description, tags, version, skin_json, scene, fingerprint, based_on, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (author, slug) DO UPDATE SET
       name = excluded.name, description = excluded.description, tags = excluded.tags,
       skin_json = excluded.skin_json, scene = excluded.scene,
       fingerprint = excluded.fingerprint, based_on = excluded.based_on,
       version = skins.version + 1, updated_at = excluded.updated_at
     RETURNING version`,
  ).bind(author, skin.slug, skin.name, skin.description, JSON.stringify(skin.tags), JSON.stringify(skin), scene, fingerprint, basedOn, now, now);
}

// `basedOn` in an upload body: absent/null, or "<author>.<slug>".
function parseBasedOn(body) {
  const v = body.basedOn;
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string' || !REF_RE.test(v)) throw new HttpError(400, 'basedOn must be "<author>.<slug>"');
  return v;
}

// The remix credit to store: the one sent, else the one this skin already has.
// Dropped when it names the skin itself or a skin that no longer exists.
async function resolveBasedOn(env, author, slug, sent) {
  let basedOn = sent;
  if (basedOn === null) {
    basedOn = (await env.DB.prepare('SELECT based_on FROM skins WHERE author = ? AND slug = ?').bind(author, slug).first('based_on')) ?? null;
  }
  if (basedOn === null || basedOn === `${author}.${slug}`) return null;
  const [, a, s] = REF_RE.exec(basedOn) ?? [];
  if (!a) return null;
  const exists = await env.DB.prepare('SELECT 1 AS x FROM skins WHERE author = ? AND slug = ?').bind(a, s).first('x');
  return exists ? basedOn : null;
}

// Another author's skin (hidden ones too) that draws the same thing is refused,
// unless the upload declares itself a remix of one of them.
async function refuseCopies(env, author, fingerprint, basedOn) {
  const { results } = await env.DB.prepare(
    'SELECT author, slug, name FROM skins WHERE fingerprint = ? AND author <> ? ORDER BY created_at, author, slug LIMIT ?',
  )
    .bind(fingerprint, author, LIMITS.fingerprintHolders)
    .all();
  if (results.length === 0) return;
  if (basedOn !== null && results.some((r) => `${r.author}.${r.slug}` === basedOn)) return;
  const first = results[0];
  throw new HttpError(409, 'already in the gallery', { original: `${first.author}.${first.slug}`, name: first.name });
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

// The project website (GitHub Pages) has the home page, privacy policy and terms.
const SITE_URL = 'https://bowen1314.github.io/claude-skin-switcher/';
const SITE_PAGES = { '': SITE_URL, privacy: `${SITE_URL}privacy.html`, terms: `${SITE_URL}terms.html` };

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
    if (!AUTHOR_RE.test(author) || !SLUG_RE.test(slug)) throw new HttpError(404, 'skin not found');
  };
  const preflight = () => new Response(null, { status: 204, headers: CORS });

  // /, /privacy, /terms: moved to the website.
  if (parts.length <= 1 && Object.hasOwn(SITE_PAGES, parts[0] ?? '')) {
    if (allow('GET', 'HEAD') === 'preflight') return preflight();
    return new Response(null, { status: 301, headers: { Location: SITE_PAGES[parts[0] ?? ''], 'Cache-Control': 'public, max-age=86400' } });
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
    const acct = await resolveAccount(request, env, deps);
    if (!acct.handle) return json(200, { handle: null, skins: [] });
    const { results } = await env.DB.prepare(`SELECT ${LIST_COLUMNS} FROM skins WHERE author = ? ORDER BY updated_at DESC LIMIT ?`)
      .bind(acct.handle, LIMITS.meMax)
      .all();
    return json(200, {
      handle: acct.handle,
      skins: results.map((r) => ({ ...listItem(r), hidden: r.hidden === 1, reports: r.reports })),
    });
  }

  // /api/me/handle
  if (n === 3 && a === 'me' && b === 'handle') {
    allow('POST');
    const acct = await resolveAccount(request, env, deps);
    const body = await readJsonBody(request, LIMITS.smallBodyMaxBytes);
    const handle = typeof body?.handle === 'string' ? body.handle.trim().toLowerCase() : '';
    if (!HANDLE_RE.test(handle)) throw new HttpError(400, 'handle must be 3 to 32 of a-z, 0-9 and inner hyphens');
    if (isReservedHandle(handle)) throw new HttpError(409, 'handle reserved');
    if (acct.handle === handle) return json(200, { handle });
    if (acct.handle) {
      const owned = await env.DB.prepare('SELECT COUNT(*) AS n FROM skins WHERE author = ?').bind(acct.handle).first('n');
      if (owned > 0) throw new HttpError(409, 'handle locked');
    }
    const now = deps.now();
    const recent = await env.DB.prepare('SELECT COUNT(*) AS n FROM handle_log WHERE sub_hash = ? AND created_at > ?')
      .bind(acct.subHash, now - LIMITS.dayMs)
      .first('n');
    if (recent >= LIMITS.handleClaimsPerDay) throw new HttpError(429, `at most ${LIMITS.handleClaimsPerDay} handle changes per 24 hours`);
    // Taken by another account, or used as an author by admin-placed skins.
    const taken = await env.DB.prepare(
      'SELECT 1 AS x FROM accounts WHERE handle = ?1 AND sub_hash <> ?2 UNION ALL SELECT 1 AS x FROM skins WHERE author = ?1 LIMIT 1',
    )
      .bind(handle, acct.subHash)
      .first('x');
    if (taken) throw new HttpError(409, 'handle taken');
    try {
      await env.DB.batch([
        env.DB.prepare('INSERT INTO accounts (sub_hash, handle, created_at) VALUES (?, ?, ?) ON CONFLICT (sub_hash) DO UPDATE SET handle = excluded.handle')
          .bind(acct.subHash, handle, now),
        env.DB.prepare('INSERT INTO handle_log (sub_hash, created_at) VALUES (?, ?)').bind(acct.subHash, now),
        env.DB.prepare('DELETE FROM handle_log WHERE created_at <= ?').bind(now - LIMITS.dayMs),
      ]);
    } catch (err) {
      if (/UNIQUE/i.test(String(err && err.message))) throw new HttpError(409, 'handle taken');
      throw err;
    }
    return json(200, { handle });
  }

  // /api/skins
  if (n === 2 && a === 'skins') {
    const m = allow('GET', 'POST');
    if (m === 'preflight') return preflight();
    if (m === 'GET') return listSkins(url, env);
    const acct = await resolveAccount(request, env, deps);
    if (!acct.handle) throw new HttpError(409, 'no handle');
    const body = await readJsonBody(request, LIMITS.bodyMaxBytes);
    const { skin, scene } = checkPayload(body);
    const sentBasedOn = parseBasedOn(body);
    const now = deps.now();
    const recent = await env.DB.prepare('SELECT COUNT(*) AS n FROM upload_log WHERE sub_hash = ? AND created_at > ?')
      .bind(acct.subHash, now - LIMITS.dayMs)
      .first('n');
    if (recent >= LIMITS.uploadsPerDay) {
      throw new HttpError(429, `at most ${LIMITS.uploadsPerDay} uploads per 24 hours`);
    }
    const fingerprint = await skinFingerprint(skin, scene);
    const basedOn = await resolveBasedOn(env, acct.handle, skin.slug, sentBasedOn);
    await refuseCopies(env, acct.handle, fingerprint, basedOn);
    const [saved] = await env.DB.batch([
      upsertStatement(env, acct.handle, skin, scene, now, { fingerprint, basedOn }),
      env.DB.prepare('INSERT INTO upload_log (sub_hash, created_at) VALUES (?, ?)').bind(acct.subHash, now),
      env.DB.prepare('DELETE FROM upload_log WHERE created_at <= ?').bind(now - LIMITS.dayMs),
    ]);
    return savedResponse(acct.handle, skin.slug, saved.results[0].version);
  }

  // /api/skins/:author/:slug[/scene.svg|/download|/report]
  if (a === 'skins' && n >= 4 && n <= 5) {
    ref(b, c);
    if (n === 4) {
      const m = allow('GET', 'DELETE');
      if (m === 'preflight') return preflight();
      if (m === 'GET') {
        const row = await getVisible(env, b, c, `skin_json, version, based_on, ${BASED_ON_NAME}`);
        const skin = JSON.parse(row.skin_json);
        return json(200, { ...skin, author: b, version: row.version, ...basedOnFields(row) }, { cors: true, headers: { 'Cache-Control': 'public, max-age=60' } });
      }
      const acct = await resolveAccount(request, env, deps);
      if (acct.handle !== b) throw new HttpError(403, 'you can only delete your own skins');
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
      const body = await readJsonBody(request, LIMITS.smallBodyMaxBytes);
      if (!isRecord(body)) throw new HttpError(400, 'body must be { "handle": "..." } or { "sub_hash": "..." }');
      const byHandle = body.handle !== undefined;
      const bySub = body.sub_hash !== undefined;
      if (byHandle === bySub) throw new HttpError(400, 'give exactly one of handle or sub_hash');
      const reason = body.reason === undefined ? '' : body.reason;
      if (typeof reason !== 'string' || reason.length > LIMITS.banReasonMax) throw new HttpError(400, `reason must be a string of at most ${LIMITS.banReasonMax} characters`);
      let subHash;
      let handle;
      if (byHandle) {
        handle = typeof body.handle === 'string' ? body.handle.trim().toLowerCase() : '';
        if (!HANDLE_RE.test(handle)) throw new HttpError(400, 'handle is not a valid handle');
        subHash = await env.DB.prepare('SELECT sub_hash FROM accounts WHERE handle = ?').bind(handle).first('sub_hash');
        if (!subHash) throw new HttpError(404, 'no account has that handle');
      } else {
        subHash = typeof body.sub_hash === 'string' ? body.sub_hash.trim().toLowerCase() : '';
        if (!SUB_HASH_RE.test(subHash)) throw new HttpError(400, 'sub_hash must be 64 hex characters');
        handle = await env.DB.prepare('SELECT handle FROM accounts WHERE sub_hash = ?').bind(subHash).first('handle');
      }
      const statements = [
        env.DB.prepare('INSERT INTO bans (sub_hash, reason, created_at) VALUES (?, ?, ?) ON CONFLICT (sub_hash) DO UPDATE SET reason = excluded.reason')
          .bind(subHash, reason, deps.now()),
      ];
      if (handle) statements.push(env.DB.prepare('UPDATE skins SET hidden = 1 WHERE author = ?').bind(handle));
      const results = await env.DB.batch(statements);
      return json(200, { ok: true, subHash, handle: handle ?? null, hiddenSkins: results[1]?.meta?.changes ?? 0 });
    }
    if (n === 3 && b === 'fingerprints') {
      allow('POST');
      return backfillFingerprints(env, await readJsonBody(request, LIMITS.smallBodyMaxBytes));
    }
    if (b === 'skins' && (n === 5 || n === 6)) {
      ref(c, d);
      if (n === 5) {
        const m = allow('PUT', 'DELETE');
        if (m === 'PUT') {
          const body = await readJsonBody(request, LIMITS.bodyMaxBytes);
          const { skin, scene } = checkPayload(body, { pathSlug: d });
          const fingerprint = await skinFingerprint(skin, scene);
          const basedOn = await resolveBasedOn(env, c, skin.slug, parseBasedOn(body));
          const [saved] = await env.DB.batch([upsertStatement(env, c, skin, scene, deps.now(), { fingerprint, basedOn })]);
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

// Fills in missing fingerprints in pages ordered by (author, slug). Body:
// { limit?, after?: "<author>.<slug>", dryRun? }. Rows whose stored skin can't
// be read are listed in `failed` and skipped.
async function backfillFingerprints(env, body) {
  if (!isRecord(body)) throw new HttpError(400, 'body must be { "limit"?, "after"?, "dryRun"? }');
  const limit = body.limit === undefined ? LIMITS.backfillDefault : body.limit;
  if (!Number.isInteger(limit) || limit < 1 || limit > LIMITS.backfillMax) throw new HttpError(400, `limit must be 1 to ${LIMITS.backfillMax}`);
  let after = ['', ''];
  if (body.after !== undefined && body.after !== null) {
    const m = typeof body.after === 'string' ? REF_RE.exec(body.after) : null;
    if (!m) throw new HttpError(400, 'after must be "<author>.<slug>"');
    after = [m[1], m[2]];
  }
  const dryRun = body.dryRun === true;
  const { results } = await env.DB.prepare(
    'SELECT author, slug, skin_json, scene FROM skins WHERE fingerprint IS NULL AND (author, slug) > (?, ?) ORDER BY author, slug LIMIT ?',
  )
    .bind(after[0], after[1], limit)
    .all();
  const updates = [];
  const failed = [];
  for (const row of results) {
    try {
      const fingerprint = await skinFingerprint(JSON.parse(row.skin_json), row.scene);
      updates.push(env.DB.prepare('UPDATE skins SET fingerprint = ? WHERE author = ? AND slug = ? AND fingerprint IS NULL').bind(fingerprint, row.author, row.slug));
    } catch {
      failed.push(`${row.author}.${row.slug}`);
    }
  }
  if (!dryRun && updates.length) await env.DB.batch(updates);
  const last = results[results.length - 1];
  const remaining = await env.DB.prepare('SELECT COUNT(*) AS n FROM skins WHERE fingerprint IS NULL').first('n');
  return json(200, {
    ok: true,
    dryRun,
    updated: dryRun ? 0 : updates.length,
    computed: updates.length,
    failed,
    next: results.length === limit && last ? `${last.author}.${last.slug}` : null,
    remaining,
  });
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
 * @param {{ DB: D1Database, GOOGLE_CLIENT_ID?: string, ADMIN_TOKEN?: string, IP_SALT?: string }} env
 * @param {{ fetch?: typeof fetch, now?: () => number, jwks?: ReturnType<typeof newJwksCache> }} [deps]
 */
export async function handle(request, env, deps = {}) {
  const d = {
    fetch: deps.fetch ?? ((...args) => fetch(...args)),
    now: deps.now ?? (() => Date.now()),
    jwks: deps.jwks ?? sharedJwksCache,
  };
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
