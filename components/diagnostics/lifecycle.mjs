import { createHash } from 'node:crypto'
export function diagnosticsEnvironment() {
  return { QWEN_AUDIO_DIAGNOSTICS_PROVIDER: 'off', OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: '', OTEL_EXPORTER_OTLP_TRACES_HEADERS: '' }
}
export function diagnosticsConfigurationFingerprint() {
  return createHash('sha256').update(JSON.stringify(['off', '', ''])).digest('hex')
}
export function diagnosticsPublicStatus() {
  return { enabled: false, label: 'Local logs', url: null, projectId: null,
    coverage: { backgroundMemory: false, realtime: false, conversationSearch: false } }
}
