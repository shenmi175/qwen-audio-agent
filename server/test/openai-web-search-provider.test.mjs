import test from 'node:test'
import assert from 'node:assert/strict'
import { OpenAIWebSearchProvider } from '../src/frontend/retrieval/providers/openai.mjs'
import { FrontendRetrievalRuntime } from '../src/frontend/retrieval/frontend-retrieval-runtime.mjs'

const answer = () => ({ status: 'completed', output: [
  { type: 'web_search_call', status: 'completed' },
  { type: 'message', content: [{ type: 'output_text', text: '来自官方的回答。', annotations: [
    { type: 'url_citation', title: '官方资料', url: 'https://example.com/docs' },
  ] }] },
] })
test('official search requires real search completion and citations, and keeps key server-side', async () => {
  let body
  const provider = new OpenAIWebSearchProvider({ apiKey: 'test-only', fetchImpl: async (url, request) => {
    assert.equal(url, 'https://api.openai.com/v1/responses')
    assert.equal(request.headers.Authorization, 'Bearer test-only')
    body = JSON.parse(request.body)
    return Response.json(answer())
  } })
  const result = await provider.search('官方资料')
  assert.equal(body.store, false)
  assert.equal(body.tool_choice, 'required')
  assert.deepEqual(body.tools, [{ type: 'web_search', external_web_access: true }])
  assert.equal(result.results[0].url, 'https://example.com/docs')
  assert.equal(JSON.stringify(provider.describe()).includes('test-only'), false)
  for (const [data, code] of [
    [{ ...answer(), status: 'incomplete' }, 'search_not_completed'],
    [{ ...answer(), output: answer().output.slice(1) }, 'search_not_completed'],
    [{ ...answer(), output: [answer().output[0]] }, 'search_citations_missing'],
  ]) {
    provider.fetchImpl = async () => Response.json(data)
    await assert.rejects(provider.search('query'), { code })
  }
})
test('OpenAI failures use bounded codes without leaking upstream payloads', async () => {
  for (const [status, code] of [[401, 'search_auth_failed'], [429, 'search_rate_limited'], [500, 'search_request_failed']]) {
    const provider = new OpenAIWebSearchProvider({ apiKey: 'secret', fetchImpl: async () => new Response('private upstream details', { status }) })
    await assert.rejects(provider.search('query'), error => error.code === code && !error.message.includes('private'))
  }
})
test('simultaneous model families route independently and GPT never falls back', async () => {
  const called = []
  const make = key => ({ describe: () => ({ key, label: key }), isConfigured: () => true,
    search: async () => { called.push(key); return { results: [] } } })
  const openai = make('openai')
  const runtime = new FrontendRetrievalRuntime({ searchProvider: make('bing'), searchProviders: { 'gpt-live': openai } })
  const gpt = runtime.forProvider(() => 'gpt-live')
  const qwen = runtime.forProvider(() => 'dashscope')
  await Promise.all([gpt.search('gpt'), qwen.search('qwen')])
  assert.deepEqual(called.sort(), ['bing', 'openai'])
  openai.search = async () => { throw new Error('failure') }
  await assert.rejects(gpt.search('fail'), /failure/)
  assert.equal(called.length, 2)
  openai.isConfigured = () => false
  assert.equal(gpt.capabilities().includes('web-search'), false)
  assert.equal(qwen.capabilities().includes('web-search'), true)
})
