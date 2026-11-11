import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryBatchObserver } from '../src/memory/batch-observer.mjs'
import { ConversationSync } from '../src/conversation/conversation-sync.mjs'
import { frontendTools, buildFrontendInstructions } from '../src/frontend/frontend-tools.mjs'
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
