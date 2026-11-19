import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { WebSocketServer } from 'ws'
import { config } from '../src/core/config.mjs'
import { initializeFrontendPrompt } from '../src/conversation/frontend-agent-context.mjs'
import { describeActiveRealtime } from '../src/voice/providers/registry.mjs'
import { providerRuntimeConfiguration } from '../src/voice/providers/runtime-configuration.mjs'
import { createRealtimeFrontend } from '../src/voice/realtime-provider.mjs'

function setConfig(t, updates) {
  const previous = Object.fromEntries(Object.keys(updates).map(key => [key, config[key]]))
  Object.assign(config, updates)
  t.after(() => Object.assign(config, previous))
}

test('independent Qwen and GPT profiles connect with their own settings in the same Gateway', { timeout: 5000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'realtime-profile-prompts-'))
  mkdirSync(join(directory, 'frontend'))
  for (const name of ['assistant-behavior', 'assistant-persona']) {
    writeFileSync(join(directory, 'frontend', name + '.md'), 'Synthetic realtime profile test prompt.')
  }
  const oldPromptDirectory = process.env.QWAUDIO_PROMPTS_DIR
  process.env.QWAUDIO_PROMPTS_DIR = directory
  t.after(() => {
    if (oldPromptDirectory === undefined) delete process.env.QWAUDIO_PROMPTS_DIR
    else process.env.QWAUDIO_PROMPTS_DIR = oldPromptDirectory
    rmSync(directory, { recursive: true, force: true })
  })
  await initializeFrontendPrompt()

  const upstream = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await once(upstream, 'listening')
  t.after(async () => {
    for (const socket of upstream.clients) socket.terminate()
    await new Promise(resolve => upstream.close(resolve))
  })
  const origin = 'ws://127.0.0.1:' + upstream.address().port
  const realtimeProviderProfiles = {
    dashscope: {
      provider: 'dashscope', model: 'qwen-audio-3.1-realtime-plus', endpoint: origin + '/qwen',
      credential: 'test-qwen-key', configured: true, voice: 'qwen-voice', signature: 'qwen-signature',
    },
    'gpt-live': {
      provider: 'gpt-live', model: 'gpt-realtime-2.1', endpoint: origin + '/gpt',
      credential: 'test-gpt-key', configured: true, voice: 'marin', signature: 'gpt-signature',
    },
  }
  setConfig(t, { audioProvider: 'dashscope', realtimeCredential: 'legacy-key', realtimeProviderProfiles })

  const received = new Map()
  upstream.on('connection', (socket, request) => {
    const url = new URL(request.url, origin)
    socket.send(JSON.stringify({ type: 'session.created' }))
    socket.once('message', bytes => {
      received.set(url.pathname, {
        credential: request.headers.authorization,
        model: url.searchParams.get('model'),
        session: JSON.parse(bytes).session,
      })
      socket.send(JSON.stringify({ type: 'session.updated' }))
    })
  })

  const dashscope = createRealtimeFrontend({
    providerName: 'dashscope', sessionOptions: { model: 'qwen-audio-3.1-realtime-flash' },
  })
  const openai = createRealtimeFrontend({ providerName: 'openai' })
  await Promise.all([dashscope.connect(), openai.connect()])
  assert.equal(received.get('/qwen').credential, 'Bearer test-qwen-key')
  assert.equal(received.get('/qwen').model, 'qwen-audio-3.1-realtime-flash')
  assert.notEqual(received.get('/qwen').session.voice, 'marin')
  assert.equal(received.get('/gpt').credential, 'Bearer test-gpt-key')
  assert.equal(received.get('/gpt').model, 'gpt-realtime-2.1')
  assert.equal(received.get('/gpt').session.audio.output.voice, 'marin')
  assert.equal(received.get('/gpt').session.audio.input.transcription.model, 'gpt-transcribe')

  const active = describeActiveRealtime('openai')
  assert.equal(active.configurationSignature, 'gpt-signature')
  assert.deepEqual(active.providers.map(({ key, inputSampleRate }) => [key, inputSampleRate]), [
    ['dashscope', 16000], ['gpt-live', 24000],
  ])
  assert.equal(active.providers[1].realtimeModelCatalog[0].id, 'gpt-realtime-2.1')
  assert.doesNotMatch(JSON.stringify(active), /test-qwen-key|test-gpt-key|legacy-key|ws:\/\//)
  dashscope.close()
  openai.close()
})

test('an unconfigured GPT profile never borrows Qwen connection settings', t => {
  setConfig(t, {
    audioProvider: 'dashscope', realtimeCredential: 'legacy-qwen-key',
    realtimeProviderProfiles: {
      'gpt-live': { model: 'gpt-realtime-2.1', endpoint: 'wss://gpt.invalid/realtime', credential: '', configured: false },
    },
  })
  const openai = providerRuntimeConfiguration('gpt-live')
  assert.equal(openai.credential, '')
  assert.equal(openai.configured, false)
  assert.deepEqual(describeActiveRealtime('dashscope').providers.map(({ key }) => key), ['dashscope'])
})

test('OpenAI history and tool receipt IDs respect its length limit', () => {
  const frontend = createRealtimeFrontend({ providerName: 'openai' })
  for (const type of ['message', 'function_call', 'function_call_output']) {
    const first = frontend.protocol.conversationItemId({ type })
    const second = frontend.protocol.conversationItemId({ type })
    assert.ok(first.length <= 32)
    assert.notEqual(first, second)
    assert.match(first, type === 'function_call_output' ? /^fco_/ : type === 'message' ? /^msg_/ : /^fc_/)
  }
})

test('OpenAI finalized items acknowledge tool results through the shared protocol', () => {
  const frontend = createRealtimeFrontend({ providerName: 'openai' })
  const item = { id: 'fco_receipt', type: 'function_call_output', call_id: 'call_test', output: '{}' }
  assert.deepEqual(frontend.protocol.normalizeIncoming({ type: 'conversation.item.done', item }),
    { type: 'conversation.item.created', item })
  assert.equal(frontend.protocol.normalizeIncoming({ type: 'conversation.item.added', item }).type,
    'conversation.item.added')
})
