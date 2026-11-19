import { graphitiTransport, remoteGraphitiToken } from './transport.mjs'
import { diagnosticCarrier } from '../diagnostics/node.mjs'
import { diagnosticsEnvironment, diagnosticsConfigurationFingerprint } from '../diagnostics/lifecycle.mjs'
import { execFile, spawn } from 'node:child_process'
import { randomBytes, createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync, openSync, closeSync, rmSync, realpathSync } from 'node:fs'
import { delimiter, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseEnv, promisify } from 'node:util'

const run = promisify(execFile)
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const component = resolve(root, 'components/graphiti')
const state = resolve(root, 'runtime/components/graphiti')
const python = resolve(state, 'mcp-venv/bin/python')
const pidFile = resolve(state, 'service.pid')
const origin = () => graphitiTransport().url
const integrationFingerprint = () => createHash('sha256').update(Buffer.concat(
  ['memory_provider.py', 'text_models.py', 'memory_tiers.py', 'official_mcp.py', 'qwen_schema_adapter.py', 'memory_policy.py', 'mcp-config.yaml', 'requirements.lock','mcp_launcher.py','../diagnostics/qwaudio_diagnostics/__init__.py']
    .map(name => readFileSync(resolve(component, name))))).digest('hex')
const wait = ms => new Promise(done => setTimeout(done, ms))
const serviceArguments = () => ['-m', 'uvicorn', 'service:app', '--host', '127.0.0.1', '--port',
  String(process.env.QWEN_AUDIO_GRAPHITI_PORT || 8310)]

function localSecrets() {
  mkdirSync(state, { recursive: true, mode: 0o700 })
  const file = resolve(state, 'service.env')
  if (!existsSync(file)) writeFileSync(file, [
    `GRAPHITI_NEO4J_PASSWORD=${randomBytes(24).toString('hex')}`,
    `GRAPHITI_COMPONENT_TOKEN=${randomBytes(32).toString('hex')}`, '',
  ].join('\n'), { mode: 0o600, flag: 'wx' })
  return parseEnv(readFileSync(file, 'utf8'))
}

export function graphitiDatabaseConfiguration(env = process.env, { requirePassword = true } = {}) {
  const externalUri = String(env.QWEN_AUDIO_GRAPHITI_NEO4J_URI || '').trim()
  const password = env.QWEN_AUDIO_GRAPHITI_NEO4J_PASSWORD
  const management = externalUri ? 'external' : 'compose'
  let uri = `bolt://127.0.0.1:${env.GRAPHITI_NEO4J_BOLT_PORT || 7688}`
  if (externalUri) {
    const tunnel = /^bolt:\/\/(127\.0\.0\.1|\[::1\]|localhost):([1-9][0-9]{0,4})\/?$/.exec(externalUri)
    if (!tunnel || Number(tunnel[2]) > 65535) throw new Error('GRAPHITI_NEO4J_INVALID_URI')
    if (requirePassword && !password?.trim()) throw new Error('GRAPHITI_NEO4J_PASSWORD_REQUIRED')
    uri = `bolt://${tunnel[1]}:${tunnel[2]}`
  } else if (password?.trim()) {
    throw new Error('GRAPHITI_NEO4J_URI_REQUIRED')
  }
  return { management, uri, target: createHash('sha256').update(uri).digest('hex'), password }
}

function graphitiOpenAIKey() {
  return (process.env.QWEN_AUDIO_GRAPHITI_OPENAI_API_KEY?.trim()
    || process.env.QWEN_AUDIO_REALTIME_PROFILE_GPT_LIVE_API_KEY?.trim()
    || process.env.OPENAI_API_KEY?.trim() || '')
}

