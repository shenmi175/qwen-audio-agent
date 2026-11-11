import https from 'node:https'
import http from 'node:http'
import { readFileSync } from 'node:fs'

export function serveProxy(env) {
  const target = new URL('http://127.0.0.1:3300')
  const server = https.createServer({
    key: readFileSync(env.LANGFUSE_TLS_KEY),
    cert: readFileSync(env.LANGFUSE_TLS_CERT),
  }, (req, res) => {
    const headers = { ...req.headers, 'x-forwarded-proto': 'https',
      'x-forwarded-host': req.headers.host, 'x-forwarded-for': req.socket.remoteAddress }
    const destination = req.url.startsWith('/langfuse/')
      ? new URL('http://127.0.0.1:3390') : target
    const upstream = http.request(destination, { method: req.method, path: req.url, headers }, response => {
      res.writeHead(response.statusCode, response.headers)
      response.pipe(res)
    })
    upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end() })
    req.on('aborted', () => upstream.destroy())
    req.pipe(upstream)
  })
  server.requestTimeout = 0
  server.listen(Number(env.LANGFUSE_HTTPS_PORT || 8444), env.LANGFUSE_BIND || '127.0.0.1')
  return server
}
