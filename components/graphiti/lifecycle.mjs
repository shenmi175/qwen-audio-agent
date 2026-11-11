import { execFile, spawn } from 'node:child_process'
import { randomBytes, createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync, openSync, closeSync, rmSync, realpathSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseEnv, promisify } from 'node:util'

const run = promisify(execFile)
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const component = resolve(root, 'components/graphiti')
const state = resolve(root, 'runtime/components/graphiti')
const python = resolve(state, 'mcp-venv/bin/python')
const pidFile = resolve(state, 'service.pid')
const origin = () => `http://127.0.0.1:${Number(process.env.QWEN_AUDIO_GRAPHITI_PORT || 8310)}`
const integrationFingerprint = () => createHash('sha256').update(Buffer.concat(
  ['memory_provider.py', 'official_mcp.py', 'qwen_schema_adapter.py', 'memory_policy.py', 'mcp-config.yaml', 'requirements.lock']
    .map(name => readFileSync(resolve(component, name))))).digest('hex')
const wait = ms => new Promise(done => setTimeout(done, ms))

function localSecrets() {
  mkdirSync(state, { recursive: true, mode: 0o700 })
  const file = resolve(state, 'service.env')
  if (!existsSync(file)) writeFileSync(file, [
    `GRAPHITI_NEO4J_PASSWORD=${randomBytes(24).toString('hex')}`,
    `GRAPHITI_COMPONENT_TOKEN=${randomBytes(32).toString('hex')}`, '',
  ].join('\n'), { mode: 0o600, flag: 'wx' })
  return parseEnv(readFileSync(file, 'utf8'))
}

function environment() {
  const baseUrl = process.env.QWEN_AUDIO_MEMORY_BASE_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1'
  const apiKey = process.env.QWEN_AUDIO_GRAPHITI_API_KEY || process.env.QWEN_AUDIO_MEMORY_API_KEY || process.env.DASHSCOPE_API_KEY || ''
  return {
    ...process.env, ...localSecrets(),
    GRAPHITI_QUEUE_PATH: resolve(state, 'queue.sqlite3'),
    GRAPHITI_NEO4J_URI: `bolt://127.0.0.1:${process.env.GRAPHITI_NEO4J_BOLT_PORT || 7688}`,
    GRAPHITI_LLM_API_KEY: apiKey,
    GRAPHITI_LLM_BASE_URL: process.env.QWEN_AUDIO_GRAPHITI_LLM_BASE_URL || baseUrl,
    GRAPHITI_LLM_MODEL: process.env.QWEN_AUDIO_GRAPHITI_LLM_MODEL || 'qwen3.7-plus',
    GRAPHITI_AGENT_MODEL: process.env.QWEN_AUDIO_GRAPHITI_AGENT_MODEL || process.env.QWEN_AUDIO_GRAPHITI_LLM_MODEL || 'qwen3.7-plus',
    GRAPHITI_EMBEDDING_API_KEY: process.env.QWEN_AUDIO_GRAPHITI_EMBEDDING_API_KEY || apiKey,
    GRAPHITI_EMBEDDING_BASE_URL: process.env.QWEN_AUDIO_GRAPHITI_EMBEDDING_BASE_URL || baseUrl,
    GRAPHITI_EMBEDDING_MODEL: process.env.QWEN_AUDIO_GRAPHITI_EMBEDDING_MODEL || 'text-embedding-v4',
    GRAPHITI_EMBEDDING_DIM: process.env.QWEN_AUDIO_GRAPHITI_EMBEDDING_DIM || '1024',
    GRAPHITI_TELEMETRY_ENABLED: 'false',
    SEMAPHORE_LIMIT: '2',
  }
}

export async function graphitiComponentStatus() {
  if (process.env.QWEN_AUDIO_GRAPHITI_ENABLED !== 'on') return { enabled: false, memoryIntegration: false }
  try {
    const response = await fetch(`${origin()}/readyz`, { signal: AbortSignal.timeout(3000) })
    const health = await response.json()
    if (!response.ok || health.component !== 'qwaudio-graphiti') throw new Error('Component is not ready')
    return { enabled: true, url: origin(), ...health }
  } catch {
    return { enabled: true, status: 'unavailable', url: origin(), memoryIntegration: false }
  }
}

export async function installGraphitiComponent() {
  localSecrets()
  const upstream = resolve(state, 'upstream')
  const commit = 'ebef986a0b2360211b65751c111cacb4a7d790eb'
  if (!existsSync(resolve(upstream, '.git'))) await run('git', ['clone', 'https://github.com/getzep/graphiti.git', upstream], { timeout: 600000 })
  await run('git', ['checkout', '--detach', commit], { cwd: upstream, timeout: 60000 })
  await run('python3', ['-m', 'venv', resolve(state, 'mcp-venv')], { timeout: 60000 })
  await run(python, ['-m', 'pip', 'install', '-r', resolve(component, 'requirements.lock')], {
    timeout: 600000, maxBuffer: 8 * 1024 * 1024,
  })
  await run(python, ['-m', 'pip', 'install', '--no-deps', '-e', resolve(upstream, 'mcp_server')], { timeout: 120000 })
  return { installed: true, python }
}

