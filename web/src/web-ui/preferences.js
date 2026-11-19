import { normalizeOrbSkinId } from '../../../shared/orb-skin-catalog.mjs'
import { normalizeConversationLanguage } from '../../../shared/conversation-language.mjs'

export const WEB_UI_PREFERENCES_KEY = 'qwaudio.web-ui.preferences'

function realtimeModelId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(value) ? value : ''
}

function realtimeProviderKey(value) {
  return typeof value === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(value) ? value : ''
}

export function normalizeWebPreferences(value = {}) {
  const realtimeModels = Object.fromEntries(Object.entries(value.realtimeModels || {})
    .filter(([provider, model]) => realtimeProviderKey(provider) && (model === '' || realtimeModelId(model))))
  return {
    skin: normalizeOrbSkinId(value.skin) || 'cloud',
    size: Math.min(160, Math.max(88, Number(value.size) || 112)),
    surface: value.surface === 'orb' ? 'orb' : 'panel',
    motion: ['on', 'off'].includes(value.motion) ? value.motion : 'system',
    appearanceVersion: 2,
    realtimeModel: realtimeModelId(value.realtimeModel),
    realtimeProvider: realtimeProviderKey(value.realtimeProvider),
    realtimeModels,
    conversationLanguage: normalizeConversationLanguage(value.conversationLanguage),
  }
}

export function realtimeProviderSettings(health = {}) {
  const defaultProvider = realtimeProviderKey(health.realtimeProvider)
  const descriptors = Array.isArray(health.realtimeProviders) ? health.realtimeProviders : []
  const providers = new Map()
  for (const descriptor of descriptors) {
    const key = realtimeProviderKey(descriptor?.key)
    if (!key || descriptor.configured === false) continue
    const profiles = descriptor.realtimeModelCatalog || descriptor.modelCatalog
      || (key === defaultProvider ? health.realtimeModelCatalog : null)
    const ids = Array.isArray(descriptor.realtimeModelIds) ? descriptor.realtimeModelIds : []
    providers.set(key, {
      key,
      label: descriptor.label || key,
      model: realtimeModelId(descriptor.model ?? (key === defaultProvider ? health.realtimeModel : '')),
      catalog: (Array.isArray(profiles) ? profiles : ids.map(id => ({ id, label: id })))
        .filter(profile => realtimeModelId(profile?.id)),
    })
  }
  // Older gateways publish only the active provider's catalog.
  if (defaultProvider && !providers.has(defaultProvider) && health.voiceConfigured !== false) {
    providers.set(defaultProvider, {
      key: defaultProvider,
      label: health.realtimeLabel || defaultProvider,
      model: realtimeModelId(health.realtimeModel),
      catalog: Array.isArray(health.realtimeModelCatalog)
        ? health.realtimeModelCatalog.filter(profile => realtimeModelId(profile?.id)) : [],
    })
  }
  return { defaultProvider, providers: [...providers.values()] }
}

export function preferredRealtimeModel(preferences, provider) {
  if (!provider) return ''
  const models = preferences.realtimeModels || {}
  const choice = Object.hasOwn(models, provider.key) ? models[provider.key] : preferences.realtimeModel
  return provider.catalog.some(model => model.id === choice) ? choice : ''
}

export function realtimeConnectSelection(preferences, { defaultProvider, providers }) {
  const requested = preferences.realtimeProvider
  const profile = providers.find(provider => provider.key === (requested || defaultProvider))
  // An explicitly selected provider must not fall back to another account.
  return {
    provider: requested || '',
    model: preferredRealtimeModel(preferences, profile),
  }
}

export function loadWebPreferences(storage, search = '') {
  let saved = {}
  try { saved = JSON.parse(storage?.getItem(WEB_UI_PREFERENCES_KEY) || '{}') || {} } catch {}
  const params = new URLSearchParams(search)
  // Apply the requested new web appearance once. Subsequent explicit skin
  // choices, imported pets, and the desktop's own settings remain independent.
  if (saved.appearanceVersion !== 2 && ['fluid', 'goo'].includes(saved.skin)) saved.skin = 'cloud'
  return normalizeWebPreferences({ ...saved,
    ...(params.has('ui') ? { surface: params.get('ui') } : {}),
    ...(params.has('orbSkin') ? { skin: params.get('orbSkin') } : {}),
  })
}

export function clampOrbPosition(position, viewport, dimensions = { width: 248, height: 252 }) {
  const edge = 12
  return {
    x: Math.min(Math.max(edge, viewport.width - dimensions.width - edge), Math.max(edge, Number(position?.x) || edge)),
    y: Math.min(Math.max(edge, viewport.height - dimensions.height - edge), Math.max(edge, Number(position?.y) || edge)),
  }
}
