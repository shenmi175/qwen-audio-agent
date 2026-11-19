import assert from 'node:assert/strict'
import test from 'node:test'
import { connectionErrorMessage } from '../src/realtime/connection-error.js'

test('a TLS error survives the subsequent unavailable event without a message', () => {
  const cause = connectionErrorMessage('Client network socket disconnected before secure TLS connection was established')
  assert.equal(cause, '连接语音服务的网络中断，正在重试')
  assert.equal(connectionErrorMessage(undefined, cause, '语音前台连接异常，正在重试'), cause)
})

test('authentication and model errors are not mislabeled as network retries', () => {
  for (const message of ['Unexpected server response: 401', 'model_not_found']) {
    assert.equal(connectionErrorMessage(message, 'previous network error'), message)
  }
  assert.equal(connectionErrorMessage('', '', 'unavailable'), 'unavailable')
})
