import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPromptStore } from '../src/prompts/store.mjs'

test('prompt writes persist atomically, reject stale edits and preserve other roles', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'prompt-store-'))
  try {
    const store = createPromptStore(directory)
    const before = await store.read('persona')
    const behavior = await store.read('behavior')
    const results = await Promise.allSettled([
      store.save('persona', '新的性格', before.version),
      store.save('persona', '过时的修改', before.version),
    ])
    assert.equal(results[0].status, 'fulfilled')
    assert.equal(results[1].reason.code, 'PROMPT_CONFLICT')
    assert.equal(await readFile(join(directory, 'frontend/assistant-persona.md'), 'utf8'), '新的性格')
    assert.equal((await store.read('behavior')).version, behavior.version)
    await assert.rejects(store.save('persona', ' ', results[0].value.version), { code: 'PROMPT_INVALID' })
    await assert.rejects(store.read('../config.env'), { code: 'PROMPT_NOT_FOUND' })
    await assert.rejects(store.save('persona', '字'.repeat(30000), results[0].value.version), { code: 'PROMPT_INVALID' })
    assert.equal((await store.list()).length, 7)
  } finally { await rm(directory, { recursive: true, force: true }) }
})
