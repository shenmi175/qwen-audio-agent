// Public onboarding shell. Invitation secrets stay in the fragment, never in HTTP logs.
export function joinPage(origin, fingerprint) {
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>加入 Qwen 对话</title><style>body{font:16px/1.7 system-ui,sans-serif;max-width:580px;margin:32px auto;padding:0 22px;color:#17202a}a{color:#145fc0;overflow-wrap:anywhere}li{margin:16px 0}.button{display:block;background:#145fc0;color:white;padding:12px;border-radius:10px;text-align:center;text-decoration:none}.button[aria-disabled=true]{pointer-events:none;opacity:.4}small{color:#576574}code{overflow-wrap:anywhere}</style><h1>加入 Qwen 语音对话</h1><p>请与电脑连接同一局域网。此邀请 5 分钟内有效，只能配对一次。</p><ol><li>首次使用：<a href="/root-ca.crt" download="qwen-lan-root-ca.crt">下载局域网证书</a>，在安卓设置搜索“安装证书”，选择 <strong>CA 证书</strong>后安装。已安装可跳过。</li><li>回到当前页面，点击下方按钮，确认 HTTPS 没有证书错误，再点击 <strong>Connect</strong> 完成配对。</li><li>点击“开始对话”或开启麦克风，并允许浏览器收音。</li></ol><a class="button" id="continue" aria-disabled="true">证书已安装，继续对话</a><p id="status" role="status"></p><p><small>仅在可信局域网安装此电脑的证书。此安装指引通过 HTTP 提供；语音对话通过 HTTPS 传输。可向电脑主人核对 CA SHA-256 指纹：</small><br><code>${fingerprint}</code></p><script>
const code = location.hash.slice(1)
const expiry = parseInt(new URLSearchParams(location.search).get('e') || '', 36)
const button = document.getElementById('continue')
const status = document.getElementById('status')
if (/^[A-Za-z0-9_-]{14}$/.test(code) && Number.isSafeInteger(expiry) && expiry > Date.now()) {
  const destination = new URL('/c', ${JSON.stringify(origin)})
  destination.searchParams.set('e', expiry.toString(36))
  destination.hash = code
  button.href = destination.toString()
  button.setAttribute('aria-disabled', 'false')
} else { status.textContent = '邀请链接无效或已过期，请向电脑主人索取新的二维码。' }
</script></html>`
}
