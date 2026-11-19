import assert from 'node:assert/strict'
import test, { before, after } from 'node:test'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryBatchObserver } from '../src/memory/batch-observer.mjs'
import { ConversationSync } from '../src/conversation/conversation-sync.mjs'
import { frontendTools, buildFrontendInstructions } from '../src/frontend/frontend-tools.mjs'
import { ToolCallHandler } from '../src/frontend/tools/tool-call-handler.mjs'
import { TurnTranscripts } from '../src/frontend/tools/turn-transcripts.mjs'
import { GraphitiMemoryProvider } from '../src/memory/providers/graphiti/provider.mjs'
import { FrontendMemoryRuntime } from '../src/memory/runtime.mjs'
import { initializeFrontendPrompt } from '../src/conversation/frontend-agent-context.mjs'
import { dashscopeProvider } from '../src/voice/providers/dashscope.mjs'
import { gptLiveProvider } from '../src/voice/providers/gpt-live.mjs'
const promptDirectory = mkdtempSync(join(tmpdir(), 'batch-prompts-'))
const previousPromptDirectory = process.env.QWAUDIO_PROMPTS_DIR
before(async () => {
 process.env.QWAUDIO_PROMPTS_DIR = promptDirectory
 mkdirSync(join(promptDirectory, 'frontend'))
 for (const name of ['assistant-behavior', 'assistant-persona']) {
  writeFileSync(join(promptDirectory, 'frontend', name + '.md'), 'Synthetic conversation policy.')
 }
 await initializeFrontendPrompt()
})
after(() => {
 if (previousPromptDirectory === undefined) delete process.env.QWAUDIO_PROMPTS_DIR
 else process.env.QWAUDIO_PROMPTS_DIR = previousPromptDirectory
 rmSync(promptDirectory, {recursive:true, force:true})
})
test('connection-close batching ignores elapsed time, preserves roles, retries identical ID and survives restart', async () => {
 const dir=mkdtempSync(join(tmpdir(),'memory-batch-')); let now=0, fail=true; const calls=[]
 const conversationSync=new ConversationSync()
 const memoryService={observe:async(o,e,c)=>{calls.push({o,e,c});if(fail)throw Error('offline');return {observed:true,id:'q'}}}
 const opts={path:join(dir,'outbox.sqlite3'),conversationSync,memoryService,now:()=>now}
 let batch=new MemoryBatchObserver(opts)
 const c={ownerId:'u',sessionId:'s'}
 conversationSync.record({...c,id:'1',role:'user',content:'synthetic personal fact'})
 now=20000;conversationSync.record({...c,id:'2',role:'assistant',content:'synthetic context'})
 now=3100000;await batch.tick();assert.equal(calls.length,0)
 await batch.close();assert.equal(calls.length,1)
 batch=new MemoryBatchObserver(opts); fail=false;await batch.tick()
 assert.equal(calls[0].c.batchId,calls[1].c.batchId)
 assert.deepEqual(calls[1].e.messages.map(m=>m.role),['user','assistant'])
 conversationSync.record({...c,id:'1',role:'user',content:'synthetic personal fact'})
 assert.equal(batch.health().pending_messages,0)
 await batch.close();rmSync(dir,{recursive:true})
})
test('a slow background submission does not hold the conversation record hook', async()=>{
 const dir=mkdtempSync(join(tmpdir(),'memory-slow-'));const hold=Promise.withResolvers()
 const sync=new ConversationSync();const batch=new MemoryBatchObserver({path:join(dir,'q'),conversationSync:sync,memoryService:{observe:()=>hold.promise}})
 const c={ownerId:'u',sessionId:'s'}
 sync.record({...c,id:'1',role:'user',content:'first'})
 batch.onSessionClosed(c)
 sync.record({...c,id:'2',role:'user',content:'conversation continues'})
 assert.equal(sync.list(c).length,2)
 hold.resolve({observed:true});await new Promise(r=>setImmediate(r))
 await batch.close();rmSync(dir,{recursive:true})
})
test('background memory exposes only read and omits mandatory write instructions',()=>{
 const context={frontend:{backgroundMemory:true,capabilities:['memory']}}
 const tool=frontendTools(context).find(t=>t.function.name==='memory')
 assert.ok(tool);assert.deepEqual(tool.function.parameters.properties.action.enum,['read'])
 assert.doesNotMatch(buildFrontendInstructions(context),/必须调用 `memory`/)
})