function environment(database = graphitiDatabaseConfiguration()) {
  const baseUrl = process.env.QWEN_AUDIO_MEMORY_BASE_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1'
  const apiKey = process.env.QWEN_AUDIO_GRAPHITI_API_KEY || process.env.QWEN_AUDIO_MEMORY_API_KEY || process.env.DASHSCOPE_API_KEY || ''
  return {
    ...process.env, ...localSecrets(), ...diagnosticsEnvironment(),
    PYTHONPATH: [resolve(root, 'components/diagnostics'), process.env.PYTHONPATH].filter(Boolean).join(delimiter),
    GRAPHITI_QUEUE_PATH: resolve(state, 'queue.sqlite3'),
    GRAPHITI_NEO4J_URI: database.uri,
    GRAPHITI_NEO4J_MANAGEMENT: database.management,
    ...(database.management === 'external' ? { GRAPHITI_NEO4J_PASSWORD: database.password } : {}),
    GRAPHITI_LLM_API_KEY: apiKey,
    GRAPHITI_LLM_BASE_URL: process.env.QWEN_AUDIO_GRAPHITI_LLM_BASE_URL || baseUrl,
    GRAPHITI_LLM_MODEL: process.env.QWEN_AUDIO_GRAPHITI_LLM_MODEL || 'qwen3.7-plus',
    GRAPHITI_AGENT_MODEL: process.env.QWEN_AUDIO_GRAPHITI_AGENT_MODEL || '',
    GRAPHITI_OPENAI_API_KEY: graphitiOpenAIKey(),
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
    return { enabled: true, url: origin(), ...health, deployment: graphitiTransport().mode }
  } catch {
    return { enabled: true, status: 'unavailable', url: origin(), deployment: graphitiTransport().mode, code: graphitiTransport().mode === 'remote' ? 'GRAPHITI_REMOTE_UNAVAILABLE' : 'GRAPHITI_UNAVAILABLE', memoryIntegration: false }
  }
}

function localComponentReady(status, database) {
  return status.status === 'ready' && status.databaseManagement === database.management && status.databaseTarget === database.target
    && status.integrationVersion === 6 && status.integrationFingerprint === integrationFingerprint()
    && status.diagnostics?.configurationFingerprint === diagnosticsConfigurationFingerprint()
    && Boolean(status.model_families?.includes('openai')) === Boolean(graphitiOpenAIKey())
    && status.memoryIntegration === (process.env.QWEN_AUDIO_MEMORY_PROVIDER === 'graphiti')
}

export async function installGraphitiComponent() {
  if (graphitiTransport().mode === 'remote') throw new Error('GRAPHITI_REMOTE_MANAGED_EXTERNALLY')
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
  await run(python, ['-m', 'pip', 'install', '--no-deps', '-e', resolve(root, 'components/diagnostics')], { timeout: 120000 })
  return { installed: true, python }
}

