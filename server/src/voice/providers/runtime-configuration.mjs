import { config } from '../../core/config.mjs'
import { realtimeModelCatalog } from '../../../../shared/realtime-model-catalog.mjs'
import { REALTIME_PROVIDERS } from '../../../../shared/realtime-provider-definitions.mjs'

// Provider-specific profiles take priority. Generic connection settings
// belong exclusively to the configured default provider.
export function providerRuntimeConfiguration(key) {
  const definition = REALTIME_PROVIDERS.find(provider => provider.key === key)
  const active = () => config.audioProvider === key
  const profile = () => config.realtimeProviderProfiles?.[key]
  function setting(field, legacyField, fallback) {
    const own = profile()
    return own ? own[field] : active() ? config[legacyField] : fallback
  }
  return {
    get model() {
      return setting('model', 'realtimeModel', realtimeModelCatalog(key, config.realtimeModelCatalogs)?.defaultModel || null)
    },
    get voice() { return setting('voice', 'realtimeVoice', null) },
    get endpoint() { return setting('endpoint', 'realtimeEndpoint', '') },
    get credential() { return setting('credential', 'realtimeCredential', '') },
    get signature() { return setting('signature', 'realtimeConfigSignature', null) },
    get configured() {
      const own = profile()
      if (own) return own.configured
      return active() && Boolean(definition.requiredConfiguration.field === 'realtimeUrl'
        ? this.endpoint : this.credential)
    },
  }
}
