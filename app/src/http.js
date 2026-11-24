'use strict'

// fetch with a timeout and a response size cap. Main process only.

class HttpError extends Error {
  constructor(message, { status = null, data = null, code = 'http' } = {}) {
    super(message)
    this.status = status
    this.data = data
    this.code = code
  }
}

const request = async (url, { method = 'GET', headers = {}, body, timeoutMs = 15000, maxBytes = 1_000_000, fetchImpl = globalThis.fetch } = {}) => {
  let res

  try {
    res = await fetchImpl(url, { method, headers, body, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) })
  } catch (error) {
    const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError'

    throw new HttpError(timedOut ? 'The request timed out' : 'Network error', { code: timedOut ? 'timeout' : 'network' })
  }
  const declared = Number(res.headers.get('content-length'))

  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new HttpError('The response is too large', { status: res.status, code: 'too-large' })
  }
  const text = await res.text()

  if (text.length > maxBytes) {
    throw new HttpError('The response is too large', { status: res.status, code: 'too-large' })
  }

  return { status: res.status, ok: res.ok, text, headers: res.headers }
}

const parseJson = text => {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

// JSON request; non-2xx becomes an HttpError carrying the server's `error`.
const requestJson = async (url, opts = {}) => {
  const res = await request(url, { ...opts, headers: { Accept: 'application/json', ...(opts.headers ?? {}) } })
  const data = parseJson(res.text)

  if (!res.ok) {
    const message = data && typeof data.error === 'string' ? data.error.slice(0, 300) : `HTTP ${res.status}`

    throw new HttpError(message, { status: res.status, data })
  }

  return { status: res.status, data }
}

module.exports = { HttpError, request, requestJson, parseJson }
