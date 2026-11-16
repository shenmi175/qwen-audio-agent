import { existsSync, readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseEnv } from 'node:util'
const state = resolve(dirname(fileURLToPath(import.meta.url)), '../../runtime/components/graphiti')
export function graphitiTransport(env = process.env) {
  const file = env.QWEN_AUDIO_GRAPHITI_REMOTE_CONFIG || resolve(state, 'remote.env')
  const saved = existsSync(file) ? parseEnv(readFileSync(file, 'utf8')) : {}
  const value = { ...saved, ...env }
  const mode = value.QWEN_AUDIO_GRAPHITI_MODE || 'local'
  if (!['local', 'remote'].includes(mode)) throw new Error('GRAPHITI_INVALID_MODE')
  const url = mode === 'local' ? 'http://127.0.0.1:' + Number(value.QWEN_AUDIO_GRAPHITI_PORT || 8310)
    : value.QWEN_AUDIO_GRAPHITI_URL
  let parsed
  try { parsed = new URL(url) } catch { throw new Error('GRAPHITI_INVALID_URL') }
  if (parsed.username || parsed.password || parsed.search || parsed.hash ||
      (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(parsed.hostname)))) {
    throw new Error('GRAPHITI_INVALID_URL')
  }
  return { mode, url: parsed.href.replace(/\/$/, ''),
    tokenFile: value.QWEN_AUDIO_GRAPHITI_TOKEN_FILE || resolve(state, 'remote.token') }
}
export function remoteGraphitiToken(transport) {
  let token
  try { token = readFileSync(transport.tokenFile, 'utf8').trim() } catch { throw new Error('GRAPHITI_TOKEN_UNAVAILABLE') }
  if (!token) throw new Error('GRAPHITI_TOKEN_UNAVAILABLE')
  return token
}
