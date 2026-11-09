#!/usr/bin/env node
// Optional LAN HTTPS bridge. Gateway, WebUI and provider code stay unchanged.
import http from 'node:http'
import https from 'node:https'
import { execFileSync } from 'node:child_process'
import { randomBytes, X509Certificate } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { networkInterfaces } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import QRCode from 'qrcode'
import { joinPage } from './join-page.mjs'

process.umask(0o077)
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const state = resolve(root, 'runtime/lan-share')
const args = process.argv.slice(2)
if (args.includes('--help')) {
  console.log('node scripts/lan-share/server.mjs --host LAN_IP [--prepare]\nGateway must already run at http://127.0.0.1:3101.\nHTTP setup: 3080; HTTPS conversation: 8443. State: runtime/lan-share/.')
  process.exit(0)
}
const hostArg = args.indexOf('--host')
const host = hostArg >= 0 ? args[hostArg + 1] : Object.values(networkInterfaces()).flat()
  .find(item => item.family === 'IPv4' && !item.internal && /^192\.168\./.test(item.address))?.address
const privateIPv4 = value => /^10\./.test(value) || /^192\.168\./.test(value)
  || /^172\.(1[6-9]|2\d|3[01])\./.test(value)
if (!host || !/^\d+\.\d+\.\d+\.\d+$/.test(host) || !privateIPv4(host)
  || !Object.values(networkInterfaces()).flat().some(item => item.address === host)) {
  throw new Error('Use --host with a private IPv4 address assigned to this computer.')
}
const origin = `https://${host}:8443`
const setupOrigin = `http://${host}:3080`
const file = name => resolve(state, name)
mkdirSync(state, { recursive: true, mode: 0o700 })
const openssl = parameters => execFileSync('openssl', parameters, { stdio: 'pipe' })

function prepareCertificates() {
  if (!existsSync(file('root-ca.key')) && !existsSync(file('root-ca.crt'))) {
    openssl(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '365',
      '-subj', '/CN=Qwen LAN Share Root CA/O=Qwen Local Share',
      '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign',
      '-keyout', file('root-ca.key'), '-out', file('root-ca.crt')])
  }
  if (!existsSync(file('root-ca.key')) || !existsSync(file('root-ca.crt'))) {
    throw new Error('Local CA is incomplete; restore its matching key and certificate.')
  }
  const ca = new X509Certificate(readFileSync(file('root-ca.crt')))
  if (Date.parse(ca.validTo) < Date.now() + 86_400_000) {
    throw new Error('Local CA expires soon; generate a new CA and trust it on the phone again.')
  }
  if (existsSync(file('server.crt')) && existsSync(file('server.key'))) {
    const cert = new X509Certificate(readFileSync(file('server.crt')))
    if (cert.checkIP(host) && cert.verify(ca.publicKey) && Date.parse(cert.validTo) > Date.now() + 86_400_000) return
  }
  openssl(['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-sha256',
    '-subj', `/CN=${host}`, '-keyout', file('server.key'), '-out', file('server.csr')])
  writeFileSync(file('server.ext'), `basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=IP:${host}\n`)
  openssl(['x509', '-req', '-in', file('server.csr'), '-CA', file('root-ca.crt'),
    '-CAkey', file('root-ca.key'), '-set_serial', `0x${randomBytes(16).toString('hex')}`,
    '-days', '90', '-sha256', '-extfile', file('server.ext'), '-out', file('server.crt')])
}

async function localApi(path, options = {}) {
  const response = await fetch(`http://127.0.0.1:3101${path}`, {
    ...options, signal: AbortSignal.timeout(10_000),
  })
  if (!response.ok) throw new Error(`Gateway ${path}: HTTP ${response.status}`)
  return response.json()
}