export async function ensureGraphitiComponent({ logger } = {}) {
  if (process.env.QWEN_AUDIO_GRAPHITI_ENABLED !== 'on') return { enabled: false }
  const current = await graphitiComponentStatus()
  if (current.status === 'ready' && current.integrationVersion === 6 && current.integrationFingerprint === integrationFingerprint()
    && current.memoryIntegration === (process.env.QWEN_AUDIO_MEMORY_PROVIDER === 'graphiti')) return current
  if (current.status === 'ready') await stopGraphitiService()
  if (!existsSync(python)) throw new Error('Graphiti 未安装：请先运行 npm run graphiti:install')
  const upstream = resolve(state, 'upstream')
  const head = await run('git', ['rev-parse', 'HEAD'], { cwd: upstream, timeout: 10000 })
  if (head.stdout.trim() !== 'ebef986a0b2360211b65751c111cacb4a7d790eb') throw new Error('Graphiti 官方 MCP 版本不匹配')
  await run('git', ['diff', '--quiet'], { cwd: upstream, timeout: 10000 })
  const env = environment()
  logger?.info('component.graphiti_starting', { url: origin() })
  await run('docker', ['compose', '-f', resolve(component, 'compose.yaml'), 'up', '-d', '--wait', '--wait-timeout', '120'], {
    cwd: root, env, timeout: 150000, maxBuffer: 2 * 1024 * 1024,
  })
  const output = openSync(resolve(state, 'service.log'), 'a', 0o600)
  const child = spawn(python, ['-m', 'uvicorn', 'service:app', '--host', '127.0.0.1', '--port', String(process.env.QWEN_AUDIO_GRAPHITI_PORT || 8310)], {
    cwd: component, env, detached: true, stdio: ['ignore', output, output],
  })
  closeSync(output)
  child.unref()
  const startupError = new Promise((_, reject) => child.once('error', reject))
  const ready = async () => {
    for (let attempt = 0; attempt < 90; attempt++) {
      if (child.exitCode !== null || child.signalCode !== null) break
      const status = await graphitiComponentStatus()
      if (status.status === 'ready' && status.integrationVersion === 6 && status.integrationFingerprint === integrationFingerprint()) {
        writeFileSync(pidFile, `${child.pid}\n`, { mode: 0o600 })
        logger?.info('component.graphiti_ready', { url: origin(), memoryIntegration: status.memoryIntegration, transport: status.transport })
        return status
      }
      await wait(500)
    }
    child.kill('SIGTERM')
    throw new Error(`Graphiti 启动失败，请查看 ${resolve(state, 'service.log')}`)
  }
  return Promise.race([startupError, ready()])
}

async function stopGraphitiService() {
  // Verify the recorded PID and command before signaling any local process.
  if (existsSync(pidFile)) {
    const pid = Number(readFileSync(pidFile, 'utf8').trim())
    if (Number.isInteger(pid) && pid > 1) {
      try {
        const command = readFileSync(`/proc/${pid}/cmdline`, 'utf8')
        const cwd = realpathSync(`/proc/${pid}/cwd`)
        if ((command.includes(python) || command.includes(resolve(state, 'venv/bin/python'))) && command.includes('service:app') && cwd === component) {
          process.kill(pid, 'SIGTERM')
          for (let attempt = 0; attempt < 100; attempt++) {
            try { process.kill(pid, 0) } catch (error) { if (error.code === 'ESRCH') break; throw error }
            if (attempt === 99) throw new Error('Graphiti 进程尚未退出')
            await wait(100)
          }
        }
      } catch (error) { if (!['ENOENT', 'ESRCH'].includes(error.code)) throw error }
    }
    rmSync(pidFile, { force: true })
  }
}

export async function stopGraphitiComponent() {
  await stopGraphitiService()
  await run('docker', ['compose', '-f', resolve(component, 'compose.yaml'), 'stop'], { env: environment(), timeout: 60000 })
  return { stopped: true, dataPreserved: true }
}

// Only this server-side transport reads the private component token.
export async function graphitiComponentRequest(path, payload) {
  const response = await fetch(`${origin()}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json',
      authorization: `Bearer ${localSecrets().GRAPHITI_COMPONENT_TOKEN}` },
    body: JSON.stringify(payload), signal: AbortSignal.timeout(11000),
  })
  const value = await response.json()
  if (!response.ok) throw Object.assign(new Error(value.code || 'GRAPHITI_UNAVAILABLE'),
    { code: value.code || 'GRAPHITI_UNAVAILABLE' })
  return value
}
