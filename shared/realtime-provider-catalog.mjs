import { createHash } from 'node:crypto'
import {
  DEFAULT_DASHSCOPE_REALTIME_MODEL,
  BUILTIN_REALTIME_MODEL_CATALOGS,
  resolveDashScopeRealtimeModelProfile,
  realtimeModelCatalog,
  resolveRealtimeModelProfile,
} from './realtime-model-catalog.mjs'

export {
  DASHSCOPE_AUDIO_30_REALTIME_MODEL,
  DASHSCOPE_AUDIO_31_REALTIME_MODEL,
  DASHSCOPE_AUDIO_31_FLASH_REALTIME_MODEL,
  DASHSCOPE_AUDIO_FLASH_REALTIME_MODEL,
  DASHSCOPE_OMNI_38_FLASH_REALTIME_MODEL,
  DASHSCOPE_OMNI_FLASH_REALTIME_MODEL,
  DASHSCOPE_OMNI_PLUS_REALTIME_MODEL,
  DASHSCOPE_REALTIME_MODEL_PROFILES,
  DEFAULT_DASHSCOPE_REALTIME_MODEL,
  DEFAULT_DASHSCOPE_REALTIME_VOICE,
  DEFAULT_GPT_LIVE_REALTIME_MODEL,
  DEFAULT_GOOGLE_LIVE_REALTIME_MODEL,
  DEFAULT_DOUBAO_SEEDUPLEX_REALTIME_MODEL,
  DEFAULT_DOUBAO_SEEDUPLEX_REALTIME_VOICE,
  DEFAULT_STEPFUN_REALTIME_MODEL,
  realtimeModelCatalog,
  resolveRealtimeModelProfile,
  listDashScopeRealtimeModelProfiles,
  resolveDashScopeRealtimeModelProfile,
} from './realtime-model-catalog.mjs'

import {
  DEFAULT_REALTIME_PROVIDER,
  REALTIME_PROVIDERS,
  REALTIME_SETTING_SLOTS,
  realtimeRuntimeEnvironment,
  realtimeSettingsConnection,
  realtimeSettingsFromEnvironment,
} from './realtime-provider-definitions.mjs'
export {
  DEFAULT_REALTIME_PROVIDER,
  DEFAULT_DASHSCOPE_REALTIME_URL,
  DEFAULT_GPT_LIVE_REALTIME_URL,
  DEFAULT_GOOGLE_LIVE_REALTIME_URL,
  DEFAULT_DOUBAO_SEEDUPLEX_REALTIME_URL,
  DEFAULT_STEPFUN_REALTIME_URL,
  DEFAULT_SPEECH_TO_SPEECH_REALTIME_URL,
  DEFAULT_MINICPM_O_REALTIME_URL,
} from './realtime-provider-definitions.mjs'

const PROVIDERS = Object.fromEntries(REALTIME_PROVIDERS.map(provider => [provider.key, provider]))

const PROVIDER_ALIASES = new Map()
for (const provider of Object.values(PROVIDERS)) {
  PROVIDER_ALIASES.set(provider.key, provider.key)
  for (const alias of provider.aliases) {
    PROVIDER_ALIASES.set(alias, provider.key)
  }
}

function clean(value) {
  return String(value || '').trim()
}

function withoutTrailing(value, pattern) {
  return clean(value).replace(pattern, '')
}

export function resolveDashScopeRealtimeVoiceOverride(
  model = DEFAULT_DASHSCOPE_REALTIME_MODEL,
  env = process.env,
) {
  const family = resolveDashScopeRealtimeModelProfile(model).family
  if (family !== 'audio' && family !== 'omni') return ''
  const settings = realtimeSettingsFromEnvironment({
    ...env,
    QWEN_AUDIO_REALTIME_PROVIDER: 'dashscope',
    QWEN_AUDIO_REALTIME_MODEL: model,
  })
  return settings.realtimeVoice
}

export function realtimeProviderNames() {
  return Object.keys(PROVIDERS)
}

export function normalizeRealtimeProvider(value, {
  fallback = DEFAULT_REALTIME_PROVIDER,
} = {}) {
  const requested = clean(value || fallback).toLowerCase()
  const provider = PROVIDER_ALIASES.get(requested)
  if (!provider) {
    throw new Error(
      `不支持的 Realtime 前台：${requested || value}`
      + `（可选 ${realtimeProviderNames().join('、')}）`,
    )
  }
  return provider
}