test('Qwen and OpenAI offer the same Graphiti recall tool and use the same memory transport', async t => {
 const requests = []
 const memoryService = new FrontendMemoryRuntime({
  provider: new GraphitiMemoryProvider({
   userStore: { list: () => [] },
   request: async (path, body) => {
    if (path === '/memory/status') return { pending_tasks: 0 }
    assert.equal(path, '/memory/query')
    requests.push(body)
    return { status: 'hit', facts: [{ id: 'fact-1', fact: 'synthetic memory' }], read_version: 7 }
   },
  }),
 })
 t.after(() => memoryService.close())
 const context = { frontend: { backgroundMemory: true, capabilities: ['memory'] } }
 const expected = frontendTools(context).find(tool => tool.function.name === 'memory').function

 for (const provider of [dashscopeProvider, gptLiveProvider]) {
  const { tools } = provider.buildSession({ configured: false, agentContext: context })
  const tool = tools.find(item => (item.function ?? item).name === 'memory')
  assert.ok(tool, provider.key)
  const { name, description, parameters } = tool.function ?? tool
  assert.deepEqual({ name, description, parameters }, expected)
  assert.deepEqual(parameters.properties.action.enum, ['read'])

  const outputs = []
  const transcripts = new TurnTranscripts()
  transcripts.record('turn', '我这周想做什么？')
  const handler = new ToolCallHandler({
   ownerId: 'owner', sessionId: 'conversation', memoryService, transcripts,
   getTurnId: () => 'turn', getTurnGeneration: () => 1,
   getFrontend: () => ({
    sendFunctionOutput: async (id, result) => outputs.push(provider.protocol.functionOutputItem(id, result)),
   }),
  })
  const event = provider.protocol.normalizeIncoming({
   type: 'response.function_call_arguments.done',
   call_id: 'call-1', name, arguments: JSON.stringify({ action: 'read', query: '这周的计划' }),
  })
  await handler.handle(event, { turnId: 'turn', turnGeneration: 1 })
  assert.equal(outputs.length, 1)
  assert.equal(outputs[0].call_id, 'call-1')
  const result = JSON.parse(outputs[0].output)
  assert.equal(result.status, 'ok')
  assert.deepEqual(result.facts.map(fact => fact.id), ['fact-1'])
 }

 const query = { owner_id: 'owner', query: '这周的计划', session_id: 'conversation' }
 assert.deepEqual(requests, [query, query])
})

test('closing freezes messages before a concurrent reconnect records new input', async()=>{
 const dir=mkdtempSync(join(tmpdir(),'memory-segment-'));const hold=Promise.withResolvers()
 const sync=new ConversationSync();const calls=[]
 const batch=new MemoryBatchObserver({path:join(dir,'q'),conversationSync:sync,
  memoryService:{observe:async(o,e,c)=>{calls.push({e,c});await hold.promise;return {observed:true}}}})
 const c={ownerId:'u',sessionId:'s'}
 sync.record({...c,id:'old',role:'user',content:'first connection'})
 batch.onSessionClosed(c)
 sync.record({...c,id:'new',role:'user',content:'new connection'})
 hold.resolve();await new Promise(r=>setImmediate(r))
 assert.deepEqual(calls[0].e.messages.map(m=>m.id),['old'])
 assert.equal(batch.health().pending_messages,1)
 batch.onSessionClosed(c);await new Promise(r=>setImmediate(r))
 assert.deepEqual(calls[1].e.messages.map(m=>m.id),['new'])
 assert.notEqual(calls[0].c.batchId,calls[1].c.batchId)
 await batch.close();rmSync(dir,{recursive:true})
})

