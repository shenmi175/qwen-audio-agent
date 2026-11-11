import assert from 'node:assert/strict'
import test from 'node:test'
import { GraphitiMemoryProvider } from '../src/memory/providers/graphiti/provider.mjs'
import { shareMemoryProvider } from '../src/memory/shared-provider.mjs'
test('graph provider shares owner while exposing settings only through list', async () => {
  const calls=[]
  const provider=new GraphitiMemoryProvider({config:{personalOwnerId:'owner'},
    userStore:{list:()=>[{id:'u',scope:'user',content:'use concise Chinese'}]},
    request:async(path,body)=>{
      calls.push({path,body})
      if(path==='/memory/query') return {status:'hit',facts:[{id:'random',fact:'synthetic',sources:[{id:'source'}]}],trace_id:'trace',read_version:2}
      if(path==='/memory/observe') return {id:'job',version:3,status:'queued'}
      if(path==='/memory/task') return {id:'job',status:'succeeded',result:{action:'remember'}}
      return {provider:'graphiti',pending_tasks:0}
    }})
  const shared=shareMemoryProvider(provider,'owner')
  assert.equal(shared.list('device-a')[0].scope,'user')
  const found=await shared.query('device-b','paraphrase')
  assert.equal(found.facts[0].id,'random')
  assert.equal(calls.find(c=>c.path==='/memory/query').body.owner_id,'owner')
  await shared.observe('device-b',{text:'new statement'},{sessionId:'s',turnId:'e'})
  assert.equal(calls.find(c=>c.path==='/memory/observe').body.owner_id,'owner')
  // History/session-close replay cannot reintroduce forgotten facts.
  assert.equal((await shared.observe('device-b',{messages:[{role:'user',content:'old'}]},{source:'session-close',batchId:'batch'})).observed,true)
  shared.close()
})
