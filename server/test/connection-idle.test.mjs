import assert from 'node:assert/strict'
import test from 'node:test'
import { createConnectionIdleController } from '../src/voice/connection-idle.mjs'

function harness(t, { timeoutMs = 30_000 } = {}) {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let busy = false
  let disconnected = 0
  const idle = createConnectionIdleController({ timeoutMs,
    isBusy: () => busy, disconnect: () => { disconnected++ } })
  t.after(() => idle.close())
  return { idle, elapsed: ms => t.mock.timers.tick(ms),
    busy: value => { busy = value }, count: () => disconnected }
}

test('idle timeout closes exactly once and never reconnects itself', t => {
  const h = harness(t)
  h.idle.connected()
  h.elapsed(29_999)
  assert.equal(h.count(), 0)
  h.elapsed(1)
  assert.equal(h.count(), 1)
  h.idle.activity()
  h.elapsed(60_000)
  assert.equal(h.count(), 1)
})

test('conversation activity restarts the complete idle interval', t => {
  const h = harness(t)
  h.idle.connected()
  h.elapsed(20_000)
  h.idle.activity()
  h.elapsed(29_999)
  assert.equal(h.count(), 0)
  h.elapsed(1)
  assert.equal(h.count(), 1)
})

test('ongoing response or playback is protected; completion starts a fresh interval', t => {
  const h = harness(t)
  h.idle.connected()
  h.busy(true)
  h.elapsed(60_000)
  assert.equal(h.count(), 0)
  h.busy(false)
  h.idle.activity()
  h.elapsed(29_999)
  assert.equal(h.count(), 0)
  h.elapsed(1)
  assert.equal(h.count(), 1)
})

test('manual closure cancels the timer and an explicit reconnect rearms it', t => {
  const h = harness(t)
  h.idle.connected()
  h.elapsed(10_000)
  h.idle.disconnected()
  h.elapsed(60_000)
  assert.equal(h.count(), 0)
  h.idle.connected()
  h.elapsed(30_000)
  assert.equal(h.count(), 1)
})

test('zero timeout preserves the original persistent connection behavior', t => {
  const h = harness(t, { timeoutMs: 0 })
  h.idle.connected()
  h.elapsed(86_400_000)
  assert.equal(h.count(), 0)
})