test('recovery preserves each batch family and its position across switches and retry', async t => {
 const dir = mkdtempSync(join(tmpdir(), 'memory-family-'))
 t.after(() => rmSync(dir, { recursive: true, force: true }))
 const sync = new ConversationSync()
 const calls = []
 let offline = true
 const opts = { path: join(dir, 'outbox'), conversationSync: sync, memoryService: {
  async observe(_owner, { messages }, context) {
   calls.push({ ids: messages.map(message => message.id), ...context })
   if (offline) throw Object.assign(new Error(), { code: 'GRAPHITI_REMOTE_UNAVAILABLE' })
   return { observed: true }
  },
 } }
 let observer = new MemoryBatchObserver(opts)
 const record = (id, role, memoryModelFamily) => sync.record({
  ownerId: 'owner', sessionId: 'shared-session', id, role, content: `example ${id}`, memoryModelFamily,
 })
 record('qwen-1', 'user', 'qwen')
 record('gpt-1', 'user', 'openai')
 record('gpt-2', 'assistant', 'openai')
 record('gpt-2', 'assistant', 'qwen')
 record('qwen-2', 'user', 'qwen')
 record('legacy', 'user', 'other-provider')
 assert.equal(observer.health().pending_messages, 5)
 await observer.close()

 observer = new MemoryBatchObserver(opts)
 offline = false
 await observer.tick()
 assert.deepEqual(calls.map(({ ids, modelFamily }) => [modelFamily, ids]), [
  ['qwen', ['qwen-1']], ['qwen', ['qwen-1']], ['openai', ['gpt-1', 'gpt-2']], ['qwen', ['qwen-2']], [undefined, ['legacy']],
 ])
 assert.equal(calls[0].batchId, calls[1].batchId)
 assert.equal(observer.health().pending_batches, 0)
 await observer.close()
})

test('an unsupported family waits without reordering writes for the same Graphiti owner', async t => {
 const dir = mkdtempSync(join(tmpdir(), 'memory-family-wait-'))
 t.after(() => rmSync(dir, { recursive: true, force: true }))
 const sync = new ConversationSync()
 const calls = []
 let openaiAvailable = false
 const observer = new MemoryBatchObserver({ path: join(dir, 'outbox'), conversationSync: sync, memoryService: {
  sharesOwner(left, right) { return left[0] === right[0] },
  async observe(owner, _exchange, { modelFamily }) {
   calls.push([owner, modelFamily])
   if (!openaiAvailable && modelFamily === 'openai') {
    throw Object.assign(new Error(), { code: 'GRAPHITI_MODEL_FAMILY_UNSUPPORTED' })
   }
   return { observed: true }
  },
 } })
 const record = (ownerId, memoryModelFamily) => sync.record({
  ownerId, sessionId: ownerId, id: ownerId, role: 'user', content: ownerId, memoryModelFamily,
 })
 for (const [owner, family] of [['user-1', 'openai'], ['user-2', 'qwen'], ['other', 'qwen']]) {
  record(owner, family)
  observer.seal({ owner, session: owner })
 }
 await observer.tick()
 assert.deepEqual(calls, [['user-1', 'openai'], ['other', 'qwen']])
 assert.equal(observer.health().error_code, 'GRAPHITI_MODEL_FAMILY_UNSUPPORTED')
 assert.equal(observer.health().pending_batches, 2)
 openaiAvailable = true
 await observer.tick()
 assert.deepEqual(calls.slice(2), [['user-1', 'openai'], ['user-2', 'qwen']])
 assert.equal(observer.health().error_code, undefined)
 assert.equal(observer.health().pending_batches, 0)
 await observer.close()
})
