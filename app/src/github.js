'use strict'

// GitHub OAuth device flow, no scopes:
// https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#device-flow

const { HttpError, parseJson, request } = require('./http')

const GRANT = 'urn:ietf:params:oauth:grant-type:device_code'

const post = async (url, fields, fetchImpl) => {
  const res = await request(url, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
    fetchImpl,
    maxBytes: 64 * 1024,
  })

  // GitHub reports pending/slow_down in the JSON body; read it whatever the status.
  return { status: res.status, data: parseJson(res.text) ?? {} }
}

// { deviceCode, userCode, verificationUri, interval, expiresIn }
const requestDeviceCode = async ({ githubUrl, clientId, fetchImpl }) => {
  if (!clientId) {
    throw new HttpError('Uploads are not configured in this build', { code: 'not-configured' })
  }
  const { status, data } = await post(`${githubUrl}/login/device/code`, { client_id: clientId }, fetchImpl)

  if (typeof data.error === 'string') {
    throw new HttpError(String(data.error_description ?? data.error).slice(0, 200), { status, code: data.error })
  }
  const userCode = typeof data.user_code === 'string' && /^[A-Z0-9-]{4,16}$/.test(data.user_code) ? data.user_code : null

  if (typeof data.device_code !== 'string' || userCode === null) {
    throw new HttpError('GitHub sent no device code', { status, code: 'invalid' })
  }

  return {
    deviceCode: data.device_code,
    userCode,
    verificationUri: 'https://github.com/login/device',
    interval: Number.isFinite(data.interval) && data.interval > 0 ? data.interval : 5,
    expiresIn: Number.isFinite(data.expires_in) && data.expires_in > 0 ? data.expires_in : 900,
  }
}

const realSleep = ms => new Promise(resolve => setTimeout(resolve, ms))

// Polls until a token arrives. Resolves { token } or { error } with one of:
// expired_token, access_denied, cancelled, or GitHub's own error code.
const pollForToken = async ({ githubUrl, clientId, deviceCode, interval, expiresIn, fetchImpl, sleep = realSleep, now = Date.now, isCancelled = () => false }) => {
  const deadline = now() + expiresIn * 1000
  let wait = interval

  for (;;) {
    await sleep(wait * 1000)
    if (isCancelled()) {
      return { error: 'cancelled' }
    }
    if (now() >= deadline) {
      return { error: 'expired_token' }
    }
    let res

    try {
      res = await post(`${githubUrl}/login/oauth/access_token`, { client_id: clientId, device_code: deviceCode, grant_type: GRANT }, fetchImpl)
    } catch {
      // A network blip: try again after the interval.
      continue
    }
    if (isCancelled()) {
      return { error: 'cancelled' }
    }
    const { data } = res

    if (typeof data.access_token === 'string' && data.access_token !== '') {
      return { token: data.access_token }
    }
    switch (data.error) {
      case 'authorization_pending':
        break
      case 'slow_down':
        wait = Number.isFinite(data.interval) && data.interval > wait ? data.interval : wait + 5
        break
      default:
        return { error: typeof data.error === 'string' ? data.error : 'unexpected_response' }
    }
  }
}

module.exports = { requestDeviceCode, pollForToken, GRANT }
