import assert from 'node:assert/strict'
import test from 'node:test'
import { FrontendMemoryRuntime } from '../src/memory/runtime.mjs'
import { memoryToolHandlers } from '../src/memory/tools.mjs'
import { TurnTranscripts } from '../src/frontend/tools/turn-transcripts.mjs'

function harness(result = { status: 'hit', facts: [{ id: 'fact-random', fact: 'a generated personal fact', sources: [{ id: 'source-random' }] }], trace_id: 'trace', read_version: 7 }) {
  const queries = [], outputs = [], writes = [], responseOptions = []
  const memoryService = new FrontendMemoryRuntime({ provider: {
    describe: () => ({ protocolVersion: 2, key: 'graphiti', label: 'Graphiti', capabilities: { semanticQuery: true } }),
    list: () => [{ id: 'settings', scope: 'user', content: 'concise answers' }],
    query: async (owner, query) => { queries.push({ owner, query }); return { memories: [], context: JSON.stringify(result), ...result } },
    apply: async (...args) => { writes.push(args); return { changed: 0, documents: [] } },
  } })
  const transcripts = new TurnTranscripts({ waitMs: 1 })
  const runtime = { ownerId: 'owner', sessionId: 'clean-session', memoryService, transcripts,
    beginDeferredToolResponse: () => null, completeDeferredToolResponse: async () => {},
    sendOutput: async (_id, output, _turn, _task, options) => {
      outputs.push(output)
      responseOptions.push(options)
    },
  }
  return { queries, outputs, writes, responseOptions, transcripts, read: async (args = {}, turnId = 'current') => {
    await memoryToolHandlers(runtime).memory({ callId: 'read', turnId, args: { action: 'read', ...args }, event: {}, callContext: {} })
    return outputs.at(-1)
  } }
}

test('semantic memory read without query uses this turn transcript and counts graph facts', async () => {
  const kit = harness()
  kit.transcripts.record('old', 'an unrelated old question')
  kit.transcripts.record('current', 'a differently worded question about my personal facts')
  const output = await kit.read({ document: 'memory' })
  assert.deepEqual(kit.queries, [{ owner: 'owner', query: 'a differently worded question about my personal facts' }])
  assert.equal(output.status, 'ok'); assert.equal(output.count, 1)
  assert.equal(output.facts[0].id, 'fact-random'); assert.equal(output.readVersion, 7)
})
test('unscoped legacy read also queries semantic facts, preserving explicit queries', async () => {
  const kit = harness()
  kit.transcripts.record('current', 'current user question')
  await kit.read()
  assert.equal(kit.queries[0].query, 'current user question')
  const output = await kit.read({ query: 'explicit paraphrase' })
  assert.equal(kit.queries[1].query, 'explicit paraphrase'); assert.equal(output.count, 1)
})
test('settings-only read does not falsely establish absent personal facts', async () => {
  const kit = harness()
  const output = await kit.read({ document: 'user' })
  assert.equal(kit.queries.length, 0)
  assert.equal(output.data_scope, 'interaction_settings')
  assert.match(output.instruction, /不.*长期事实.*不存在/)
})
test('semantic read with no current transcript requests a query rather than returning a settings snapshot', async () => {
  const kit = harness()
  const output = await kit.read()
  assert.equal(kit.queries.length, 0)
  assert.equal(output.error_code, 'memory_query_required')
})
test('graph read failures retain their actual error status', async () => {
  const kit = harness({ status: 'timeout', code: 'GRAPHITI_RECALL_TIMEOUT', facts: [], trace_id: 'failed-trace' })
  const output = await kit.read({ query: 'some query' })
  assert.equal(output.status, 'timeout'); assert.equal(output.code, 'GRAPHITI_RECALL_TIMEOUT')
})
test('only an actual empty graph query yields not_found', async () => {
  const kit = harness({ status: 'empty', facts: [], trace_id: 'empty-trace' })
  kit.transcripts.record('current', 'new random topic')
  const output = await kit.read()
  assert.equal(kit.queries.length, 1); assert.equal(output.status, 'not_found'); assert.equal(output.count, 0)
})

test('a stray Graphiti read during a forget or correction returns a tool-free receipt', async () => {
  for (const text of ['请忘掉测试宠物新名这个名字。', '请更正测试宠物新名这条记忆，我养的猫叫测试宠物旧名。']) {
    const kit = harness()
    kit.transcripts.record('current', text)
    const output = await kit.read({ query: '我养的猫的名字' })
    assert.equal(output.status, 'deferred')
    assert.match(output.instruction, /会话结束后处理/)
    assert.equal(kit.responseOptions[0].response.tool_choice, 'none')
    assert.deepEqual(kit.queries, [])
    assert.deepEqual(kit.writes, [])
  }
})

test('Graphiti refuses realtime writes even when the model sends legacy arguments', async () => {
  const kit = harness()
  const output = await kit.read({ action: 'replace', document: 'memory',
    old_text: '我养的猫叫测试宠物新名', new_text: '', fact_id: 'fact-random' })
  assert.equal(output.status, 'deferred')
  assert.deepEqual(kit.queries, [])
  assert.deepEqual(kit.writes, [])
})
