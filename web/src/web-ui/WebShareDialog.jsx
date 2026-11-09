import { useEffect, useRef, useState } from 'react'
import { t } from '../i18n.js'

async function shareRequest(path = '', method = 'GET') {
  const response = await fetch(`/api/access/shares${path}`, { method })
  if (response.status === 204) return null
  const result = await response.json()
  if (!response.ok) throw new Error(result.error || t('分享失败，请重试'))
  return result
}

export default function WebShareDialog({ onClose }) {
  const dialog = useRef(null)
  const linkInput = useRef(null)
  const [invitation, setInvitation] = useState(null)
  const [shares, setShares] = useState([])
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)
  const [direct, setDirect] = useState(false)
  const [now, setNow] = useState(Date.now)

  useEffect(() => {
    const element = dialog.current
    element.showModal()
    let active = true
    // Defer the initial mutation so React StrictMode's probe cannot mint two invitations.
    const start = setTimeout(async () => {
      try {
        const result = await shareRequest('', 'POST')
        if (active) setInvitation(result)
        const list = await shareRequest()
        if (active) setShares(list.shares)
      } catch (failure) {
        if (active) setError(failure.message)
      } finally {
        if (active) setBusy(false)
      }
    }, 0)
    const timer = setInterval(() => setNow(Date.now()), 1000)
    const poll = setInterval(async () => {
      try {
        const list = await shareRequest()
        if (active) setShares(list.shares)
      } catch { /* Keep the last known list; explicit actions report failures. */ }
    }, 5000)
    return () => {
      active = false
      clearTimeout(start)
      clearInterval(timer)
      clearInterval(poll)
      element.close()
    }
  }, [])

  const current = shares.find(share => share.id === invitation?.id)
  const used = current?.state === 'connected'
  const remaining = Math.max(0, Math.min(300, Math.ceil(((invitation?.expiresAt || 0) - now) / 1000)))
  const available = invitation && remaining > 0 && !used && current
  const url = invitation ? (direct ? invitation.secureUrl : invitation.url) : ''

  const regenerate = async () => {
    setBusy(true)
    setError('')
    setCopied(false)
    try {
      if (current?.state === 'pending') await shareRequest(`/${current.id}`, 'DELETE')
      setInvitation(null)
      setInvitation(await shareRequest('', 'POST'))
      setShares((await shareRequest()).shares)
    } catch (failure) { setError(failure.message) }
    finally { setBusy(false) }
  }
  const revoke = async id => {
    setError('')
    try {
      await shareRequest(`/${id}`, 'DELETE')
      setShares(previous => previous.filter(share => share.id !== id))
      if (id === invitation?.id) setInvitation(null)
    } catch (failure) { setError(failure.message) }
  }
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
    } catch {
      linkInput.current?.focus()
      linkInput.current?.select()
      setCopied(document.execCommand('copy'))
    }
  }

  return <dialog ref={dialog} className="web-ui-settings web-share-dialog"
    aria-labelledby="web-share-title" onCancel={onClose}
    onClick={event => { if (event.target === event.currentTarget) onClose() }}>
    <header><h2 id="web-share-title">{t('分享对话')}</h2>
      <button type="button" onClick={onClose} aria-label={t('关闭分享')}>×</button></header>
    <p className="web-settings-hint">{t('对方与电脑连接同一局域网，扫码即可打开。电脑需保持运行。')}</p>
    {error && <p role="alert" className="web-share-error">{error}</p>}
    {busy ? <p role="status">{t('正在生成二维码…')}</p> : available ? <>
      {invitation.certificateSetup && <label className="web-share-direct">
        <input type="checkbox" checked={direct} onChange={event => { setDirect(event.target.checked); setCopied(false) }} />
        {t('对方已安装证书，直接进入 HTTPS 对话')}
      </label>}
      <img className="web-share-qr" src={direct ? invitation.secureQrCode : invitation.qrCode}
        alt={t('对话分享二维码')} width="280" height="280" />
      <p className="web-share-expiry" role="status">{t('一次性链接，剩余 {time}', {
        time: `${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, '0')}`,
      })}</p>
      <label className="web-settings-field">{t('分享链接')}
        <input ref={linkInput} className="web-share-link" readOnly value={url} onFocus={event => event.target.select()} />
      </label>
      <div className="web-settings-links">
        <button type="button" onClick={copy}>{copied ? t('已复制') : t('复制链接')}</button>
        <a className="web-share-download" download="qwen-share.png"
          href={direct ? invitation.secureQrCode : invitation.qrCode}>{t('保存二维码')}</a>
      </div>
    </> : !error && <p role="status">{used ? t('链接已使用，对方已获得独立授权。') : t('链接已失效，请生成新二维码。')}</p>}
    <p className="web-settings-hint">{t('首次使用需按指引安装此电脑的局域网证书。HTTP 安装指引仅在可信局域网使用，语音对话通过 HTTPS 传输。')}</p>
    <p className="web-settings-hint">{t('链接 5 分钟有效且仅可使用一次。对方使用独立会话，模型费用由此电脑的账号承担；配对后的授权持续有效，可在下方撤销。')}</p>
    <button className="web-settings-primary" type="button" disabled={busy} onClick={regenerate}>{t('生成新二维码')}</button>
    {shares.length > 0 && <section><h3>{t('分享授权')}</h3>
      <ul className="web-share-list">{shares.map((share, index) => <li key={share.id}>
        <span>{t('分享 {number}', { number: index + 1 })}<small>{share.state === 'connected' ? t('已配对') : t('待扫码')}</small></span>
        <button type="button" onClick={() => revoke(share.id)}>{t('撤销')}</button>
      </li>)}</ul>
    </section>}
  </dialog>
}