export async function ensureGraphitiComponent({ logger } = {}) {
  if (process.env.QWEN_AUDIO_GRAPHITI_ENABLED !== 'on') return { enabled: false }
  const remote = graphitiTransport().mode === 'remote'
  // Validate the tunnel and its credential before stopping an existing worker.
  const database = remote ? null : graphitiDatabaseConfiguration()
  const current = await graphitiComponentStatus()
  if (remote) {
    if (current.status === 'ready' && (current.integrationVersion !== 6 || !current.memoryIntegration)) throw new Error('GRAPHITI_REMOTE_INCOMPATIBLE')
    logger?.[current.status === 'ready' ? 'info' : 'warn']('component.graphiti_remote', {status:current.status, code:current.code})
    return current
  }

  if (localComponentReady(current, database)) return current
  if (current.status === 'ready' && !await stopGraphitiService()) {
    throw new Error('GRAPHITI_LOCAL_COMPONENT_NOT_MANAGED')
  }
  if (!existsSync(python)) throw new Error('Graphiti 未安装：请先运行 npm run graphiti:install')
  const upstream = resolve(state, 'upstream')
  const head = await run('git', ['rev-parse', 'HEAD'], { cwd: upstream, timeout: 10000 })
  if (head.stdout.trim() !== 'ebef986a0b2360211b65751c111cacb4a7d790eb') throw new Error('Graphiti 官方 MCP 版本不匹配')
  await run('git', ['diff', '--quiet'], { cwd: upstream, timeout: 10000 })
  const env = environment(database)
  logger?.info('component.graphiti_starting', { url: origin(), databaseManagement: database.management })
  if (database.management === 'compose') {
    await run('docker', ['compose', '-f', resolve(component, 'compose.yaml'), 'up', '-d', '--wait', '--wait-timeout', '120'], {
      cwd: root, env, timeout: 150000, maxBuffer: 2 * 1024 * 1024,
    })
  }
  const output = openSync(resolve(state, 'service.log'), 'a', 0o600)
  const child = spawn(python, serviceArguments(), {
    cwd: component, env, detached: true, stdio: ['ignore', output, output],
  })
  closeSync(output)
  child.unref()
  const startupError = new Promise((_, reject) => child.once('error', reject))
  const ready = async () => {
    for (let attempt = 0; attempt < 90; attempt++) {
      if (child.exitCode !== null || child.signalCode !== null) break
      const status = await graphitiComponentStatus()
      if (localComponentReady(status, database)) {
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

async function isGraphitiService(pid) {
  const args = serviceArguments()
  const executables = [python, resolve(state, 'venv/bin/python')]
  if (process.platform === 'darwin') {
    try {
      const { stdout } = await run('/bin/ps', ['-ww', '-p', String(pid), '-o', 'command='], { timeout: 2000 })
      if (!executables.some(executable => stdout.trim() === [executable, ...args].join(' '))) return false
      const { stdout: paths } = await run('/usr/sbin/lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], { timeout: 2000 })
      return paths.split('\n').includes('n' + realpathSync(component))
    } catch (error) {
      if (error.code === 1) return false
      throw error
    }
  }
  try {
    const command = readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0$/, '')
    const cwd = realpathSync(`/proc/${pid}/cwd`)
    return cwd === realpathSync(component)
      && executables.some(executable => command === [executable, ...args].join('\0'))
  } catch (error) {
    if (['ENOENT', 'ESRCH'].includes(error.code)) return false
    throw error
  }
}

async function stopGraphitiService() {
  // Verify the recorded PID, working directory and command before signaling.
  if (!existsSync(pidFile)) return false
  const pid = Number(readFileSync(pidFile, 'utf8').trim())
  const stopped = Number.isInteger(pid) && pid > 1 && await isGraphitiService(pid)
  if (stopped) {
    try {
      process.kill(pid, 'SIGTERM')
      for (let attempt = 0; attempt < 100; attempt++) {
        process.kill(pid, 0)
        if (attempt === 99) throw new Error('Graphiti 进程尚未退出')
        await wait(100)
      }
    } catch (error) { if (error.code !== 'ESRCH') throw error }
  }
  rmSync(pidFile, { force: true })
  return stopped
}

export async function stopGraphitiComponent() {
  if (graphitiTransport().mode === 'remote') return { stopped: false, managedExternally: true }
  const database = graphitiDatabaseConfiguration(process.env, { requirePassword: false })
  const stopped = await stopGraphitiService()
  if (database.management === 'external') return { stopped, dataPreserved: true }
  await run('docker', ['compose', '-f', resolve(component, 'compose.yaml'), 'stop'], { env: environment(database), timeout: 60000 })
  return { stopped: true, dataPreserved: true }
}

// Only this server-side transport reads the private component token.
export async function graphitiComponentRequest(path, payload) {
  const transport = graphitiTransport()
  let response
  try {
    response = await fetch(`${transport.url}${path}`, {
      method: 'POST', headers: { ...diagnosticCarrier(), 'content-type': 'application/json',
        authorization: `Bearer ${transport.mode === 'remote' ? remoteGraphitiToken(transport) : localSecrets().GRAPHITI_COMPONENT_TOKEN}` },
      body: JSON.stringify(payload), signal: AbortSignal.timeout(11000),
    })
  } catch (error) {
    const code = error.name === 'TimeoutError' ? 'GRAPHITI_RECALL_TIMEOUT'
      : error.message === 'GRAPHITI_TOKEN_UNAVAILABLE' ? error.message
      : transport.mode === 'remote' ? 'GRAPHITI_REMOTE_UNAVAILABLE' : 'GRAPHITI_UNAVAILABLE'
    throw Object.assign(new Error(code), { code })
  }
  let value
  try { value = await response.json() } catch {
    throw Object.assign(new Error('GRAPHITI_INVALID_RESPONSE'), {code:'GRAPHITI_INVALID_RESPONSE'})
  }
  if (!response.ok) {
    const code = response.status === 401 || response.status === 403 ? 'GRAPHITI_AUTH_FAILED' : value.code || 'GRAPHITI_UNAVAILABLE'
    throw Object.assign(new Error(code), { code })
  }
  return value
}
