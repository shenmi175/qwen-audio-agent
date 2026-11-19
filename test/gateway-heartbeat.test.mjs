import test from 'node:test'
import assert from 'node:assert/strict'
import { createGatewayHeartbeat } from '../shared/gateway/heartbeat.mjs'

test('disk-full heartbeat stays alive, retries and reports recovery once', () => {
  let diskFull = true
  let attempts = 0
  const errors = []
  let recovered = 0
  const tick = createGatewayHeartbeat({ update() {
    attempts++
    if (diskFull) throw Object.assign(new Error('private filesystem path'), { code: 'ENOSPC' })
    return true
  } }, { onError: e => errors.push(e), onRecovered: () => recovered++ })
  assert.equal(tick(), false)
  assert.equal(tick(), false)
  assert.deepEqual(errors, [{ code: 'ENOSPC' }])
  diskFull = false
  assert.equal(tick(), true)
  assert.equal(tick(), true)
  assert.equal(recovered, 1)
  assert.equal(attempts, 4)
  diskFull = true
  assert.equal(tick(), false)
  assert.equal(errors.length, 2)
})

test('released or replaced lease is not reported as a successful heartbeat', () => {
  const tick = createGatewayHeartbeat({ update: () => false })
  assert.equal(tick(), false)
})
