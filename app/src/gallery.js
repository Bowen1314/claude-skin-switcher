'use strict'

// Client for the public skin gallery (server/README.md). Every URL is built
// from an owner and slug that already passed the regexes; every response is
// checked before it reaches the renderer. Names and descriptions stay text.

const { HttpError, request, requestJson } = require('./http')
const { OWNER } = require('./library')

const SLUG = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/
// A public name (the author of uploads), as the server's POST /api/me/handle takes it.
const HANDLE = /^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])$/
const TAG = /^[a-z0-9-]{1,20}$/
const HEX = /^#[0-9a-fA-F]{6}$/
const CURSOR = /^[A-Za-z0-9_\-=]{1,512}$/
// Control, invisible and text-direction characters (same set as the validator's).
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u061c\u200b\u200e\u200f\u2028\u2029\u202a-\u202e\u2060-\u2069\ufeff]/g

const text = (v, max) => (typeof v === 'string' ? v.replace(CONTROL, ' ').slice(0, max) : '')
const count = v => (Number.isSafeInteger(v) && v >= 0 ? v : 0)

const checkName = (author, slug) => {
  if (typeof author !== 'string' || !OWNER.test(author) || typeof slug !== 'string' || !SLUG.test(slug)) {
    throw new HttpError('Not a gallery skin name', { code: 'bad-ref' })
  }

  return `${encodeURIComponent(author)}/${encodeURIComponent(slug)}`
}

const splitRef = ref => {
  const [author, slug, extra] = String(ref).split('.')

  if (extra !== undefined) {
    throw new HttpError('Not a gallery skin name', { code: 'bad-ref' })
  }
  checkName(author, slug)

  return { author, slug }
}

// "<author>.<slug>" if both parts pass the name rules, else null.
const refOrNull = v => {
  if (typeof v !== 'string') {
    return null
  }
  const [author, slug, extra] = v.split('.')

  return extra === undefined && typeof slug === 'string' && OWNER.test(author) && SLUG.test(slug) ? v : null
}

// A declared remix: the original's ref and, while it is listed, its name.
const remixOf = raw => {
  const basedOn = refOrNull(raw?.basedOn)

  return basedOn === null ? {} : { basedOn, basedOnName: text(raw.basedOnName, 40) || null }
}

const palette = p => {
  if (p === null || typeof p !== 'object') {
    return undefined
  }
  const out = {}

  for (const key of ['surface0', 'surface1', 'text', 'muted', 'accent']) {
    if (typeof p[key] !== 'string' || !HEX.test(p[key])) {
      return undefined
    }
    out[key] = p[key]
  }

  return out
}

// A list item as the renderer may see it, or null if unusable.
const listItem = raw => {
  if (raw === null || typeof raw !== 'object') {
    return null
  }
  const author = typeof raw.author === 'string' ? raw.author : ''
  const slug = typeof raw.slug === 'string' ? raw.slug : ''

  if (!OWNER.test(author) || !SLUG.test(slug)) {
    return null
  }
  const preview = {}
  const dark = palette(raw.preview?.dark)
  const light = palette(raw.preview?.light)

  if (dark) {
    preview.dark = dark
  }
  if (light) {
    preview.light = light
  }

  return {
    ref: `${author}.${slug}`,
    author,
    slug,
    name: text(raw.name, 40) || slug,
    description: text(raw.description, 140),
    tags: Array.isArray(raw.tags) ? raw.tags.filter(t => typeof t === 'string' && TAG.test(t)).slice(0, 5) : [],
    version: Number.isSafeInteger(raw.version) && raw.version > 0 ? raw.version : 1,
    downloads: count(raw.downloads),
    hasScene: raw.hasScene === true,
    updatedAt: count(raw.updatedAt),
    preview,
    hidden: raw.hidden === true,
    reports: count(raw.reports),
    ...remixOf(raw),
  }
}

