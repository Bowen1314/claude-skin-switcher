'use strict'

// Google sign-in for an installed app: loopback redirect + PKCE.
// https://developers.google.com/identity/protocols/oauth2/native-app
// Scope is only `openid`: the gallery learns an opaque account id, never an
// email or name. Only the refresh token is kept (encrypted, see token-store.js).

const crypto = require('node:crypto')
const http = require('node:http')

const { HttpError, parseJson, request } = require('./http')

const TIMEOUT_MS = 5 * 60 * 1000
const EARLY_MS = 5 * 60 * 1000 // refresh an id token this long before it expires

const b64url = buf => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

const pkce = () => {
  const verifier = b64url(crypto.randomBytes(32))

  return { verifier, challenge: b64url(crypto.createHash('sha256').update(verifier).digest()) }
}

const page = (title, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title>
<meta name="color-scheme" content="light dark"><style>body{font:16px/1.5 -apple-system,system-ui,sans-serif;display:grid;place-items:center;min-height:90vh;margin:0}
main{text-align:center;max-width:28rem;padding:2rem}h1{font-size:1.4rem;margin:0 0 .5rem}p{opacity:.7;margin:0}</style></head>
<body><main><h1>${title}</h1><p>${body}</p></main><script>setTimeout(function(){window.close()},800)</script></body></html>
`
const DONE_PAGE = page('Signed in to Claude Skin Switcher', 'You can close this tab. The app is back in front.')
const FAIL_PAGE = page('Sign-in did not finish', 'You can close this tab and try again in the app.')

// Starts the one-shot listener and opens the browser. Returns
// { url, redirectUri, verifier, result: Promise<{code}|{error}>, cancel() }.
const startLoopback = async ({ authUrl, clientId, openExternal, timeoutMs = TIMEOUT_MS }) => {
  if (!clientId) {
    throw new HttpError('Sign-in is not configured in this build', { code: 'not-configured' })
  }
  const { verifier, challenge } = pkce()
  const state = b64url(crypto.randomBytes(16))
  let finish
  const result = new Promise(resolve => {
    finish = resolve
  })
  let settled = false
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')

    // Only the redirect itself counts: right path, right state. Anything else is ignored.
    if (req.method !== 'GET' || url.pathname !== '/' || settled) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('Not found\n')

      return
    }
    if (url.searchParams.get('state') !== state) {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('This sign-in link is not the one the app started.\n')

      return
    }
    const code = url.searchParams.get('code')
    const error = url.searchParams.get('error')
    const ok = typeof code === 'string' && code !== ''

    res.writeHead(ok ? 200 : 400, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'",
      Connection: 'close',
    })
    res.end(ok ? DONE_PAGE : FAIL_PAGE)
    done(ok ? { code } : { error: error || 'no_code' })
  })
  const timer = setTimeout(() => done({ error: 'timeout' }), timeoutMs)
  const done = value => {
    if (settled) {
      return
    }
    settled = true
    clearTimeout(timer)
    server.close()
    server.closeIdleConnections?.()
    finish(value)
  }

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const redirectUri = `http://127.0.0.1:${server.address().port}`
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'openid',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
    access_type: 'offline',
    prompt: 'consent',
  })
  const url = `${authUrl}?${params}`

  try {
    await openExternal(url)
  } catch (error) {
    done({ error: 'browser' })
  }

  return { url, redirectUri, verifier, result, cancel: () => done({ error: 'cancelled' }) }
}

const postForm = async (tokenUrl, fields, fetchImpl) => {
  const res = await request(tokenUrl, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
    fetchImpl,
    maxBytes: 64 * 1024,
  })
  const data = parseJson(res.text) ?? {}

  if (!res.ok || typeof data.error === 'string') {
    throw new HttpError(String(data.error_description ?? data.error ?? `HTTP ${res.status}`).slice(0, 200), { status: res.status, code: typeof data.error === 'string' ? data.error : 'http' })
  }

  return data
}

// Seconds-since-epoch `exp` from an id token, unverified (the gallery verifies it).
const expiryOf = idToken => {
  try {
    const payload = JSON.parse(Buffer.from(String(idToken).split('.')[1], 'base64url').toString('utf8'))

    return Number.isFinite(payload.exp) ? payload.exp * 1000 : null
  } catch {
    return null
  }
}

const tokenResult = (data, now) => {
  if (typeof data.id_token !== 'string' || data.id_token === '') {
    throw new HttpError('Google sent no id token', { code: 'invalid' })
  }
  const exp = expiryOf(data.id_token) ?? now + (Number.isFinite(data.expires_in) ? data.expires_in : 3600) * 1000

  return { idToken: data.id_token, expiresAt: exp }
}

// code -> { refreshToken, idToken, expiresAt }
const exchangeCode = async ({ tokenUrl, clientId, clientSecret, code, verifier, redirectUri, fetchImpl, now = Date.now }) => {
  const data = await postForm(tokenUrl, { client_id: clientId, client_secret: clientSecret, code, code_verifier: verifier, redirect_uri: redirectUri, grant_type: 'authorization_code' }, fetchImpl)

  if (typeof data.refresh_token !== 'string' || data.refresh_token === '') {
    throw new HttpError('Google sent no refresh token', { code: 'invalid' })
  }

  return { refreshToken: data.refresh_token, ...tokenResult(data, now()) }
}

// refresh token -> { idToken, expiresAt }; throws code 'invalid_grant' when revoked.
const refreshIdToken = async ({ tokenUrl, clientId, clientSecret, refreshToken, fetchImpl, now = Date.now }) =>
  tokenResult(await postForm(tokenUrl, { client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: 'refresh_token' }, fetchImpl), now())

const isFresh = (cached, now) => cached !== null && cached.expiresAt - EARLY_MS > now

module.exports = { startLoopback, exchangeCode, refreshIdToken, expiryOf, isFresh, pkce, b64url, TIMEOUT_MS, EARLY_MS }