prepareCertificates()
async function waitForGateway() {
  const deadline = Date.now() + 30_000
  for (;;) {
    try { return await localApi('/api/health') } catch (error) {
      if (Date.now() >= deadline) throw error
      await delay(500)
    }
  }
}
const health = await waitForGateway()
let saved = existsSync(file('connection.json')) ? JSON.parse(readFileSync(file('connection.json'), 'utf8')) : null
const devices = await localApi('/api/access/devices')
if (!saved || saved.origin !== origin || !devices.devices.some(device => device.id === saved.deviceId && !device.revokedAt)) {
  const issued = await localApi('/api/access/devices', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ endpoint: origin, device: { type: 'web', label: 'Android LAN browser' } }),
  })
  saved = { origin, deviceId: issued.device.id, connectionCode: issued.connection_code,
    setupToken: randomBytes(24).toString('hex') }
  writeFileSync(file('connection.json'), JSON.stringify(saved, null, 2), { mode: 0o600 })
}
const setupPath = `/share/${saved.setupToken}`
const setupUrl = `${setupOrigin}${setupPath}`
const secureSetupUrl = `${origin}${setupPath}`
await QRCode.toFile(file('share-qr.png'), setupUrl, { width: 420, margin: 2 })
const connectionQr = await QRCode.toDataURL(saved.connectionCode, { width: 300, margin: 2 })
const caBytes = readFileSync(file('root-ca.crt'))
const escapeHtml = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]))

