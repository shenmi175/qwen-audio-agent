import {
  displayModelInput,
  displayModelOutput,
} from '../../components/diagnostics/chat-format.mjs'
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
  for (let i = 0; i < 2100; i++) observation('queue-bound').end()
  assert.ok(diagnosticsHealth().dropped > before)
  assert.ok(diagnosticsHealth().pending <= 2048)
  await flushDiagnostics()
})

test('supplier errors before generation remain searchable as errors', async () => {
  const d = new RealtimeDiagnostics({ sessionId: 'error-test' }, 'test-model')
  d.wire('receive', { type: 'error', error: { code: 'authentication_failed' } })
  await flushDiagnostics()
  const error = spans.find(
    (s) =>
      s.attributes['langfuse.observation.status_message'] ===
      'MODEL_PROVIDER_ERROR',
  )
  assert.ok(error)
  assert.equal(error.status.code, 2)
})

test('sessions show chat messages while connection events remain outside the conversation', async () => {
  const d = new RealtimeDiagnostics(
    { sessionId: 'chat-format-test', userId: 'test-user' },
    'test-model',
  )
  d.event({ type: 'voice.state', state: 'connecting' })
  d.wire('send', {
    type: 'session.update',
    session: { instructions: 'test instructions' },
  })
  d.event({
    type: 'input.message',
    parts: [{ type: 'text', text: '你好，测试问题' }],
  })
  d.event({ type: 'turn.started', turnId: 'chat-turn' })
  d.event({
    type: 'transcript.final',
    role: 'user',
    content: '你好，测试问题',
    turnId: 'chat-turn',
  })
  d.wire('receive', {
    type: 'response.created',
    response: { id: 'chat-response' },
  })
  d.event({
    type: 'transcript.final',
    role: 'assistant',
    content: '这是测试回答',
    turnId: 'chat-turn',
  })
  d.wire('receive', {
    type: 'response.done',
    response: {
      id: 'chat-response',
      status: 'completed',
      output: [
        { type: 'message', content: [{ type: 'text', text: '这是测试回答' }] },
      ],
      usage: { input_tokens: 4, output_tokens: 5 },
    },
  })
  await flushDiagnostics()
  const turn = spans.find(
    (s) =>
      s.name === 'qwaudio.turn' &&
      s.attributes['session.id'] === 'chat-format-test',
  )
  assert.ok(
    turn,
    'completed turn exports without waiting for the next turn or disconnect',
  )
  assert.deepEqual(JSON.parse(turn.attributes['langfuse.observation.input']), [
    { role: 'user', content: '你好，测试问题' },
  ])
  assert.deepEqual(JSON.parse(turn.attributes['langfuse.observation.output']), [
    { role: 'assistant', content: '这是测试回答' },
  ])
  d.close()
  await flushDiagnostics()
  const records = spans.filter(
    (s) =>
      s.attributes['langfuse.observation.metadata.sessionId'] ===
      JSON.stringify('chat-format-test'),
  )
  assert.equal(
    records.filter((s) => !s.parentSpanContext && s.attributes['session.id'])
      .length,
    1,
  )
  assert.equal(
    records.find((s) => s.name === 'qwaudio.connection').attributes[
      'session.id'
    ],
    undefined,
  )
  assert.equal(
    records.find((s) => s.name === 'qwaudio.voice.state').attributes[
      'session.id'
    ],
    undefined,
  )
})

test('late transcripts cannot overwrite another turn and repeated start events do not split a turn', async () => {
  const d = new RealtimeDiagnostics(
    { sessionId: 'late-transcript-test' },
    'test-model',
  )
  d.event({ type: 'input.message', parts: [{ type: 'text', text: '第一问' }] })
  d.event({ type: 'turn.started', turnId: 'one' })
  const first = d.turn
  d.event({ type: 'turn.started', turnId: 'one' })
  assert.equal(d.turn, first)
  d.event({
    type: 'transcript.final',
    role: 'user',
    content: '第二问',
    turnId: 'two',
  })
  d.event({ type: 'turn.started', turnId: 'two' })
  d.event({
    type: 'transcript.final',
    role: 'assistant',
    content: '迟到的上一轮回答',
    turnId: 'one',
  })
  d.event({
    type: 'transcript.final',
    role: 'assistant',
    content: '第二轮回答',
    turnId: 'two',
  })
  d.close()
  await flushDiagnostics()
  const turns = spans.filter(
    (s) =>
      s.name === 'qwaudio.turn' &&
      s.attributes['session.id'] === 'late-transcript-test',
  )
  assert.equal(turns.length, 2)
  assert.deepEqual(
    JSON.parse(turns[0].attributes['langfuse.observation.input']),
    [{ role: 'user', content: '第一问' }],
  )
  assert.deepEqual(
    JSON.parse(turns[1].attributes['langfuse.observation.input']),
    [{ role: 'user', content: '第二问' }],
  )
  assert.deepEqual(
    JSON.parse(turns[1].attributes['langfuse.observation.output']),
    [{ role: 'assistant', content: '第二轮回答' }],
  )
})

test('native generation display retains tool calls while raw wire envelopes remain separate', () => {
  const events = [
    {
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: '问题' }],
      },
    },
    {
      type: 'provider.response.output',
      output: [
        {
          type: 'function_call',
          call_id: 'call-1',
          name: 'web_search',
          arguments: '{}',
        },
      ],
    },
    {
      type: 'conversation.item.create',
      item: {
        type: 'function_call_output',
        call_id: 'call-1',
        output: '搜索结果',
      },
    },
  ]
  const input = displayModelInput(
    { session: { instructions: '系统配置' } },
    events,
  )
  assert.deepEqual(
    input.messages.map((m) => m.role),
    ['system', 'user', 'assistant', 'tool'],
  )
  assert.equal(input.messages[2].tool_calls[0].id, 'call-1')
  assert.equal(input.messages[3].tool_call_id, 'call-1')
  assert.deepEqual(
    displayModelOutput({
      response: {
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'audio', transcript: '回答' }],
          },
        ],
      },
    }),
    [{ role: 'assistant', content: '回答' }],
  )
})

test('voice transcription arriving after generation start populates the native chat input', async () => {
  const d = new RealtimeDiagnostics(
    { sessionId: 'late-voice-test' },
    'test-model',
  )
  d.event({ type: 'turn.started', turnId: 'voice-turn' })
  d.wire('receive', {
    type: 'response.created',
    response: { id: 'voice-response' },
  })
  d.event({
    type: 'transcript.final',
    role: 'user',
    content: '语音转写的问题',
    turnId: 'voice-turn',
  })
  d.wire('receive', {
    type: 'response.done',
    response: {
      id: 'voice-response',
      status: 'completed',
      output: [
        {
          type: 'message',
          content: [{ type: 'audio', transcript: '语音回答' }],
        },
      ],
    },
  })
  d.close()
  await flushDiagnostics()
  const generation = spans.find(
    (s) =>
      s.name === 'qwaudio.model.generate' &&
      s.attributes['session.id'] === 'late-voice-test',
  )
  assert.ok(
    JSON.parse(
      generation.attributes['langfuse.observation.input'],
    ).messages.some((m) => m.content === '语音转写的问题'),
  )
})
