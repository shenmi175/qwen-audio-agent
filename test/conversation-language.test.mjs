import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeConversationLanguage, openAITranscriptionSettings } from '../shared/conversation-language.mjs'
import { buildFrontendContext } from '../server/src/conversation/frontend-agent-context.mjs'
import { createGatewaySessionHello, gatewayHelloAsLegacyConnect } from '../shared/protocol/gateway-client-protocol.mjs'

test('spoken language is independent of browser locale and preserves code switching', () => {
  assert.equal(normalizeConversationLanguage('unknown'), 'zh')
  assert.match(buildFrontendContext({ client: { locale: 'en-US' } }), /默认用中文/)
  assert.match(buildFrontendContext({ client: { conversationLanguage: 'en' } }), /Use English by default/)
  assert.match(buildFrontendContext({ client: { conversationLanguage: 'auto' } }), /跟随用户/)
  assert.deepEqual(openAITranscriptionSettings('zh').languages, ['zh', 'en'])
  assert.equal(openAITranscriptionSettings('auto').languages, undefined)
})

test('conversation language survives the gateway hello and legacy connect bridge', () => {
  for (const language of ['zh', 'en', 'auto']) {
    const hello = createGatewaySessionHello({ client: { type: 'web', label: 'WebUI', instance_id: 'language-test' },
      capabilities: [], connection: { conversation_language: language } })
    assert.equal(gatewayHelloAsLegacyConnect(hello).conversationLanguage, language)
  }
})