function page(secure) {
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>Qwen 手机对话</title><style>body{font:16px/1.7 system-ui,sans-serif;max-width:600px;margin:32px auto;padding:0 22px;color:#17202a}h1{font-size:26px}a{color:#145fc0;overflow-wrap:anywhere}.button{display:block;background:#145fc0;color:white;text-decoration:none;text-align:center;border-radius:10px;padding:12px;margin:18px 0}li{margin:14px 0}small{color:#576574}img{max-width:100%;display:block;margin:20px auto}code{overflow-wrap:anywhere}</style><h1>在手机上与 Qwen 对话</h1><p>手机与电脑连接同一局域网，电脑保持运行。</p>${secure
    ? `<p>点击下方按钮，首次在配对页点击 <strong>Connect</strong>，然后允许浏览器使用麦克风。</p><a class="button" href="${escapeHtml(saved.connectionCode)}">进入语音对话</a><p>电脑上打开此页时，也可以用手机扫描连接二维码：</p><img alt="对话连接二维码" src="${connectionQr}"><small>此连接对应你的手机设备，请仅分享给自己。</small>`
    : `<ol><li><a href="/root-ca.crt" download="qwen-lan-root-ca.crt">下载局域网证书</a>。</li><li>在安卓设置中搜索“安装证书”，选择 <strong>CA 证书</strong>，安装下载的 <code>qwen-lan-root-ca.crt</code>。不同手机菜单略有差异，通常位于“安全与隐私 → 更多安全设置 → 安装证书”。这是此电脑为局域网 HTTPS 生成的证书，只需安装一次。</li><li>安装后回到当前浏览器的这个页面，点击下方按钮，在当前标签页继续。无需退出、重启或另外打开浏览器。确认没有证书错误后，点击“进入语音对话”。</li></ol><a class="button" href="${secureSetupUrl}">证书已安装，在当前页继续对话</a><p><small>页面能打开但不能收音时，确认已安装为 CA 证书，并给当前浏览器麦克风权限。仅当你正在使用微信等 App 的内置浏览器时，才需要切换到 Chrome 或系统浏览器；已经在浏览器中的用户无需切换。无需安装 App。</small></p>`}<p><small>当前模型：${escapeHtml(health.realtimeModel)}。运行位置：${host}。</small></p></html>`
}

function helper(req, res, secure) {
  res.setHeader('cache-control', 'no-store')
  res.setHeader('referrer-policy', 'no-referrer')
  res.setHeader('x-content-type-options', 'nosniff')
  if (req.url.split('?')[0] === '/join') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'" })
    res.end(joinPage(origin, new X509Certificate(caBytes).fingerprint256))
    return true
  }
  if (req.url === '/root-ca.crt') {
    res.writeHead(200, { 'content-type': 'application/x-x509-ca-cert',
      'content-disposition': 'attachment; filename="qwen-lan-root-ca.crt"' })
    res.end(caBytes)
    return true
  }
  if (req.url === setupPath) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; frame-ancestors 'none'" })
    res.end(page(secure))
    return true
  }
  return false
}

function forwardHeaders(req) {
  const headers = Object.fromEntries(Object.entries(req.headers).filter(([name]) =>
    !/^(?:forwarded|via|x-real-ip|x-forwarded-.*)$/i.test(name)))
  return { ...headers, 'x-forwarded-for': req.socket.remoteAddress, 'x-forwarded-proto': 'https' }
}
const validHost = (req, secure) => req.headers.host === `${host}:${secure ? 8443 : 3080}`
const reject = res => { res.writeHead(404); res.end('Not found') }

console.log(JSON.stringify({ setupUrl, secureSetupUrl, deviceId: saved.deviceId,
  model: health.realtimeModel, voiceConfigured: health.voiceConfigured,
  qrFile: file('share-qr.png') }))
if (args.includes('--prepare')) process.exit(0)

const bootstrap = http.createServer((req, res) => {
  if (!validHost(req, false) || !['GET', 'HEAD'].includes(req.method) || !helper(req, res, false)) reject(res)
})
const bridge = https.createServer({ key: readFileSync(file('server.key')), cert: readFileSync(file('server.crt')) }, (req, res) => {
  if (!validHost(req, true)) return reject(res)
  if (['GET', 'HEAD'].includes(req.method) && helper(req, res, true)) return
  const upstream = http.request({ hostname: '127.0.0.1', port: 3101, path: req.url,
    method: req.method, headers: forwardHeaders(req) }, incoming => {
    res.writeHead(incoming.statusCode, incoming.headers)
    incoming.pipe(res)
    incoming.on('error', () => res.destroy())
  })
  upstream.on('error', () => {
    if (!res.headersSent) res.writeHead(502)
    res.end('Gateway unavailable')
  })
  req.on('aborted', () => upstream.destroy())
  res.on('close', () => upstream.destroy())
  req.pipe(upstream)
})
bridge.on('upgrade', (req, client, head) => {
  if (!validHost(req, true)) return client.destroy()
  const upstream = http.request({ hostname: '127.0.0.1', port: 3101, path: req.url,
    method: req.method, headers: forwardHeaders(req) })
  upstream.on('upgrade', (response, socket, upstreamHead) => {
    client.write(`HTTP/1.1 ${response.statusCode} ${response.statusMessage}\r\n`)
    for (let i = 0; i < response.rawHeaders.length; i += 2) {
      client.write(`${response.rawHeaders[i]}: ${response.rawHeaders[i + 1]}\r\n`)
    }
    client.write('\r\n')
    if (upstreamHead.length) client.write(upstreamHead)
    if (head.length) socket.write(head)
    socket.on('error', () => client.destroy())
    client.on('error', () => socket.destroy())
    client.on('close', () => socket.destroy())
    socket.on('close', () => client.destroy())
    socket.pipe(client).pipe(socket)
  })
  upstream.on('response', response => {
    response.resume()
    client.end(`HTTP/1.1 ${response.statusCode} ${response.statusMessage}\r\nConnection: close\r\n\r\n`)
  })
  upstream.on('error', () => client.destroy())
  client.on('error', () => upstream.destroy())
  upstream.end()
})
for (const server of [bootstrap, bridge]) server.on('error', error => {
  console.error(error.message)
  process.exit(1)
})
bootstrap.listen(3080, host)
bridge.listen(8443, host)
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  bootstrap.close()
  bridge.close()
  setTimeout(() => process.exit(0), 1000).unref()
})
