import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { recentConversationMessages } from '../../../shared/conversation-history.mjs'
import { normalizeConversationLanguage, conversationLanguageInstructions } from '../../../shared/conversation-language.mjs'

const MAX_ASSISTANT_CHARS = 4000
const MAX_RECENT_CHARS = 3500
const defaultPromptDirectory = fileURLToPath(new URL('../../../runtime/prompts', import.meta.url))
let snapshot = null
let pending = null
let timer = null
const listeners = new Set()
let lastError = null
export function subscribeFrontendPrompts(fn) { listeners.add(fn); return () => listeners.delete(fn) }
export function frontendPromptStatus() {
  return { source: 'local', mode: 'local', label: 'local', versions: snapshot?.versions || null, lastError, refreshSeconds: 10 }
}
export async function initializeFrontendPrompt() {
  if (pending) return pending
  pending = (async () => {
    const directory = process.env.QWAUDIO_PROMPTS_DIR || defaultPromptDirectory
    const entries = await Promise.all(['assistant-behavior', 'assistant-persona', 'memory-voice'].map(async key => {
      let prompt
      try { prompt = await readFile(resolve(directory, 'frontend', key + '.md'), 'utf8') }
      catch (error) {
        if (key === 'memory-voice' && error.code === 'ENOENT') prompt = await readFile(new URL('../../../config/prompts/frontend/memory-voice.md', import.meta.url), 'utf8')
        else throw new Error('LOCAL_PROMPT_UNAVAILABLE')
      }
      if (!prompt.trim()) throw new Error('LOCAL_PROMPT_INVALID')
      return [key, { prompt, version: createHash('sha256').update(prompt).digest('hex').slice(0, 12) }]
    }))
    const values = Object.fromEntries(entries)
    const versions = Object.fromEntries(entries.map(([key, value]) => [key, value.version]))
    const changed = JSON.stringify(snapshot?.versions) !== JSON.stringify(versions)
    // Apply the pair atomically. A temporarily missing/empty file keeps the last valid pair.
    snapshot = { values, versions }
    lastError = null
    if (changed) for (const fn of listeners) { try { fn(frontendPromptStatus()) } catch {} }
    return frontendPromptStatus()
  })().catch(error => { lastError = error.message; throw error }).finally(() => { pending = null })
  return pending
}
export function startFrontendPromptRefresh(logger) {
  if (timer) return
  timer = setInterval(() => initializeFrontendPrompt().catch(() => logger?.warn('frontend.prompt_refresh_failed', { code: lastError })), 10000)
  timer.unref()
}

function clean(value) {
  return String(value || '').replace(/\s+/g, ' ').trim()
}

export function normalizeClientContext({
  timeZone,
  locale,
  conversationLanguage,
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
    conversationLanguage: normalizeConversationLanguage(conversationLanguage),
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
  if (!snapshot) throw new Error('LOCAL_PROMPT_UNAVAILABLE')
  return snapshot.values['assistant-behavior'].prompt
}
export function loadAssistantProfile() {
  if (!snapshot) throw new Error('LOCAL_PROMPT_UNAVAILABLE')
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
  return runtimeContext + '\n\n# 对话语言\n' + conversationLanguageInstructions(normalizedClient.conversationLanguage)
}

export function loadMemoryVoicePrompt() {
  return snapshot?.values['memory-voice']?.prompt || ''
}
