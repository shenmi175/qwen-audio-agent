import { estimateUsageCost } from '../../components/diagnostics/pricing.mjs'
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  initializeDiagnostics,
  observation,
  sanitize,
  RealtimeDiagnostics,
  flushDiagnostics,
  diagnosticCarrier,
  diagnosticsHealth,
} from '../../components/diagnostics/node.mjs'
const spans = []
let failExport = false
initializeDiagnostics({
  environment: { QWEN_AUDIO_DIAGNOSTICS_PROVIDER: 'otlp' },
  exporter: {
    export(batch, cb) {
      spans.push(...batch)
      cb({ code: failExport ? 1 : 0 })
    },
    shutdown: async () => {},
  },
})
test('real SDK records parent-child, trace carrier and supplier usage without media', async () => {
  const diagnostic = new RealtimeDiagnostics(
    { sessionId: 'offline-diagnostics', userId: 'test-owner' },
    'test-model',
  )
  diagnostic.event({ type: 'turn.started', turnId: 'turn-1' })
  diagnostic.wire('send', {
    type: 'session.update',
    session: {
      instructions: 'test instructions',
      tools: [{ name: 'test_tool' }],
    },
  })
  diagnostic.wire('receive', {
    type: 'response.created',
    response: { id: 'response-1' },
  })
  diagnostic.wire('receive', {
    type: 'response.audio.delta',
    response_id: 'response-1',
    delta: 'AAAA',
  })
  const tool = observation('tool.test', {
    parent: diagnostic.turn,
    metadata: { callId: 'call-1' },
  })
  const carrier = tool.run(() => diagnosticCarrier())
  assert.match(carrier.traceparent, /^00-/)
  tool.end({ output: { result: 'test result' } })
  diagnostic.wire('receive', {
    type: 'response.done',
    response: {
      id: 'response-1',
      status: 'completed',
      output: [{ text: 'test answer' }],
      usage: { input_tokens: 12, output_tokens: 3 },
    },
  })
  diagnostic.close()
  await flushDiagnostics()
  const generation = spans.find((s) => s.name === 'qwaudio.model.generate')
  assert.equal(
    JSON.parse(generation.attributes['langfuse.observation.usage_details'])
      .input,
    12,
  )
  assert.equal(
    generation.spanContext().traceId,
    spans.find((s) => s.name === 'qwaudio.tool.test').spanContext().traceId,
  )
  assert.equal(
    spans.some((s) => JSON.stringify(s.attributes).includes('AAAA')),
    false,
  )
  assert.equal(diagnosticsHealth().errorCode, null)
})
test('redaction removes secrets and every audio payload, preserving useful text', () => {
  assert.deepEqual(
    sanitize({ audio: 'AAAA', authorization: 'secret', text: 'useful text' }),
    {
      audio: { omitted: 'media', encodedLength: 4 },
      authorization: '[REDACTED]',
      text: 'useful text',
    },
  )
  assert.equal(
    sanitize({ url: 'data:image/png;base64,AAAA' }).url,
    '[MEDIA OMITTED]',
  )
})

test('export failures leave business return values unchanged and report failure', async () => {
  failExport = true
  const result = observation('failure-test').run(() => 42)
  observation('export-failure').end({ output: 'synthetic error test' })
  await flushDiagnostics()
  assert.equal(result, 42)
  assert.equal(diagnosticsHealth().errorCode, 'DIAGNOSTICS_EXPORT_FAILED')
  failExport = false
})

test('pricing avoids charging accompanying text twice and refuses unknown cached rates', () => {
  const usage = {
    input_tokens_details: { text_tokens: 100, audio_tokens: 0 },
    output_tokens_details: { text_tokens: 20, audio_tokens: 10 },
  }
  assert.equal(
    estimateUsageCost('qwen-audio-3.1-realtime-plus', 'beijing', usage)
      .estimatedCostCny,
    0.002,
  )
  usage.input_tokens_details.cached_tokens = 1
  assert.equal(
    estimateUsageCost('qwen-audio-3.1-realtime-plus', 'beijing', usage)
      .costStatus,
    'unknown',
  )
  assert.equal(
    estimateUsageCost('unverified', 'beijing', usage).costStatus,
    'unknown',
  )
})

test('bounded exporter drops excess diagnostics without blocking callers', async () => {
  const before = diagnosticsHealth().dropped
  for (let i=0;i<2100;i++) observation('queue-bound').end()
  assert.ok(diagnosticsHealth().dropped > before)
  assert.ok(diagnosticsHealth().pending <= 2048)
  await flushDiagnostics()
})
