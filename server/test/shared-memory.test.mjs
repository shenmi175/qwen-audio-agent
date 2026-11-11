import assert from 'node:assert/strict'
import test from 'node:test'
import { FrontendMemoryRuntime } from '../src/memory/runtime.mjs'
import { shareMemoryProvider } from '../src/memory/shared-provider.mjs'

test('shared memory maps all callers to one store and serializes their writes', async () => {
  const calls = []
  let active = 0, maxActive = 0
  const provider = {
    describe: () => ({ protocolVersion: 2, key: 'test', label: 'Test memory' }),
    list: ownerId => { calls.push(ownerId); return [{ scope: 'memory', content: '# Memory' }] },
    apply: async ownerId => {
      calls.push(ownerId)
      active++
      maxActive = Math.max(maxActive, active)
      await new Promise(resolve => setTimeout(resolve, 5))
      active--
      return { changed: 1, documents: [{ scope: 'memory', content: '# Memory' }] }
    },
  }
  const runtime = new FrontendMemoryRuntime({ provider: shareMemoryProvider(provider, 'user_personal') })
  assert.equal(runtime.health().scope, 'shared')
  assert.equal(runtime.sharesOwner('user_guest_one', 'user_guest_two'), true)
  runtime.list('user_guest_one')
  await Promise.all([runtime.apply('user_guest_one', [{}]), runtime.apply('user_guest_two', [{}])])
  assert.equal(maxActive, 1)
  assert.deepEqual(calls, ['user_personal', 'user_personal', 'user_personal'])
})

test('default memory retains separate owners and optional provider capabilities', () => {
  const calls = []
  const provider = {
    describe: () => ({ protocolVersion: 2, key: 'test', label: 'Test memory' }),
    list: ownerId => { calls.push(ownerId); return [] },
    apply: () => ({ changed: 0, documents: [] }),
  }
  const runtime = new FrontendMemoryRuntime({ provider })
  assert.equal(runtime.health().scope, undefined)
  assert.equal(runtime.sharesOwner('user_one', 'user_two'), false)
  runtime.list('user_one')
  runtime.list('user_two')
  assert.deepEqual(calls, ['user_one', 'user_two'])
})
