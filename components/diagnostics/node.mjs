// Lightweight compatibility interface; no exporters, queues or network clients.
const noop = Object.freeze({ end() {}, update() {}, run: fn => fn(), span: null })
export function sanitize(value, key = '') {
  if (
    /authorization|api.?key|password|secret|access.token|refresh.token/i.test(
      key,
    )
  )
    return '[REDACTED]'
  if (typeof value === 'string') {
    if (/^(audio|image)$/.test(key))
      return { omitted: 'media', encodedLength: value.length }
    if (
      /^(?:data:(?:image|audio|video)\/|[A-Za-z0-9+/]{200,}={0,2}$)/.test(
        value,
      ) &&
      /audio|image|data|delta/i.test(key)
    )
      return { omitted: 'media', encodedLength: value.length }
    let text = value.replace(
      /data:(?:image|audio|video)\/[^\s"']+/g,
      '[MEDIA OMITTED]',
    )
    for (const [name, secret] of Object.entries(process.env))
      if (/KEY|TOKEN|SECRET|PASSWORD|HEADERS/.test(name) && secret.length >= 12)
        text = text.replaceAll(secret, '[REDACTED]')
    return text.replace(
      /\b(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9_]{20,})/g,
      '[REDACTED]',
    )
  }
  if (Array.isArray(value)) return value.map((x) => sanitize(x, key))
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, sanitize(v, k)]),
    )
  return value
}

export function initializeDiagnostics() {}
export function recordToolOutput() {}
export function diagnosticsHealth() {
  return { enabled: false, lastSuccess: null, errorCode: null, dropped: 0, pending: 0 }
}
export async function flushDiagnostics() {}
export function diagnosticCarrier() { return {} }
export function observation() { return noop }
export class RealtimeDiagnostics {
  event() {}
  wire() {}
  close() {}
}
