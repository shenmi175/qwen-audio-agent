import { config } from '../../core/config.mjs'
import {
  listDashScopeRealtimeModelProfiles,
} from '../../../../shared/realtime-provider-catalog.mjs'
import { dashscopeProvider } from './dashscope.mjs'
import { gptLiveProvider } from './gpt-live.mjs'
import { googleLiveProvider } from './google-live.mjs'
import { doubaoSeeduplexProvider } from './doubao-seeduplex.mjs'
import { s2sProvider } from './s2s.mjs'
import { miniCpmOProvider } from './minicpm-o.mjs'
import { stepfunProvider } from './stepfun.mjs'
import { createRealtimeProviderRegistry } from './provider-registry.mjs'

export {
  createRealtimeProviderRegistry,
  RealtimeProviderRegistry,
  validateRealtimeProtocol,
  validateRealtimeProvider,
} from './provider-registry.mjs'

export const defaultRealtimeProviderRegistry = createRealtimeProviderRegistry({
  providers: [
    dashscopeProvider,
    stepfunProvider,
    gptLiveProvider,
    googleLiveProvider,
    doubaoSeeduplexProvider,
    s2sProvider,
    miniCpmOProvider,
  ],
})

export function resolveRealtimeProvider(requested) {
  return defaultRealtimeProviderRegistry.resolve(
    requested || config.audioProvider,
  )
}

function publicModelCatalog(provider) {
  return provider.modelCatalog?.()
    ?? (provider.key === 'dashscope'
      ? listDashScopeRealtimeModelProfiles(config.realtimeModelCatalogs)
      : null)
}

function providerDescriptor(provider) {
  const catalog = publicModelCatalog(provider)
  return {
    key: provider.key,
    label: provider.label,
    model: provider.model(),
    realtimeModelIds: catalog?.map(profile => profile.id) ?? null,
    realtimeModelCatalog: (catalog ?? []).map(({
      id, label, api, family, sessionDefaults, modelCapabilities, transportCapabilities, sessionConstraints,
    }) => ({ id, label, api, family, sessionDefaults, modelCapabilities, transportCapabilities, sessionConstraints })),
    inputSampleRate: provider.inputSampleRate,
    configured: provider.isConfigured(),
  }
}

export function listRealtimeProviders({
  registry = defaultRealtimeProviderRegistry,
  includeGatewayOnly = false,
} = {}) {
  return registry.list({ includeGatewayOnly, configuredOnly: true })
    .map(providerDescriptor)
}

export function describeActiveRealtime(requested, {
  registry = defaultRealtimeProviderRegistry,
} = {}) {
  const provider = registry.resolve(requested || config.audioProvider)
  const modelProfile = provider.modelProfile?.() || null
  return {
    provider: provider.key,
    label: provider.label,
    model: provider.model(),
    modelProfile,
    modelCapabilities: modelProfile?.modelCapabilities || null,
    transportCapabilities: modelProfile?.transportCapabilities || null,
    modelCatalog: publicModelCatalog(provider) ?? [],
    voice: provider.voice(),
    inputSampleRate: provider.inputSampleRate,
    configured: provider.isConfigured(),
    configurationSignature: provider.configurationSignature?.()
      || (provider.key === config.audioProvider ? config.realtimeConfigSignature : null),
    providers: listRealtimeProviders({ registry }),
  }
}

/**
 * Compatibility snapshot for callers that import the built-in providers.
 * Runtime extensions belong in a RealtimeProviderRegistry instance instead.
 */
export const REALTIME_PROVIDERS = Object.freeze({
  dashscope: dashscopeProvider,
  stepfun: stepfunProvider,
  'gpt-live': gptLiveProvider,
  openai: gptLiveProvider,
  gptlive: gptLiveProvider,
  'gpt-realtime': gptLiveProvider,
  'google-live': googleLiveProvider,
  google: googleLiveProvider,
  'gemini-live': googleLiveProvider,
  'doubao-seeduplex': doubaoSeeduplexProvider,
  doubao: doubaoSeeduplexProvider,
  seeduplex: doubaoSeeduplexProvider,
  volcengine: doubaoSeeduplexProvider,
  'speech-to-speech': s2sProvider,
  qwen: dashscopeProvider,
  s2s: s2sProvider,
  'minicpm-o': miniCpmOProvider,
  minicpmo: miniCpmOProvider,
})
