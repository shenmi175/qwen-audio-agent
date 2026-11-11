import assert from 'node:assert/strict'
import test from 'node:test'
import { FrontendMemoryRuntime } from '../src/memory/runtime.mjs'
import { memoryToolHandlers } from '../src/memory/tools.mjs'
import { TurnTranscripts } from '../src/frontend/tools/turn-transcripts.mjs'

function harness(result = { status: 'hit', facts: [{ id: 'fact-random', fact: 'a generated personal fact', sources: [{ id: 'source-random' }] }], trace_id: 'trace', read_version: 7 }) {
  const queries = [], outputs = []
  const memoryService = new FrontendMemoryRuntime({ provider: {
    describe: () => ({ protocolVersion: 2, key: 'graphiti', label: 'Graphiti', capabilities: { semanticQuery: true } }),
    list: () => [{ id: 'settings', scope: 'user', content: 'concise answers' }],
    query: async (owner, query) => { queries.push({ owner, query }); return { memories: [], context: JSON.stringify(result), ...result } },
    apply: async () => ({ changed: 0, documents: [] }),
  } })
  const transcripts = new TurnTranscripts({ waitMs: 1 })
  const runtime = { ownerId: 'owner', sessionId: 'clean-session', memoryService, transcripts,
    beginDeferredToolResponse: () => null, completeDeferredToolResponse: async () => {},
    sendOutput: async (_id, output) => outputs.push(output) }
  return { queries, outputs, transcripts, read: async (args = {}, turnId = 'current') => {
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
