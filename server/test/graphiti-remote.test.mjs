import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { graphitiTransport } from '../../components/graphiti/transport.mjs'
test('remote mode never manages local services and reports auth and connection failures', async () => {
 const dir=mkdtempSync(join(tmpdir(),'remote-graphiti-'))
 const original={...process.env},fetch=globalThis.fetch
 writeFileSync(join(dir,'token'),'synthetic-component-token')
 Object.assign(process.env,{QWEN_AUDIO_GRAPHITI_ENABLED:'on',QWEN_AUDIO_GRAPHITI_MODE:'remote',QWEN_AUDIO_GRAPHITI_URL:'http://127.0.0.1:18310',QWEN_AUDIO_GRAPHITI_TOKEN_FILE:join(dir,'token'),QWEN_AUDIO_GRAPHITI_REMOTE_CONFIG:join(dir,'missing')})
 try {
  const m=await import('../../components/graphiti/lifecycle.mjs')
  globalThis.fetch=async()=>{throw new TypeError('offline')}
  assert.equal((await m.ensureGraphitiComponent()).code,'GRAPHITI_REMOTE_UNAVAILABLE')
  await assert.rejects(m.graphitiComponentRequest('/memory/status',{}),{code:'GRAPHITI_REMOTE_UNAVAILABLE'})
  assert.deepEqual(await m.stopGraphitiComponent(),{stopped:false,managedExternally:true})
  await assert.rejects(m.installGraphitiComponent(),/MANAGED_EXTERNALLY/)
  globalThis.fetch=async(url,init)=>{
   if (url.endsWith('/readyz')) return {ok:true,json:async()=>({component:'qwaudio-graphiti',status:'ready',integrationVersion:6,memoryIntegration:true})}
   assert.equal(init.headers.authorization,'Bearer synthetic-component-token')
   return {ok:false,status:401,json:async()=>({detail:'denied'})}
  }
  assert.equal((await m.ensureGraphitiComponent()).deployment,'remote')
  await assert.rejects(m.graphitiComponentRequest('/memory/status',{}),{code:'GRAPHITI_AUTH_FAILED'})
  assert.throws(()=>graphitiTransport({...process.env,QWEN_AUDIO_GRAPHITI_URL:'http://public.example:8310'}),/INVALID_URL/)
 } finally {
  globalThis.fetch=fetch
  for(const key of Object.keys(process.env)) if(!(key in original)) delete process.env[key]
  Object.assign(process.env,original);rmSync(dir,{recursive:true,force:true})
 }
})
