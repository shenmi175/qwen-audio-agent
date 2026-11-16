import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('local prompts refresh without network and preserve a valid pair on failed edits', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'local-prompts-'))
  const previousDirectory = process.env.QWAUDIO_PROMPTS_DIR
  process.env.QWAUDIO_PROMPTS_DIR = dir
  const m = await import('../src/conversation/frontend-agent-context.mjs')
  const original = globalThis.fetch
  globalThis.fetch = () => { throw new Error('Unexpected network dependency') }
  let events = 0
  const off = m.subscribeFrontendPrompts(() => events++)
  const write = (key, value) => writeFileSync(join(dir, 'frontend', key + '.md'), value)
  try {
    assert.throws(() => m.loadFrontendPrompt(), /LOCAL_PROMPT_UNAVAILABLE/)
    await assert.rejects(m.initializeFrontendPrompt(), /LOCAL_PROMPT_UNAVAILABLE/)
    mkdirSync(join(dir, 'frontend'))
    write('assistant-behavior', 'behavior one')
    write('assistant-persona', 'persona one')
    const status = await m.initializeFrontendPrompt()
    assert.equal(status.source, 'local')
    assert.equal(m.loadFrontendPrompt(), 'behavior one')
    assert.equal(m.loadAssistantProfile(), 'persona one')
    assert.equal(events, 1)
    await m.initializeFrontendPrompt()
    assert.equal(events, 1)
    write('assistant-behavior', 'behavior two')
    write('assistant-persona', '')
    await assert.rejects(m.initializeFrontendPrompt(), /LOCAL_PROMPT_INVALID/)
    assert.equal(m.loadFrontendPrompt(), 'behavior one')
    assert.equal(m.loadAssistantProfile(), 'persona one')
    assert.equal(events, 1)
    write('assistant-persona', 'persona two')
    await m.initializeFrontendPrompt()
    assert.equal(m.loadFrontendPrompt(), 'behavior two')
    assert.equal(m.loadAssistantProfile(), 'persona two')
    assert.equal(m.frontendPromptStatus().lastError, null)
    assert.notDeepEqual(m.frontendPromptStatus().versions, status.versions)
    assert.equal(events, 2)
  } finally {
    off()
    globalThis.fetch = original
    if (previousDirectory === undefined) delete process.env.QWAUDIO_PROMPTS_DIR
    else process.env.QWAUDIO_PROMPTS_DIR = previousDirectory
    rmSync(dir, { recursive: true, force: true })
  }
})
