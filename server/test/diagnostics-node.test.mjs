import test from 'node:test'
import assert from 'node:assert/strict'
import { observation, initializeDiagnostics, diagnosticsHealth, diagnosticCarrier, RealtimeDiagnostics, sanitize } from '../../components/diagnostics/node.mjs'
test('removed exporters cannot be activated and compatibility calls preserve business results', () => {
 let calls = 0
 initializeDiagnostics({ environment: { QWEN_AUDIO_DIAGNOSTICS_PROVIDER: 'otlp' }, exporter: { export() { calls++ } } })
 assert.equal(observation('test').run(() => 42), 42)
 assert.throws(() => observation('test').run(() => { throw new Error('business') }), /business/)
 const d = new RealtimeDiagnostics()
 for (let n = 0; n < 1000; n++) { d.wire('send', {type:'session.update', session:{instructions:'synthetic'}});d.event({type:'turn.started'}) }
 d.close()
 assert.equal(calls, 0)
 assert.equal(diagnosticsHealth().enabled, false)
 assert.deepEqual(diagnosticCarrier(), {})
 assert.equal(Object.keys(d).length, 0)
 assert.equal(sanitize({password:'secret'}).password, '[REDACTED]')
})
