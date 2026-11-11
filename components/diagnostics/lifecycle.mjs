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