export function realtimeProviderDefinition(value) {
  const key = normalizeRealtimeProvider(value)
  return PROVIDERS[key]
}

export function assertRealtimeFrontendModel(active) {
  const catalog = realtimeModelCatalog(active.provider)
  const profile = active.modelProfile || resolveRealtimeModelProfile(active.model, active.provider)
  if (catalog && (profile.id !== active.model || profile.family === 'unknown')) {
    throw new Error(`${catalog.environment}=${active.model} 不属于 ${active.provider} 支持的模型；请选择列表中的模型，或升级框架以获取新模型支持`)
  }
}

function resolveRealtimeConnection(env, modelCatalogs) {
  const provider = normalizeRealtimeProvider(env.QWEN_AUDIO_REALTIME_PROVIDER)
  const settings = realtimeSettingsFromEnvironment({
    ...env,
    QWEN_AUDIO_REALTIME_PROVIDER: provider,
  })
  const connection = realtimeSettingsConnection(settings)
  const runtime = realtimeRuntimeEnvironment(settings)
  const endpoint = withoutTrailing(connection.endpoint, /[/?]+$/)
  const model = connection.model
  const voice = connection.voice
  const credential = connection.credential
  const required = PROVIDERS[provider].requiredConfiguration
  const configured = Boolean(runtime[required.key])
  const environmentAliases = PROVIDERS[provider].settings
    .find(field => field.key === required.field).environment
    .filter(key => key !== required.key)
  const modelProfile = model ? resolveRealtimeModelProfile(model, provider, modelCatalogs) : null
  const identity = { provider, endpoint, model, voice, credential, modelProfile }
  const signature = createHash('sha256')
    .update(JSON.stringify(identity))
    .digest('hex')
  const active = Object.freeze({
    provider,
    label: PROVIDERS[provider].label,
    configured,
    endpoint,
    model: model || null,
    modelProfile,
    voice,
    credentialConfigured: Boolean(credential),
    requiredConfiguration: PROVIDERS[provider].requiredConfiguration,
    signature,
  })

  return {
    active,
    credential,
    modelCatalogs,
    missingConfigurationMessage: `缺少 ${PROVIDERS[provider].requiredConfiguration.key}`
      + (environmentAliases.length ? `（也支持 ${environmentAliases.join('、')}）` : '')
      + '。请运行 qwenaudio config 查看配置文件位置。',
  }
}

const REALTIME_ENV_PREFIX = 'QWEN_AUDIO_REALTIME_'

export function configuredRealtimeProviderProfiles(env) {
  return new Set(clean(env.QWEN_AUDIO_REALTIME_PROFILES).split(',')
    .map(name => name.trim()).filter(Boolean).map(name => normalizeRealtimeProvider(name)))
}

export function realtimeProviderProfilePrefix(provider) {
  return `${REALTIME_ENV_PREFIX}PROFILE_${provider.replaceAll('-', '_').toUpperCase()}_`
}

export function resolveRealtimeFrontendConfiguration(env = process.env, {
  modelCatalogs = BUILTIN_REALTIME_MODEL_CATALOGS,
} = {}) {
  const activeProvider = normalizeRealtimeProvider(env.QWEN_AUDIO_REALTIME_PROVIDER)
  const byProvider = new Map()
  for (const provider of configuredRealtimeProviderProfiles(env)) {
    const prefix = realtimeProviderProfilePrefix(provider)
    const isolated = { QWEN_AUDIO_REALTIME_PROVIDER: provider }
    for (const field of REALTIME_SETTING_SLOTS) {
      const key = field.environment[0]
      isolated[key] = env[prefix + key.slice(REALTIME_ENV_PREFIX.length)] ?? ''
    }
    const connection = resolveRealtimeConnection(isolated, modelCatalogs)
    assertRealtimeFrontendModel(connection.active)
    byProvider.set(provider, {
      ...connection,
      missingConfigurationMessage: `缺少 ${prefix}${PROVIDERS[provider].requiredConfiguration.key.slice(REALTIME_ENV_PREFIX.length)}。`,
    })
  }
  const selected = byProvider.get(activeProvider) || resolveRealtimeConnection(env, modelCatalogs)
  const profiles = Object.fromEntries(Array.from(byProvider, ([provider, connection]) => [
    provider, Object.freeze({ ...connection.active, credential: connection.credential }),
  ]))
  return { ...selected, profiles: Object.freeze(profiles) }
}
