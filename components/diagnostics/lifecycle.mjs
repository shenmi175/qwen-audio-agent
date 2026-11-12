import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseEnv } from 'node:util'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
export function diagnosticsEnvironment() {
  const path = resolve(root, 'runtime/components/diagnostics/service.env')
  return existsSync(path) ? parseEnv(readFileSync(path, 'utf8')) : {}
}

export function diagnosticsConfigurationFingerprint() {
  const env = { ...process.env, ...diagnosticsEnvironment() }
  return createHash('sha256').update(JSON.stringify([
    env.QWEN_AUDIO_DIAGNOSTICS_PROVIDER || 'off',
    env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT || '',
    env.OTEL_EXPORTER_OTLP_TRACES_HEADERS || '',
  ])).digest('hex')
}

// Public metadata only. Exporter endpoints and authentication stay server-side.
export function diagnosticsPublicStatus(env = { ...process.env, ...diagnosticsEnvironment() }) {
  let url = null
  try {
    const parsed = new URL(env.QWEN_AUDIO_DIAGNOSTICS_UI_URL)
    if (['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password) {
      parsed.search = ''
      parsed.hash = ''
      url = parsed.href
    }
  } catch {}
  return {
    enabled: env.QWEN_AUDIO_DIAGNOSTICS_PROVIDER === 'otlp',
    label: String(env.QWEN_AUDIO_DIAGNOSTICS_LABEL || 'OTLP').slice(0, 80),
    url,
    projectId: env.QWEN_AUDIO_DIAGNOSTICS_PROJECT_ID || null,
    coverage: { backgroundMemory: true, realtime: false, conversationSearch: false },
  }
}
