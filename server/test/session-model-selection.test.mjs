
import assert from 'node:assert/strict'
import test from 'node:test'
import { createDashscopeProvider } from '../src/voice/providers/dashscope.mjs'
import { createRealtimeFrontend } from '../src/voice/realtime-provider.mjs'
import { createGatewaySessionHello, gatewayHelloAsLegacyConnect } from '../../shared/protocol/gateway-client-protocol.mjs'
import { diagnosticsPublicStatus } from '../../components/diagnostics/lifecycle.mjs'
function provider() {
  return createDashscopeProvider({ model: 'qwen-audio-3.1-realtime-plus', voice: 'custom-voice',
    endpoint: 'wss://example.test/realtime', credential: 'test-secret', configured: true })
}
test('model selection keeps providers independent, preserving account but selecting compatible voice', () => {
  const original = provider()
  for (const model of ['qwen-audio-3.1-realtime-flash', 'qwen3.5-omni-flash-realtime']) {
    const selected = original.withModel(model)
    assert.equal(selected.model(), model)
    assert.equal(selected.voice(), selected.modelProfile().sessionDefaults.voice)
    assert.equal(new URL(selected.url()).searchParams.get('model'), model)
    assert.deepEqual(selected.headers(), original.headers())
    assert.equal(JSON.stringify(selected.modelCatalog()).includes('test-secret'), false)
  }
  assert.equal(original.model(), 'qwen-audio-3.1-realtime-plus')
  assert.equal(original.voice(), 'custom-voice')
  assert.equal(original.withModel(original.model()), original)
  assert.throws(() => original.withModel('unknown'), /不支持所选模型/)
})
test('frontend chooses requested model before making any paid connection', () => {
  const original = provider()
  const frontend = createRealtimeFrontend({ provider: original, sessionOptions: { model: 'qwen-audio-3.1-realtime-flash' } })
  assert.equal(frontend.provider.model(), 'qwen-audio-3.1-realtime-flash')
  assert.equal(frontend.ws, null)
  assert.equal(original.model(), 'qwen-audio-3.1-realtime-plus')
  assert.throws(() => createRealtimeFrontend({ provider: original, sessionOptions: { model: 'unknown' } }), /不支持所选模型/)
  assert.throws(() => createRealtimeFrontend({ provider: { model: () => 'fixed' }, sessionOptions: { model: 'other' } }), /不支持会话级/)
})
test('model override survives protocol negotiation, with transport bounds checked', () => {
  const hello = createGatewaySessionHello({ connection: { model: 'qwen-audio-3.1-realtime-flash' } })
  assert.equal(gatewayHelloAsLegacyConnect(hello).model, 'qwen-audio-3.1-realtime-flash')
  assert.equal(gatewayHelloAsLegacyConnect(createGatewaySessionHello()).model, undefined)
  assert.throws(() => createGatewaySessionHello({ connection: { model: 'x'.repeat(201) } }))
})
test('public diagnostics status never exposes exporter credentials or unsafe links', () => {
  const status = diagnosticsPublicStatus({
    QWEN_AUDIO_DIAGNOSTICS_PROVIDER: 'otlp', QWEN_AUDIO_DIAGNOSTICS_LABEL: 'Langfuse',
    QWEN_AUDIO_DIAGNOSTICS_UI_URL: 'https://console.example.test/path?token=secret#fragment',
    OTEL_EXPORTER_OTLP_TRACES_HEADERS: 'Authorization=secret',
  })
  assert.equal(status.url, 'https://console.example.test/path')
  assert.equal(JSON.stringify(status).includes('secret'), false)
  assert.equal(status.coverage.realtime, false)
  for (const url of ['javascript:alert(1)', 'https://user:password@example.test', 'broken']) {
    assert.equal(diagnosticsPublicStatus({ QWEN_AUDIO_DIAGNOSTICS_UI_URL: url }).url, null)
  }
})