const createGallery = ({ baseUrl, fetchImpl = globalThis.fetch, readOnly = false, deps }) => {
  const base = String(baseUrl).replace(/\/+$/, '')
  const call = (path, opts = {}) => {
    const method = opts.method ?? 'GET'

    if (readOnly && method !== 'GET') {
      throw new HttpError('This run is read-only', { code: 'read-only' })
    }

    return requestJson(`${base}${path}`, { ...opts, fetchImpl })
  }
  const auth = token => {
    if (typeof token !== 'string' || token === '') {
      throw new HttpError('Not signed in', { code: 'no-token' })
    }

    return { Authorization: `Bearer ${token}` }
  }

  return {
    list: async ({ sort = 'new', q = '', tag = '', cursor = '', limit = 24 } = {}) => {
      const p = new URLSearchParams({ sort: sort === 'popular' ? 'popular' : 'new', limit: String(Math.min(50, Math.max(1, limit | 0))) })
      const query = text(q, 64).trim()

      if (query) {
        p.set('q', query)
      }
      if (tag && TAG.test(tag)) {
        p.set('tag', tag)
      }
      if (cursor && CURSOR.test(cursor)) {
        p.set('cursor', cursor)
      }
      const { data } = await call(`/api/skins?${p}`)
      const items = Array.isArray(data?.items) ? data.items.map(listItem).filter(Boolean) : []
      const next = typeof data?.nextCursor === 'string' && CURSOR.test(data.nextCursor) ? data.nextCursor : null

      return { items, nextCursor: next }
    },

    // Skin and scene, both validated. { skin, scene, author, version }
    detail: async (author, slug) => {
      const name = checkName(author, slug)
      const { data } = await call(`/api/skins/${name}`, { maxBytes: 300_000 })
      const checked = deps.validateSkin(data)

      if (!checked.ok) {
        throw new HttpError(`The gallery sent an invalid skin: ${checked.errors[0]}`, { code: 'invalid' })
      }
      if (checked.skin.slug !== slug || data.author !== author) {
        throw new HttpError('The gallery sent a different skin than asked for', { code: 'invalid' })
      }
      let scene = null

      if (checked.skin.backdrop?.scene === true) {
        const res = await request(`${base}/api/skins/${name}/scene.svg`, { fetchImpl, maxBytes: 480_000 })

        if (!res.ok) {
          throw new HttpError(`scene.svg: HTTP ${res.status}`, { status: res.status })
        }
        const sceneCheck = deps.validateScene(res.text)

        if (!sceneCheck.ok) {
          throw new HttpError(`The gallery sent an invalid scene: ${sceneCheck.errors[0]}`, { code: 'invalid' })
        }
        scene = res.text
      }

      return { skin: checked.skin, scene, author, version: Number.isSafeInteger(data.version) && data.version > 0 ? data.version : 1, ...remixOf(data) }
    },

    download: async (author, slug) => (await call(`/api/skins/${checkName(author, slug)}/download`, { method: 'POST' })).data,
    report: async (author, slug) => (await call(`/api/skins/${checkName(author, slug)}/report`, { method: 'POST' })).data,

    // { handle: string|null, skins }. handle is null until a public name is chosen.
    me: async token => {
      const { data } = await call('/api/me', { headers: auth(token) })
      const handle = typeof data?.handle === 'string' && HANDLE.test(data.handle) ? data.handle : null

      return { handle, skins: Array.isArray(data?.skins) ? data.skins.map(listItem).filter(Boolean) : [] }
    },

    // Claim the public name. Errors (409 taken / reserved / handle locked) carry the server's message.
    claimHandle: async (token, handle) => {
      if (typeof handle !== 'string' || !HANDLE.test(handle)) {
        throw new HttpError('3 to 32 of a-z, 0-9 and inner hyphens', { code: 'bad-handle' })
      }
      const { data } = await call('/api/me/handle', {
        method: 'POST',
        headers: { ...auth(token), 'Content-Type': 'application/json' },
        body: JSON.stringify({ handle }),
      })

      return { handle: typeof data?.handle === 'string' && HANDLE.test(data.handle) ? data.handle : handle }
    },

    upload: async (token, payload) => {
      const body = JSON.stringify(payload)
      const { status, data } = await call('/api/skins', {
        method: 'POST',
        headers: { ...auth(token), 'Content-Type': 'application/json' },
        body,
        timeoutMs: 30000,
      })
      const ref = typeof data?.ref === 'string' ? data.ref : ''

      return { created: status === 201, ref, version: Number.isSafeInteger(data?.version) ? data.version : 1 }
    },

    remove: async (token, author, slug) => (await call(`/api/skins/${checkName(author, slug)}`, { method: 'DELETE', headers: auth(token) })).data,
  }
}

module.exports = { createGallery, listItem, splitRef, checkName, refOrNull, SLUG, HANDLE }
