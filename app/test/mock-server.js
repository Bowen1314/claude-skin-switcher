'use strict'

// A local HTTP server that stands in for the gallery and GitHub in tests.
// routes: { 'METHOD /path': (req, body, url) => ({ status, json?, text?, headers? }) }

const http = require('node:http')

const startMock = async (t, routes) => {
  const calls = []
  const server = http.createServer((req, res) => {
    const chunks = []

    req.on('data', c => chunks.push(c))
    req.on('end', async () => {
      const url = new URL(req.url, 'http://x')
      const body = Buffer.concat(chunks).toString('utf8')

      calls.push({ method: req.method, path: url.pathname, search: url.search, headers: req.headers, body })
      const handler = routes[`${req.method} ${url.pathname}`]

      if (!handler) {
        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'not found' }))

        return
      }
      const out = await handler(req, body, url)

      if (out.hang) {
        return
      }
      const payload = out.json !== undefined ? JSON.stringify(out.json) : (out.text ?? '')

      res.writeHead(out.status ?? 200, { 'Content-Type': out.json !== undefined ? 'application/json' : 'text/plain', ...(out.headers ?? {}) })
      res.end(payload)
    })
  })

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => {
    server.closeAllConnections()
    server.close(resolve)
  }))

  return { url: `http://127.0.0.1:${server.address().port}`, calls }
}

module.exports = { startMock }
