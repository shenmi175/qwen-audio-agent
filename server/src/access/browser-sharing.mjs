import QRCode from 'qrcode'
import {
  createGatewayPairingCode,
  encodeGatewayBrowserPairingCode,
} from '../../../shared/gateway/remote-access.mjs'

function origin(value, protocols) {
  const url = new URL(value)
  if (!protocols.includes(url.protocol) || url.username || url.password
    || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('分享地址必须为有效的站点 Origin')
  }
  return url.origin
}

export function registerBrowserSharing(app, { config, access, publicEndpoint, getGateway }) {
  const ownerOnly = (req, res, next) => {
    if (req.identity.ownerId !== access.personalOwnerId) {
      return res.status(403).json({ error: '仅电脑主人可以创建和管理分享' })
    }
    res.setHeader('cache-control', 'no-store')
    next()
  }
  app.get('/api/access/shares', ownerOnly, (req, res) => {
    res.json({ shares: access.listBrowserShares(req.identity.ownerId) })
  })
  app.post('/api/access/shares', ownerOnly, async (req, res) => {
    let ticket
    try {
      const secureOrigin = origin(config.gatewayShareOrigin
        || publicEndpoint?.status?.().endpoint?.url
        || `${req.secure || req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http'}://${req.headers.host}`,
      ['https:'])
      const setupOrigin = config.gatewayShareSetupOrigin
        ? origin(config.gatewayShareSetupOrigin, ['http:', 'https:']) : null
      ticket = access.createBrowserShare(req.identity.ownerId)
      const secureUrl = encodeGatewayBrowserPairingCode(createGatewayPairingCode({
        gatewayUrl: secureOrigin, pairingCode: ticket.code, expiresAt: ticket.expiresAt,
      }))
      const url = new URL(secureUrl)
      if (setupOrigin) {
        url.protocol = new URL(setupOrigin).protocol
        url.host = new URL(setupOrigin).host
        url.pathname = '/join'
      }
      const shareUrl = url.toString()
      const [qrCode, secureQrCode] = await Promise.all([shareUrl, secureUrl]
        .map(value => QRCode.toDataURL(value, { width: 320, margin: 3 })))
      res.status(201).json({
        id: ticket.id, url: shareUrl, secureUrl, qrCode, secureQrCode,
        expiresAt: ticket.expiresAt, certificateSetup: Boolean(setupOrigin),
      })
    } catch (error) {
      if (ticket) access.revokeBrowserShare(ticket.id, req.identity.ownerId)
      res.status(409).json({ error: `暂时无法分享：${error.message}。请检查 HTTPS 分享地址配置。` })
    }
  })
  app.delete('/api/access/shares/:id', ownerOnly, (req, res) => {
    const credentials = access.revokeBrowserShare(req.params.id, req.identity.ownerId)
    if (!credentials) return res.status(404).json({ error: '分享已过期或不存在' })
    for (const credential of credentials) getGateway()?.disconnectCredential(credential)
    res.status(204).end()
  })
}
