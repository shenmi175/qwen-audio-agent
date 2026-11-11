import assert from 'node:assert/strict'
import test from 'node:test'
import { memoryCapability } from '../src/web-ui/memory-capability.mjs'

test('active Graphiti observation does not appear disabled when legacy extraction is off', () => {
  const value = memoryCapability({
    learning: { provider:'graphiti', automaticExtraction:false, providerObservation:true },
    graphiti: { status:'ready', enabled:true, memoryIntegration:true },
  })
  assert.equal(value.graphitiLabel,'已接管长期记忆')
  assert.equal(value.automatic,true)
  assert.equal(value.mode,'per-turn')
})
test('running component alone does not imply that Graphiti owns memory', () => {
  const value = memoryCapability({
    learning: { provider:'markdown', automaticExtraction:true },
    graphiti: { status:'ready', enabled:true, memoryIntegration:false },
  })
  assert.equal(value.integrated,false)
  assert.equal(value.graphitiLabel,'已启动，尚未接管记忆')
  assert.equal(value.mode,'session-close')
})
test('an unavailable selected component never claims to have taken over', () => {
  const value = memoryCapability({ learning:{provider:'graphiti',providerObservation:true},
    graphiti:{status:'unavailable',enabled:true,memoryIntegration:false} })
  assert.equal(value.integrated,false)
  assert.equal(value.graphitiLabel,'未就绪')
})
test('health capabilities remain sufficient until the dedicated status request completes', () => {
  const value = memoryCapability({ memory:{provider:{key:'graphiti',capabilities:{sessionObservation:true}}},
    graphiti:{status:'ready',enabled:true,memoryIntegration:true} })
  assert.equal(value.automatic,true)
  assert.equal(value.graphitiLabel,'已接管长期记忆')
  assert.equal(value.mode,'per-turn')
})
