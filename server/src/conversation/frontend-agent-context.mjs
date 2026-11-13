import { readFileSync, mkdirSync, writeFileSync, renameSync } from 'node:fs'
import { Buffer } from 'node:buffer'
import { resolve } from 'node:path'
import { config } from '../core/config.mjs'
import { recentConversationMessages } from '../../../shared/conversation-history.mjs'

const MAX_ASSISTANT_CHARS = 4000
const MAX_RECENT_CHARS = 3500
const modeFile = process.env.QWAUDIO_PROMPT_MODE_FILE || new URL('../../../runtime/components/langfuse/prompt-mode.json', import.meta.url)
let promptMode = 'production'
try {
  const saved = JSON.parse(readFileSync(modeFile, 'utf8')).mode
  if (['production','debug'].includes(saved)) promptMode = saved
} catch (error) { if (error.code !== 'ENOENT') throw error }
let modeChanges = Promise.resolve()
export function setFrontendPromptMode(mode) {
  if (!['production','debug'].includes(mode)) return Promise.reject(new Error('PROMPT_MODE_INVALID'))
  const update = modeChanges.catch(() => {}).then(async () => {
    if (pending) await pending.catch(() => {})
    return initializeFrontendPrompt(mode)
  })
  modeChanges = update
  return update
}
let snapshot = null
let pending = null
let timer = null
const listeners = new Set()
let lastError = null
export function subscribeFrontendPrompts(fn) { listeners.add(fn); return () => listeners.delete(fn) }
function langfuseEnv() {
  const path = new URL('../../../runtime/components/langfuse/service.env', import.meta.url)
  return Object.fromEntries(readFileSync(path, 'utf8').split(/\r?\n/).filter(line => line.includes('=')).map(line => {
    const index = line.indexOf('='); return [line.slice(0,index), line.slice(index+1)]
  }))
}
export function frontendPromptStatus() {
  return { source: 'langfuse', mode: promptMode, label: promptMode === 'debug' ? 'latest' : 'production', versions: snapshot?.versions || null, lastError, refreshSeconds: 10 }
}
export async function initializeFrontendPrompt(mode = promptMode) {
  if (pending) return pending
  pending = (async () => {
    const label = mode === 'debug' ? 'latest' : 'production'
    const env = langfuseEnv()
    const base = (process.env.LANGFUSE_BASE_URL || 'http://127.0.0.1:3300').replace(/\/$/, '')
    const auth = Buffer.from((process.env.LANGFUSE_PUBLIC_KEY || env.LANGFUSE_INIT_PROJECT_PUBLIC_KEY) + ':' + (process.env.LANGFUSE_SECRET_KEY || env.LANGFUSE_INIT_PROJECT_SECRET_KEY)).toString('base64')
    const entries = await Promise.all(['assistant-behavior','assistant-persona'].map(async key => {
      const res = await fetch(`${base}/api/public/v2/prompts/frontend%2F${key}?label=${label}`, {
        headers: {authorization: `Basic ${auth}`}, signal: AbortSignal.timeout(5000) })
      if (!res.ok) throw new Error(`LANGFUSE_PROMPT_${res.status}`)
      const data = await res.json()
      if (data.type !== 'text' || typeof data.prompt !== 'string' || !data.prompt.trim()) throw new Error('LANGFUSE_PROMPT_INVALID')
      return [key, data]
    }))
    const values = Object.fromEntries(entries)
    const versions = Object.fromEntries(entries.map(([key,value]) => [key,value.version]))
    const changed = mode !== promptMode || JSON.stringify(snapshot?.versions) !== JSON.stringify(versions)
    if (mode !== promptMode) {
      const target = typeof modeFile === 'string' ? modeFile : modeFile.pathname
      const directory = resolve(target, '..')
      mkdirSync(directory, {recursive:true, mode:0o700})
      writeFileSync(target + '.tmp', JSON.stringify({mode}) + '\n', {mode:0o600})
      renameSync(target + '.tmp', target)
      promptMode = mode
    }
    snapshot = {values,versions}
    lastError = null
    if (changed) for (const fn of listeners) { try { fn(frontendPromptStatus()) } catch {} }
    return frontendPromptStatus()
  })().catch(error => { lastError = error.message; throw error }).finally(() => { pending = null })
  return pending
}
export function startFrontendPromptRefresh(logger) {
  if (timer) return
  timer = setInterval(() => initializeFrontendPrompt().catch(() => logger?.warn('frontend.prompt_refresh_failed', {code:lastError})),10000)
  timer.unref()
}

