import { test } from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,readFileSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

test('prompt mode switches labels, persists, refreshes and retains mode on failure', async () => {
 const dir=mkdtempSync(join(tmpdir(),'prompt-mode-'))
 process.env.QWAUDIO_PROMPT_MODE_FILE=join(dir,'mode.json')
 const m=await import('../src/conversation/frontend-agent-context.mjs')
 const original=globalThis.fetch
 let fail=false,version=1,events=0
 const labels=[]
 globalThis.fetch=async url=>{labels.push(new URL(url).searchParams.get('label'));return {ok:!fail,status:503,json:async()=>({type:'text',version,prompt:'test'})}}
 const off=m.subscribeFrontendPrompts(()=>events++)
 try {
  await m.initializeFrontendPrompt();assert.equal(m.frontendPromptStatus().mode,'production')
  await m.setFrontendPromptMode('debug');assert.equal(m.frontendPromptStatus().label,'latest')
  assert.equal(JSON.parse(readFileSync(process.env.QWAUDIO_PROMPT_MODE_FILE)).mode,'debug')
  const count=events;await m.initializeFrontendPrompt();assert.equal(events,count)
  version=2;await m.initializeFrontendPrompt();assert.equal(events,count+1)
  fail=true;await assert.rejects(m.setFrontendPromptMode('production'));assert.equal(m.frontendPromptStatus().mode,'debug')
  fail=false;await m.setFrontendPromptMode('production');assert.equal(m.frontendPromptStatus().label,'production')
  await assert.rejects(m.setFrontendPromptMode('bad'),/INVALID/)
  assert.ok(labels.includes('latest'));assert.ok(labels.includes('production'))
 } finally {off();globalThis.fetch=original;delete process.env.QWAUDIO_PROMPT_MODE_FILE;rmSync(dir,{recursive:true,force:true})}
})
