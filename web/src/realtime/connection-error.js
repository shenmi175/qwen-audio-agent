// Keep the transport cause when the provider follows an error with a generic
// unavailable event. A successful connection clears it in useRealtimeVoice.
export function connectionErrorMessage(message, previous = '', fallback = '') {
  const text = String(message || '').trim()
  if (/ECONNRESET|socket disconnected before secure TLS connection was established/i.test(text)) {
    return '连接语音服务的网络中断，正在重试'
  }
  if (/ENOTFOUND|EAI_AGAIN/i.test(text)) {
    return '语音服务域名解析失败，正在重试'
  }
  return text || previous || fallback
}