function clean(value) {
  return String(value || '').replace(/\s+/g, ' ').trim()
}

export function normalizeClientContext({
  timeZone,
  locale,
  workingDirectory,
} = {}) {
  let safeTimeZone = clean(timeZone)
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: safeTimeZone }).format()
  } catch {
    safeTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  }
  let safeLocale = clean(locale).slice(0, 35) || 'zh-CN'
  try {
    new Intl.DateTimeFormat(safeLocale).format()
  } catch {
    safeLocale = 'zh-CN'
  }
  const safeWorkingDirectory = String(workingDirectory || '')
    .replaceAll('\0', '')
    .replace(/[\r\n]+/g, ' ')
    .trim()
    .slice(0, 1024)
  return {
    timeZone: safeTimeZone,
    locale: safeLocale,
    workingDirectory: safeWorkingDirectory || null,
  }
}

export function currentTimeSnapshot({
  timeZone,
  locale,
  now = new Date(),
} = {}) {
  const context = normalizeClientContext({ timeZone, locale })
  return {
    iso_utc: now.toISOString(),
    local_time: new Intl.DateTimeFormat(context.locale, {
      timeZone: context.timeZone,
      dateStyle: 'full',
      timeStyle: 'long',
      hour12: false,
    }).format(now),
    time_zone: context.timeZone,
    locale: context.locale,
  }
}

export function loadFrontendPrompt() {
  if (!snapshot) throw new Error('LANGFUSE_PROMPT_UNAVAILABLE')
  return snapshot.values['assistant-behavior'].prompt
}
export function loadAssistantProfile() {
  if (!snapshot) throw new Error('LANGFUSE_PROMPT_UNAVAILABLE')
  return snapshot.values['assistant-persona'].prompt
}

export function resolveAssistantProfile(agentContext = {}) {
  // A trusted host may select a complete profile for one live Session. Client
  // payloads never enter this field directly; the packaged/local file remains
  // the deployment-wide fallback.
  const sessionProfile = String(agentContext.assistantProfile || '').trim()
  if (!sessionProfile) return loadAssistantProfile()
  return [...sessionProfile].slice(0, MAX_ASSISTANT_CHARS).join('')
}

export function buildRecentConversationContext(messages = []) {
  const candidates = recentConversationMessages(messages)
  const selected = []
  let used = 0
  for (const message of candidates.toReversed()) {
    const content = clean(message.content)
    if (!content) continue
    const inputSummary = (message.inputs || []).map(input => [
      clean(input.ref),
      clean(input.label || input.filename || input.type),
      clean(input.filename),
      clean(input.mime),
    ].filter(Boolean).join(' · ')).filter(Boolean).join('；')
    const base = `${message.role === 'user' ? '用户' : '助手'}: ${content}`
    const line = inputSummary
      ? `${base}（可引用输入：${inputSummary}）`
      : base
    if (selected.length && used + line.length > MAX_RECENT_CHARS) break
    selected.unshift(line)
    used += line.length
  }
  if (!selected.length) return ''
  return [
    '<recent_conversation>',
    ...selected,
    '</recent_conversation>',
  ].join('\n')
}

export function buildFrontendContext({
  client = {},
} = {}) {
  const normalizedClient = normalizeClientContext(client)
  const runtimeContext = [
    '<runtime_context>',
    'channel=full_duplex_voice',
    `time_zone=${JSON.stringify(normalizedClient.timeZone)}`,
    `locale=${JSON.stringify(normalizedClient.locale)}`,
    ...(normalizedClient.workingDirectory
      ? [`client_working_directory=${JSON.stringify(normalizedClient.workingDirectory)}`]
      : []),
    '</runtime_context>',
  ].join('\n')
  return runtimeContext
}
