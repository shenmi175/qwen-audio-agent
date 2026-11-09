import assert from 'node:assert/strict'
import test from 'node:test'
import { webConnectionIndicator } from '../src/web-ui/connection-status.js'

test('manual disconnection clears the red indicator even if an old provider error remains', () => {
  assert.equal(webConnectionIndicator({ enabled: false, connectionState: 'unavailable', error: true }), 'disconnected')
})

test('the light becomes green only after the provider confirms the connection', () => {
  for (const connectionState of ['connecting', 'ready', 'disconnected']) {
    assert.equal(webConnectionIndicator({ enabled: true, connectionState }), 'disconnected')
  }
  assert.equal(webConnectionIndicator({ enabled: true, connectionState: 'connected' }), 'connected')
  assert.equal(webConnectionIndicator({ enabled: true, connectionState: 'unavailable' }), 'error')
  assert.equal(webConnectionIndicator({ enabled: true, connectionState: 'connected', error: true }), 'error')
})
